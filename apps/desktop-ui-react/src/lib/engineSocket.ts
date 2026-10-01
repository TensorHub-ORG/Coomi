/**
 * 引擎连接的「传输兜底」：直连 WebSocket 打不通时，自动改用壳里的 WS 桥（走 IPC）。
 *
 * 为什么要这一层：界面的连接是 WebView(Chromium) 发的，会被系统代理/PAC、新版 Chromium 的
 * 本地网络访问检查（PNA/LNA）、以及安全软件对 msedgewebview2.exe 的网络拦截挡下；壳自己的
 * 裸 TCP 不受影响（引擎就是它拉起来的）。于是出现「引擎活得好好的、界面一直说连接已断开」，
 * 而且只在部分机器上复现。这里让前端先试直连，失败就换桥，用户无感。
 *
 * 行为：
 *   · 直连优先（老路径不变，能直连的机器零影响）；
 *   · 4 秒没 open、或 open 之前就 error/close → 切换 IPC 桥，并把选择记在 localStorage；
 *   · 记录过的机器下次直接走桥（省掉 4 秒等待），并可通过 clearTransportHint() 复位。
 */
import { ipc } from './ipc'

/** 事件监听：走 withGlobalTauri 注入的 __TAURI__.event（不引 @tauri-apps/api 依赖）。 */
interface TauriEventGlobal {
  event?: {
    listen?: (
      name: string,
      handler: (event: { payload?: unknown }) => void,
    ) => Promise<() => void>
  }
}
type UnlistenFn = () => void

function listenEvent(name: string, handler: (payload: unknown) => void): Promise<UnlistenFn> {
  const api = (window as unknown as { __TAURI__?: TauriEventGlobal }).__TAURI__?.event?.listen
  if (!api) return Promise.resolve(() => { /* 无壳：什么都不做 */ })
  return api(name, (event) => handler(event?.payload))
}

const HINT_KEY = 'coomi.transport.v1'

export type TransportMode = 'direct' | 'ipc'

let mode: TransportMode | null = null
let listenersReady = false
/// 最近一次桥接失败原因（自检文本里会带出来）。
let lastTransportError = ''
/// 监听句柄：进程内只注册一次，需要时可用 releaseTransportListeners() 摘掉。
let unlisten: UnlistenFn[] = []

export function releaseTransportListeners(): void {
  for (const off of unlisten.splice(0)) {
    try { off() } catch { /* 忽略 */ }
  }
  listenersReady = false
}
/** 当前活动的桥接 socket，按会话索引。
 *  壳里的桥已按会话多路复用（每条会话一条 TCP），事件一律带 session 回来，
 *  所以这里必须按会话分发 —— 否则 A 会话的帧会被投到 B 会话上。 */
const sockets = new Map<string, IpcSocket>()

/** 从壳事件里取出 session 并找到对应的 socket。 */
function socketFor(payload: unknown): IpcSocket | null {
  const session = (payload as { session?: unknown } | null)?.session
  return typeof session === 'string' ? (sockets.get(session) ?? null) : null
}

/** 调试口：CDP / 自检可以直接读传输状态（生产里留着也无害）。 */
;(window as unknown as { __transportDebug?: unknown }).__transportDebug = () => {
  const opened = [...sockets.values()].filter((socket) => socket.readyState === 1)
  return {
    mode: currentTransport(),
    active: sockets.size > 0,
    opened: opened.length > 0,
    sockets: sockets.size,
    lastError: lastTransportError,
  }
}

export function currentTransport(): TransportMode {
  if (mode) return mode
  try {
    mode = localStorage.getItem(HINT_KEY) === 'ipc' ? 'ipc' : 'direct'
  } catch {
    mode = 'direct'
  }
  return mode
}

export function clearTransportHint(): void {
  mode = null
  try { localStorage.removeItem(HINT_KEY) } catch { /* 忽略 */ }
}

/** 环境自检：把「哪一段链路通、哪一段不通」写成一段可以直接发人的文本。
 *  排查「引擎活着、界面说断线」这类只在别人机器上出现的问题时，这一段就够了。 */
