/** 引擎连接：壳启动引擎后经 IPC 取 {port, token}；HTTP 走 127.0.0.1，Bearer 鉴权。 */
import { create } from 'zustand'
import { ipc } from '../lib/ipc'
import { clearTransportHint, currentTransport, rememberIpcTransport, runTransportSelfCheck } from '../lib/engineSocket'
// 值没变就别写：用量是一次流式上报里最热的状态，见 lib/stableState.ts。
import { sameJson } from '../lib/stableState'

export interface UsageState {
  total: number
  input: number
  output: number
  contextRatio: number
  contextUsed: number
  contextWindow: number
  cachedInput: number
  cacheHitRate: number | null
  /** 引擎是否明确提供缓存计量：false = 本模型 / 供应商没给缓存字段（界面必须显示「未提供」，
      不能落成 0%）；null = 旧引擎没有这个字段，只能按 cacheHitRate 有没有值来推断。 */
  cacheDataAvailable: boolean | null
  /** 本轮命中率（本轮请求的缓存复用比例）；null = 本轮还没有计量或引擎没提供。 */
  turnCacheHitRate: number | null
  turnCacheDataAvailable: boolean | null
  firstTokenLatencyMs: number | null
  outputTokensPerSecond: number | null
  turnTotal: number | null
}

export type EngineStatus = 'starting' | 'running' | 'stopped' | 'error'

interface EngineState {
  port: number
  token: string
  ready: boolean
  status: EngineStatus
  /** 引擎正在重启 / 自愈：界面据此显示「引擎已重启，正在恢复会话」。 */
  restarting: boolean
  lastError: string
  cwd: string
  home: string
  version: string
  usage: UsageState
  init: () => Promise<void>
  restart: () => Promise<void>
  /** 壳发来 engine:restarted（带新 port / token）时调用：换令牌 + 重新 init。 */
  applyRestart: (port: number, token: string) => Promise<void>
  /** 前端自愈入口：WS 重连用尽 / 探活失败时自动让壳重启引擎（自带冷却与次数上限）。 */
  requestRestart: (reason?: string) => Promise<void>
  /// 轻量刷新端口/令牌（重连前调用）。
  refreshInfo: () => Promise<void>
  stop: () => Promise<void>
  api: <T>(path: string, init?: RequestInit) => Promise<T>
  authHeaders: (extra?: Record<string, string>) => Record<string, string>
  wsUrl: (sessionId: string) => string
  applyUsage: (ev: Record<string, any>) => void
  /** 壳内转发提示（走桥时有值；直连正常时为空）。 */
  bridgeNote: string
  /** 环境自检：返回可直接发人的诊断文本。 */
  selfCheck: () => Promise<string>
  /** 复位传输选择（自检里的「重试直连」）。 */
  resetTransport: () => void
}

const EMPTY_USAGE: UsageState = {
  total: 0, input: 0, output: 0, contextRatio: 0, contextUsed: 0, contextWindow: 0,
  cachedInput: 0, cacheHitRate: null, cacheDataAvailable: null, turnCacheHitRate: null, turnCacheDataAvailable: null,
  firstTokenLatencyMs: null, outputTokensPerSecond: null, turnTotal: null,
}

/* ── 自愈的护栏 ──
   引擎真的起不来时（例如可执行文件被删），无节流地反复重启只会刷屏。
   冷却 15s、连续自愈最多 3 次；手动重启与壳主动重启会把计数清零。 */
const AUTO_RESTART_COOLDOWN_MS = 15_000
const AUTO_RESTART_MAX = 3
let autoRestartCount = 0
/// init 失败后的自动重试定时器（每 3 秒一次，直到引擎就绪）——
/// 冷启动慢（杀软扫描）或引擎刚重启时，没有它就永远停在「与引擎的连接已断开」。
let initRetryTimer: number | null = null
let lastAutoRestartAt = 0
let restartInFlight = false
let refreshInFlight: Promise<void> | null = null
/// 壳内转发提示只提示一次（用户不需要被反复告知）。
let bridgeNoteShown = false

/* ── 引擎请求的硬超时 ──
   真机诊断报告里的关键一行：IPC 通、端口 8023 也拿到了，但界面 `connected:false`、
   连健康检查都没能从直连里返回 —— 那台机器上 `ProxyServer = 127.0.0.1:18081`（装过代理
   工具），WebView 的请求**被挂住：既不返回也不报错**。而 fetch 默认没有超时，
   于是 `init()` 永远停在第一个 await 上，后面的兜底（切壳内转发）根本没机会执行。
   结论：所有引擎请求都必须有硬超时，超时按「网络层失败」处理 → 立刻走壳内转发。 */
const ENGINE_FETCH_TIMEOUT_MS = 4_000
/// 长请求（压缩、导出这类）给更宽的超时；默认 4 秒只够探活与小接口。
const ENGINE_FETCH_SLOW_MS = 60_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(label + ' 超时（' + ms + 'ms）')), ms)
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value) },
      (error) => { window.clearTimeout(timer); reject(error) },
    )
  })
}

/// 慢接口白名单：这些路径的超时放宽（否则大压缩会被 4 秒掐断）。
function timeoutForPath(path: string): number {
  return /\/(clear|branch|workspace|artifacts|compact|export|backup|install|download|mirror-test|reindex|discover-models|discover-context|settings.mcp|mcp.reload)/.test(path)
    ? ENGINE_FETCH_SLOW_MS
    : ENGINE_FETCH_TIMEOUT_MS
}
/// 前端状态上报定时器：壳用它做环境诊断（谁连上了、走的哪条传输）。
let statusTimer: number | null = null

/** 每 10 秒把「界面自己认为的连接状态」报给壳（诊断报告里的关键证据之一）。 */
function startStatusReport(): void {
  if (statusTimer !== null) return
  statusTimer = window.setInterval(() => {
    void import('./session').then(({ useSession }) => {
      const session = useSession.getState()
      const engine = useEngine.getState()
      const status = JSON.stringify({
        connected: session.connected,
        connecting: session.connecting,
        port: engine.port,
        transport: currentTransport(),
        linkError: session.linkError,
        messages: session.messages.length,
        appVersion: engine.version,
        // 下面这几项是「真机那次空会话故障」后补的：
        // 当时报告里有 connected/messages/linkError，却没有 sessionId 与会话数，
        // 只能靠 linkError 为空去反推「连 connect 都没执行」。补上后一眼可见。
        sessionId: session.sessionId ? session.sessionId.slice(0, 8) : '',
        sessions: session.sessions.length,
        runState: session.runState,
        engineReady: engine.ready,
        engineStatus: engine.status,
        engineError: engine.lastError,
      })
      void ipc('frontend_status', { status }).catch(() => { /* 忽略 */ })
    }).catch(() => { /* 忽略 */ })
  }, 10_000)
}

/** HTTP 走了壳内转发时给界面留一句说明（自检面板里也看得到）。 */
function markBridgeNote(): void {
  if (bridgeNoteShown) return
  bridgeNoteShown = true
  useEngine.setState({
    bridgeNote: '本机 WebView 直连引擎被系统拦下，已自动改用壳内转发（功能不受影响）',
  })
}