export async function runTransportSelfCheck(ctx: { port: number; token: string; version: string }): Promise<string> {
  const lines: string[] = []
  lines.push('== Coomi 传输自检 ==')
  lines.push('时间: ' + new Date().toISOString())
  lines.push('应用版本: ' + (ctx.version || '(未知)'))
  lines.push('引擎端口: ' + ctx.port + ' 令牌: ' + (ctx.token ? '有' : '无'))
  lines.push('当前传输: ' + currentTransport())
  if (lastTransportError) lines.push('桥接上次错误: ' + lastTransportError)
  lines.push('页面 origin: ' + location.origin)
  lines.push('UA: ' + navigator.userAgent)
  try {
    const res = await fetch('http://127.0.0.1:' + ctx.port + '/api/runtime/health', {
      headers: { Authorization: 'Bearer ' + ctx.token },
    })
    lines.push('① 直连 fetch: ' + res.status + ' ' + (await res.text()).slice(0, 160))
  } catch (error) {
    lines.push('① 直连 fetch: 失败 → ' + (error instanceof Error ? error.name + ': ' + error.message : String(error)))
  }
  try {
    const reply = await ipc<{ status: number; body: string }>('engine_http', {
      port: ctx.port, token: ctx.token, method: 'GET', path: '/api/runtime/health', body: null,
    })
    lines.push('② 壳内转发: ' + reply.status + ' ' + reply.body.slice(0, 160))
  } catch (error) {
    lines.push('② 壳内转发: 失败 → ' + (error instanceof Error ? error.message : String(error)))
  }
  try {
    const info = await ipc<{ port: number; exe?: string }>('engine_info')
    lines.push('③ 壳记录: 端口=' + info.port + ' 引擎=' + (info.exe || '(未知)'))
  } catch (error) {
    lines.push('③ 壳记录: 取不到 → ' + (error instanceof Error ? error.message : String(error)))
  }
  return lines.join('\n')
}

function remember(mode_: TransportMode): void {
  mode = mode_
  try { localStorage.setItem(HINT_KEY, mode_) } catch { /* 忽略 */ }
}

/** 供 HTTP 兜底复用：一旦发现直连不通，把整条链路都记成桥模式。 */
export function rememberIpcTransport(): void {
  remember('ipc')
}

/// 注册去重：注册还没回来时，后来者复用同一个 Promise，保证并发调用只注册一次。
let listenersPending: Promise<void> | null = null

async function ensureListeners(): Promise<void> {
  if (listenersReady) return
  listenersPending ??= (async () => {
    unlisten = await Promise.all([
      // 事件改成带 session 的对象（壳侧多路复用后必须能区分会话）。
      listenEvent('engine:ws-open', (payload) => { socketFor(payload)?.fireOpen() }),
      listenEvent('engine:ws-message', (payload) => {
        const event = payload as { session?: unknown; data?: unknown } | null
        socketFor(payload)?.fireMessage(String(event?.data ?? ''))
      }),
      listenEvent('engine:ws-closed', (payload) => { socketFor(payload)?.fireClose() }),
    ])
    // 注册成功后才置 true：以前先置 true 再 await，一旦 listen 抛错就永远不再重试，桥再也收不到事件。
    listenersReady = true
  })()
  try {
    await listenersPending
  } finally {
    listenersPending = null
  }
}

/** 与 WebSocket 同形的最小实现：只需要 onopen/onmessage/onerror/onclose/send/close/readyState。 */
class IpcSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  readyState = 0
  private opened = false
  private closed = false
  private queued: string[] = []
  private watchdog: number | null = null

  constructor(private readonly port: number, private readonly token: string, private readonly sessionId: string) {}

  async start(): Promise<void> {
    // 监听注册失败（listen 被 ACL 拒）同样要走 onerror：以前它抛在 try 外面，
    // 桥起不来还查不到原因。
    try {
      await ensureListeners()
      // 按会话登记：同一会话重连时新 socket 直接接管。
      sockets.set(this.sessionId, this)
    } catch (error) {
      console.warn('[transport] ipc bridge failed:', error)
      lastTransportError = error instanceof Error ? error.message : String(error)
      this.failBridge()
      return
    }
    // 命令成功但 3 秒没收到 engine:ws-open（事件丢了/被拦）→ 也算失败，交回上层重连，
    // 免得界面永远停在「已断开」而没有任何线索。
    this.watchdog = window.setTimeout(() => {
      if (!this.opened && !this.closed) {
        lastTransportError = 'bridge opened but no engine:ws-open event'
        console.warn('[transport] ' + lastTransportError)
        this.failBridge()
      }
    }, 3_000)
    try {
      await ipc('engine_ws_open', { port: this.port, token: this.token, session: this.sessionId })
    } catch (error) {
      window.clearTimeout(this.watchdog)
      console.warn('[transport] ipc bridge failed:', error)
      lastTransportError = error instanceof Error ? error.message : String(error)
      this.failBridge()
    }
  }

  fireOpen(): void {
    if (this.closed || this.opened) return
    if (this.watchdog !== null) { window.clearTimeout(this.watchdog); this.watchdog = null }
    this.opened = true
    this.readyState = 1
    this.onopen?.()
    for (const frame of this.queued.splice(0)) void this.deliver(frame)
  }

  fireMessage(data: string): void {
    if (this.closed) return
    this.onmessage?.({ data })
  }

  fireClose(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    // 只摘掉还属于自己的那一条：重连时新 socket 可能已经接管了同一个会话。
    if (sockets.get(this.sessionId) === this) sockets.delete(this.sessionId)
    this.onclose?.()
  }

  /** 启动失败统一收尾：onerror 后紧接 fireClose，closed 标记保证两者各只触发一次。
      以前只调 onerror，调用方不会安排重连，桥起不来就会永久停在「连接已断开」。 */
  private failBridge(): void {
    if (this.closed) return
    this.onerror?.()
    this.fireClose()
  }

  private async deliver(frame: string): Promise<void> {
    try {
      await ipc('engine_ws_send', { frame, session: this.sessionId })
    } catch (error) {
      console.warn('[transport] ipc send failed:', error)
      this.onerror?.()
    }
  }

  send(data: string): void {
    if (this.closed) return
    if (!this.opened) { this.queued.push(data); return }
    void this.deliver(data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    if (sockets.get(this.sessionId) === this) sockets.delete(this.sessionId)
    // 只有真正开过桥（收到过 engine:ws-open）才通知壳关闭：没开过就没必要动壳里的桥。
    if (this.opened) void ipc('engine_ws_close', { session: this.sessionId }).catch(() => { /* 忽略 */ })
  }
}