export const useEngine = create<EngineState>((set, get) => ({
  port: 0,
  token: '',
  bridgeNote: '',
  ready: false,
  status: 'starting',
  restarting: false,
  lastError: '',
  cwd: '',
  home: '',
  version: '',
  usage: EMPTY_USAGE,

  /// 冷启动（首次运行，杀软扫描 15MB 引擎）可能几十秒：这里给到 60s，
  /// 期间界面显示「引擎启动中」，而不是把用户丢进一个报错的空壳。
  init: async () => {
    set({ status: 'starting', lastError: '' })
    /* ── 连接信息的两条来源（本轮的关键修正）──
       ① 壳在页面加载前注入的 window.__COOMI_BOOT__（端口 + 令牌 + 版本）：**不需要任何 IPC**；
       ② 壳命令 engine_info：IPC 通畅时的刷新来源（引擎重启会换端口）。
       以前只有 ②。而真机上出现过 `IPC custom protocol failed: Failed to fetch` —— IPC 被系统
       拦掉时前端拿不到端口，请求会拼成 http://127.0.0.1:0/... ，控制台刷 ERR_UNSAFE_PORT，
       界面永远「与引擎的连接已断开」，可引擎其实好好的。① 让这条链路不再依赖 IPC。 */
    const boot = (window as unknown as { __COOMI_BOOT__?: { port?: number; token?: string; version?: string } }).__COOMI_BOOT__
    if (boot?.port) {
      set((s) => (s.port > 0 ? {} : { port: boot.port as number, token: boot.token ?? '' }))
      if (boot.version) set({ version: boot.version })
    }
    const hasShell = typeof window !== 'undefined' && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__
    // 既没有壳、也没有注入信息（真的在浏览器里打开）：给出可读提示，别盲发 :0 请求。
    if (!hasShell && !boot?.port) {
      set({
        status: 'error',
        ready: false,
        lastError: '当前页面不是 CoomiPlus 应用窗口：请从桌面/开始菜单的 CoomiPlus 图标打开',
      })
      return
    }
    // 向壳报到：壳据此判断「前端到底能不能调用壳命令」——诊断报告里最关键的一条证据。
    // 不 await（拿不到也不影响主流程，壳那边会自行记录）。
    if (hasShell) void ipc('frontend_hello').catch(() => { /* 忽略 */ })
    for (let attempt = 0; attempt < 120; attempt++) {
      // 有壳时才问壳（无壳场景靠注入信息，见上）。
      if (hasShell) {
        try {
          const info = await withTimeout(ipc<{ port: number; token: string }>('engine_info'), ENGINE_FETCH_TIMEOUT_MS, '读取引擎连接信息')
          if (info?.port) set((s) => (s.port === info.port && s.token === info.token ? {} : { port: info.port, token: info.token }))
        } catch (e) {
          set({ lastError: e instanceof Error ? e.message : String(e) })
        }
      }
      if (get().port > 0) {
        try {
          const h = await get().api<{ cwd?: string; home?: string; version?: string }>('/api/runtime/health')
          autoRestartCount = 0
          if (initRetryTimer !== null) { window.clearTimeout(initRetryTimer); initRetryTimer = null }
          set({ ready: true, status: 'running', restarting: false, lastError: '', cwd: h.cwd ?? '', home: h.home ?? '', version: h.version ?? '' })
          startStatusReport()
          return
        } catch { /* 端口已分配但服务还没起来，继续等 */ }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    set((s) => ({ status: 'error', restarting: false, lastError: s.lastError || '引擎未在预期时间内就绪' }))
    // 探活失败**不重启引擎**（忙≠死；真死由壳守护拉起），但要**一直重试连接**：
    // 每 3 秒再来一轮 init，直到引擎就绪为止 —— 否则冷启动稍慢就永远停在「连接已断开」。
    if (initRetryTimer === null) {
      initRetryTimer = window.setTimeout(() => {
        initRetryTimer = null
        void get().init()
      }, 3_000)
    }
  },

  /// 轻量刷新端口/令牌（引擎重启会换端口）：重连前调用，避免一直连旧端口。
  refreshInfo: () => {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = (async () => {
      try {
        const info = await withTimeout(ipc<{ port: number; token: string }>('engine_info'), ENGINE_FETCH_TIMEOUT_MS, '读取引擎连接信息')
        if (!info?.port) return
        const changed = get().port !== info.port || get().token !== info.token
        set({ port: info.port, token: info.token, ...(changed ? { ready: false, restarting: true, status: 'starting' as const } : {}) })
        const health = await get().api<{ cwd?: string; home?: string; version?: string }>('/api/runtime/health')
        if (get().port !== info.port || get().token !== info.token) return
        set({ ready: true, status: 'running', lastError: '', cwd: health.cwd ?? get().cwd, home: health.home ?? get().home, version: health.version ?? get().version })
      } catch (error) {
        // A port allocation alone is not proof that the HTTP service is ready.
        set({ lastError: error instanceof Error ? error.message : String(error) })
      }
    })().finally(() => { refreshInFlight = null })
    return refreshInFlight
  },

  /// 手动重启（设置页 / 引擎异常条的按钮）：不看冷却，计数清零。
  restart: async () => {
    autoRestartCount = 0
    lastAutoRestartAt = 0
    set({ status: 'starting', ready: false, restarting: true, lastError: '' })
    try { await ipc('engine_restart', { source: 'button' }) } catch (e) { set({ lastError: e instanceof Error ? e.message : String(e) }) }
    await get().init()
  },

  /// 壳重启了引擎（engine:restarted）：端口与令牌都变了，旧连接一律作废。
  applyRestart: async (port, token) => {
    autoRestartCount = 0
    lastAutoRestartAt = 0
    set((s) => ({
      // 壳没带端口时保留旧值：init 每轮都会回读 engine_info，拿到新的自然覆盖。
      port: port > 0 ? port : s.port,
      token: token || s.token,
      ready: false,
      status: 'starting',
      restarting: true,
      lastError: '',
    }))
    await get().init()
  },

  /// 自愈入口。冷却期内 / 超过上限时只记错误，不重复拉起进程。
  requestRestart: async (reason) => {
    if (restartInFlight) return
    const now = Date.now()
    if (now - lastAutoRestartAt < AUTO_RESTART_COOLDOWN_MS) return
    if (autoRestartCount >= AUTO_RESTART_MAX) {
      set({ status: 'error', restarting: false, lastError: (reason ? reason + '：' : '') + '引擎多次重启仍未恢复，请在设置页手动重启' })
      return
    }
    restartInFlight = true
    autoRestartCount += 1
    lastAutoRestartAt = now
    set({ status: 'starting', ready: false, restarting: true, lastError: '' })
    try { await ipc('engine_restart', { source: 'auto' }) } catch (e) { set({ lastError: e instanceof Error ? e.message : String(e) }) }
    try { await get().init() } finally { restartInFlight = false }
  },

  stop: async () => {
    try { await ipc('engine_stop') } catch { /* 忽略 */ }
    // 用户主动停：关掉重启态，别让界面一直显示「正在恢复会话」。
    set({ ready: false, status: 'stopped', restarting: false })
  },

  authHeaders: (extra) => ({ Authorization: 'Bearer ' + get().token, ...(extra ?? {}) }),

  /// 环境自检（设置页 / 断线横幅的「复制诊断」用）：逐条测通链路，返回可直接发人的文本。
  selfCheck: async () => runTransportSelfCheck({
    port: get().port,
    token: get().token,
    version: get().version,
  }),

  /// 复位传输选择（自检面板里「重试直连」用）。
  resetTransport: () => {
    clearTransportHint()
    set({ bridgeNote: '' })
  },

  api: async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const port = get().port
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? init.body : undefined
    const parse = (status: number, text: string): T => {
      if (status >= 400) throw new Error('HTTP ' + status + (text ? '：' + text.slice(0, 200) : ''))
      return (text ? JSON.parse(text) : null) as T
    }
    const timeoutMs = timeoutForPath(path)
    const viaBridge = async (): Promise<T> => {
      const reply = await withTimeout(
        ipc<{ status: number; body: string }>('engine_http', {
          port, token: get().token, method, path, body,
        }),
        timeoutMs,
        '壳内转发',
      )
      markBridgeNote()
      return parse(reply.status, reply.body)
    }
    // 已知直连不通的机器：直接走壳内转发（见 lib/engineSocket.ts）。
    if (currentTransport() === 'ipc') return viaBridge()
    // AbortController + 定时器双保险：AbortController 负责真的把请求掐掉，
    // 定时器负责「连 abort 都没生效」（被拦死的 socket 可能连 abort 都唤不醒）。
    // controller 必须建在 try 外：catch 里要用它把超时后仍挂着的请求真正取消掉。
    const controller = new AbortController()
    try {
      const res = await withTimeout(
        fetch('http://127.0.0.1:' + port + path, {
          ...init,
          signal: controller.signal,
          headers: get().authHeaders(init?.headers as Record<string, string> | undefined),
        }),
        timeoutMs,
        '直连 ' + path,
      )
      return parse(res.status, await res.text())
    } catch (error) {
      // withTimeout 只是让前端不再等待；这里补上 true abort，超时后仍挂着的那次 fetch 才会真的被取消，
      // 否则连接一直泄漏。放在取出 message 之前、不改 message，超时仍按网络层失败去换桥。
      controller.abort()
      // 只有**网络层**失败才换桥：HTTP 4xx/5xx 是我们自己抛的，换桥没意义。
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('HTTP ')) throw error
      // 第一次发现直连不通就把整条链路切成壳内转发（并记住），不再每轮都先等一次超时。
      rememberIpcTransport()
      return viaBridge()
    }
  },

  wsUrl: (sessionId) => 'ws://127.0.0.1:' + get().port + '/ws/session/' + sessionId + '?token=' + get().token,

  applyUsage: (ev) => set((s) => {
    const u = (ev.usage ?? {}) as Record<string, any>
    const p = s.usage
    const usage: UsageState = {
      total: u.total_tokens ?? p.total,
      input: u.input_tokens ?? p.input,
      output: u.output_tokens ?? p.output,
      contextRatio: u.context_ratio ?? p.contextRatio,
      contextUsed: u.context_used_tokens ?? p.contextUsed,
      contextWindow: u.context_window_tokens ?? p.contextWindow,
      cachedInput: u.cached_input_tokens ?? p.cachedInput,
      // cache_hit_rate 在供应商没给缓存字段时是 null（不是 0）：显式清空，避免把上一拍的值留在界面上。
      cacheHitRate: u.cache_hit_rate === undefined
        ? p.cacheHitRate
        : (typeof u.cache_hit_rate === 'number' ? u.cache_hit_rate : null),
      // cache_data_available / turn_* 是引擎新加的字段：只有 undefined（旧引擎）时才沿用上一拍，
      // 别把「没有这个字段」当成 false。
      cacheDataAvailable: typeof u.cache_data_available === 'boolean' ? u.cache_data_available : p.cacheDataAvailable,
      turnCacheHitRate: u.turn_cache_hit_rate === undefined
        ? p.turnCacheHitRate
        : (typeof u.turn_cache_hit_rate === 'number' ? u.turn_cache_hit_rate : null),
      turnCacheDataAvailable: typeof u.turn_cache_data_available === 'boolean' ? u.turn_cache_data_available : p.turnCacheDataAvailable,
      firstTokenLatencyMs: u.first_token_latency_ms === undefined ? p.firstTokenLatencyMs : u.first_token_latency_ms,
      outputTokensPerSecond: u.output_tokens_per_second === undefined ? p.outputTokensPerSecond : u.output_tokens_per_second,
      turnTotal: u.turn_total_tokens === undefined ? p.turnTotal : u.turn_total_tokens,
    }
    // 一个数都没变（重复上报 / 只带 event_type 的心跳）：原样返回整份 state，
    // zustand 认到 Object.is 相等会**整条跳过通知** —— 订了 usage 的组件连重渲染都不会有。
    if (sameJson(p, usage)) return s
    return { usage }
  }),
}))