/**
 * 建一条到引擎的会话连接：先试直连，超时/失败自动换 IPC 桥。
 * 返回的对象与 WebSocket 同形（调用方不需要知道底层是哪条路）。
 */
export function createEngineSocket(options: {
  url: string
  sessionId: string
  port: number
  token: string
  /** 首连强制走桥（自检用）。 */
  forceIpc?: boolean
}): WebSocket {
  const preferIpc = options.forceIpc || currentTransport() === 'ipc'
  const ipc = new IpcSocket(options.port, options.token, options.sessionId)
  const shim = {
    readyState: 0,
    onopen: null as null | (() => void),
    onmessage: null as null | ((event: { data: string }) => void),
    onerror: null as null | (() => void),
    onclose: null as null | (() => void),
    send: (data: string) => ipc.send(data),
    close: () => { ipc.close() },
  }

  // 把桥的事件转给调用方挂上的回调
  ipc.onopen = () => { shim.readyState = 1; shim.onopen?.() }
  ipc.onmessage = (event) => shim.onmessage?.(event)
  ipc.onerror = () => { shim.onerror?.() }
  ipc.onclose = () => { shim.readyState = 3; shim.onclose?.() }

  if (preferIpc) {
    void ipc.start()
    return shim as unknown as WebSocket
  }

  let switched = false
  let real: WebSocket | null = null
  let timer: number | null = null
  let attempt = 0
  /* 调用方主动关闭（切会话 / 断开重连时会先 close 上一个 socket）必须与「真失败」区分开：
     否则一个还在握手中的旧连接被关掉，就会把全局传输标记写成 ipc —— 实测本机就是因为
     这条误判，健康机器也悄悄切到了桥（真实信号被掩盖，还顺带制造过一次误报诊断）。 */
  let userClosed = false
  const useIpc = (why: string): void => {
    if (switched) return
    switched = true
    console.warn('[transport] 直连不可用，切换到壳内桥（' + why + '）')
    remember('ipc')
    try { real?.close() } catch { /* 忽略 */ }
    real = null
    void ipc.start()
  }
  /* 直连尝试：**失败要连试两次、每次给 8 秒**再换桥。
     以前只给 4 秒一次机会 —— 冷启动时引擎还没起来就被判死，健康机器也会被误切到桥，
     用户侧表现为「启动瞬间闪一下连接已断开」。切换必须是**真失败**才发生。 */
  const startDirect = (): void => {
    attempt += 1
    real = new WebSocket(options.url)
    timer = window.setTimeout(() => {
      if (shim.readyState === 1 || switched) return
      if (attempt < 2) {
        try { real?.close() } catch { /* 忽略 */ }
        startDirect()
        return
      }
      useIpc('直连两次都没能在 8 秒内建立')
    }, 8_000)
    real.onopen = () => {
      if (timer !== null) { window.clearTimeout(timer); timer = null }
      shim.readyState = 1
      shim.onopen?.()
    }
    real.onmessage = (event) => shim.onmessage?.({ data: String(event.data) })
    real.onerror = () => {
      if (userClosed || switched) return
      if (shim.readyState === 1) { shim.onerror?.(); return }
      if (attempt < 2) { try { real?.close() } catch { /* 忽略 */ } ; startDirect(); return }
      useIpc('连接报错')
    }
    real.onclose = () => {
      if (switched) return
      // 主动关闭：只把状态收掉，**绝不**因此判定「直连不可用」。
      if (userClosed) { if (shim.readyState === 1) shim.readyState = 3; return }
      if (shim.readyState === 1) { shim.readyState = 3; shim.onclose?.() } else { useIpc('连接被关闭') }
    }
  }
  startDirect()
  shim.send = (data: string) => {
    if (real && real.readyState === WebSocket.OPEN) { real.send(data); return }
    ipc.send(data)
  }
  shim.close = () => {
    userClosed = true
    if (timer !== null) { window.clearTimeout(timer); timer = null }
    try { real?.close() } catch { /* 忽略 */ }
    ipc.close()
  }
  return shim as unknown as WebSocket
}
