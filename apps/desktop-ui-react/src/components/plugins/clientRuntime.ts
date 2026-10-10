/**
 * 客户端插件运行时（对标 DSH 的 client plugin）。
 *
 * 信任模型：**全信任、跑在宿主渲染进程**（用户已拍板）。插件模块拿得到 window / DOM /
 * 我们的注册 API，与 DSH 的客户端插件同级 —— 它不是沙箱。
 *
 * 加载链路：
 *   GET /api/plugins/client              → 已启用插件的客户端入口清单（只回路径）
 *   GET /api/plugins/client/source?id=   → 该插件的模块源码
 *   new Blob([source], {type:'text/javascript'}) → URL.createObjectURL → import(blobUrl)
 *
 * 为什么必须走 blob：清单里是插件目录的**绝对路径**，file:// 在渲染进程里拿不到，
 * 而 tauri.conf.json 的 CSP 只允许 `script-src 'self' blob: …` —— 所以源码先取回来、
 * 再造 blob URL 交给 import。**blob: 这一条是这套机制成立的前提，别删。**
 *
 * 热加载：定时拉一次各模块的源码指纹（长度 + 首尾片段，避免整份比较），变了就
 *   ① 调旧实例的 deactivate() ② revoke 旧 blob ③ 重新 import + activate。
 * 注册的东西按 pluginId 记账，重新激活前先回收，避免热更一次多一个入口。
 *
 * 隔离：任何一步失败只影响该插件 —— 记 console.error 并跳过，绝不让一个坏插件把界面带崩。
 */

export interface PluginClientApi {
  /** 插件自己的 id（清单里的 pluginId）。 */
  readonly pluginId: string
  /** 宿主提供的 React（插件因此不必自带依赖；也可以自己打包一份）。 */
  readonly react: typeof import('react')
  /** 命名空间存储：键自动加 `coomi.plugin.<id>.` 前缀，插件之间不串。 */
  readonly storage: {
    get: (key: string) => string | null
    set: (key: string, value: string) => void
    remove: (key: string) => void
  }
  /** 带前缀的日志（出问题时一眼能看出是哪个插件）。 */
  log: (...args: unknown[]) => void
  /** 注册一条命令（进命令面板）。返回注销函数。 */
  registerCommand: (command: { id: string; title: string; run: () => void }) => () => void
  /** 注册一个侧边栏页面入口。返回注销函数。 */
  registerView: (view: { id: string; title: string; icon?: string; order?: number; render: () => unknown }) => () => void
}

export interface PluginClientModule {
  activate?: (api: PluginClientApi) => void | Promise<void>
  deactivate?: () => void | Promise<void>
}

/** 插件注册进宿主的东西：热加载与停用都按 pluginId 回收。 */
export interface PluginContribution {
  pluginId: string
  kind: 'command' | 'view'
  id: string
  title: string
  /** 侧边栏条目用的稳定 key：`client:<pluginId>:<viewId>`，与声明式插件的 `plugin:` 前缀不撞。 */
  key: string
  icon?: string
  order?: number
  /** 视图的渲染函数（返回 React 节点）。命令没有这个字段。 */
  render?: () => unknown
  /** 命令的执行体。视图没有这个字段。 */
  run?: () => void
}

/** 客户端插件注册的视图（侧边栏与路由读它）。 */
export interface PluginClientView {
  key: string
  pluginId: string
  id: string
  title: string
  icon: string
  order: number
  render: () => unknown
}

const contributions: PluginContribution[] = []
const listeners = new Set<() => void>()

/** 订阅注册表变化（侧边栏 / 命令面板将来据此渲染）。 */
export function subscribePluginContributions(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function pluginContributions(): readonly PluginContribution[] {
  return contributions
}
/* useSyncExternalStore 要求 getSnapshot 在「没变」时返回**同一个引用**，
   所以每次变更后重建一份快照数组，而不是让调用方去 filter 原数组（那会每次都是新数组）。 */
/** 客户端插件注册的命令（命令面板读它）。 */
export interface PluginClientCommand {
  pluginId: string
  id: string
  title: string
  run: () => void
}

let viewsSnapshot: PluginClientView[] = []
let commandsSnapshot: PluginClientCommand[] = []
function rebuildSnapshot(): void {
  viewsSnapshot = contributions
    .filter((c) => c.kind === 'view' && typeof c.render === 'function')
    .map((c) => ({
      key: c.key,
      pluginId: c.pluginId,
      id: c.id,
      title: c.title,
      icon: c.icon ?? '',
      order: c.order ?? 0,
      render: c.render as () => unknown,
    }))
  commandsSnapshot = contributions
    .filter((c) => c.kind === 'command' && typeof c.run === 'function')
    .map((c) => ({ pluginId: c.pluginId, id: c.id, title: c.title, run: c.run as () => void }))
}
function emit(): void { rebuildSnapshot(); for (const fn of listeners) fn() }

/** 侧边栏 / 路由用的客户端插件视图（订阅式；插件热加载后自动更新）。 */
export function usePluginClientViews(): readonly PluginClientView[] {
  return useSyncExternalStore(subscribePluginContributions, () => viewsSnapshot)
}

/** 命令面板用的客户端插件命令（订阅式）。 */
export function usePluginClientCommands(): readonly PluginClientCommand[] {
  return useSyncExternalStore(subscribePluginContributions, () => commandsSnapshot)
}

/** 按 key 取一个客户端插件视图。 */
export function findPluginClientView(key: string): PluginClientView | null {
  return viewsSnapshot.find((v) => v.key === key) ?? null
}

interface Loaded {
  pluginId: string
  blobUrl: string
  fingerprint: string
  module: PluginClientModule
}
const loaded = new Map<string, Loaded>()
/** 热加载轮询间隔：3s 足够跟上开发时的保存节奏，又不至于压着引擎打请求。 */
const POLL_MS = 3000
let pollTimer: number | null = null
let started = false

function dropContributions(pluginId: string): void {
  for (let i = contributions.length - 1; i >= 0; i -= 1) {
    if (contributions[i].pluginId === pluginId) contributions.splice(i, 1)
  }
  emit()
}

/** 源码指纹：长度 + 首尾 64 字符。比整份字符串便宜，对「保存了一下」足够灵敏。 */
function fingerprintOf(source: string): string {
  return source.length + ':' + source.slice(0, 64) + ':' + source.slice(-64)
}

/** 走**引擎的 api 助手**而不是裸 fetch：/api/* 在引擎自己的 origin 上，
 *  还带 Bearer 令牌，裸 fetch 相对路径会打到壳的 origin，拿不到东西。 */
function engineApi<T>(path: string): Promise<T> {
  return useEngine.getState().api<T>(path)
}

function makeApi(pluginId: string): PluginClientApi {
  const prefix = 'coomi.plugin.' + pluginId + '.'
  return {
    pluginId,
    react,
    storage: {
      get: (key) => { try { return localStorage.getItem(prefix + key) } catch { return null } },
      set: (key, value) => { try { localStorage.setItem(prefix + key, value) } catch { /* 隐私模式 */ } },
      remove: (key) => { try { localStorage.removeItem(prefix + key) } catch { /* 忽略 */ } },
    },
    log: (...args) => console.log('[plugin:' + pluginId + ']', ...args),
    registerCommand: (command) => {
      contributions.push({
        pluginId,
        kind: 'command',
        id: command.id,
        title: command.title,
        key: 'client:' + pluginId + ':cmd:' + command.id,
        run: command.run,
      })
      emit()
      return () => dropContribution(pluginId, 'command', command.id)
    },
    registerView: (view) => {
      contributions.push({
        pluginId,
        kind: 'view',
        id: view.id,
        title: view.title,
        key: 'client:' + pluginId + ':' + view.id,
        icon: view.icon,
        order: view.order,
        render: view.render,
      })
      emit()
      return () => dropContribution(pluginId, 'view', view.id)
    },
  }
}

function dropContribution(pluginId: string, kind: 'command' | 'view', id: string): void {
  const index = contributions.findIndex((c) => c.pluginId === pluginId && c.kind === kind && c.id === id)
  if (index >= 0) { contributions.splice(index, 1); emit() }
}

/** 停用并卸载一个插件的当前实例（热加载与失败回滚共用）。 */
async function unload(pluginId: string): Promise<void> {
  const current = loaded.get(pluginId)
  if (!current) return
  loaded.delete(pluginId)
  try { await current.module.deactivate?.() } catch (error) {
    console.error('[plugin:' + pluginId + '] deactivate 失败', error)
  }
  URL.revokeObjectURL(current.blobUrl)
  dropContributions(pluginId)
}

async function instantiate(pluginId: string, source: string): Promise<void> {
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    const module = (await import(/* @vite-ignore */ blobUrl)) as PluginClientModule
    loaded.set(pluginId, { pluginId, blobUrl, fingerprint: fingerprintOf(source), module })
    await module.activate?.(makeApi(pluginId))
  } catch (error) {
    /// 插件自己炸了：撤销 blob、如实报错，但不影响其它插件与界面。
    URL.revokeObjectURL(blobUrl)
    throw error
  }
}


/** 一轮热加载检查：新增的装上、消失的卸掉、指纹变了的重新激活。 */
async function pollOnce(): Promise<void> {
  const list = await engineApi<{ clients: Array<{ pluginId: string }> }>('/api/plugins/client')
  const wanted = new Set(list.clients.map((c) => c.pluginId))
  for (const pluginId of [...loaded.keys()]) {
    if (!wanted.has(pluginId)) await unload(pluginId)
  }
  for (const pluginId of wanted) {
    try {
      const data = await engineApi<{ source: string }>(
        '/api/plugins/client/source?id=' + encodeURIComponent(pluginId),
      )
      const current = loaded.get(pluginId)
      if (current && current.fingerprint === fingerprintOf(data.source)) continue
      if (current) await unload(pluginId)
      await instantiate(pluginId, data.source)
      console.log('[plugin:' + pluginId + '] ' + (current ? '已热加载' : '已加载'))
    } catch (error) {
      console.error('[plugin:' + pluginId + '] 装载失败（已跳过）', error)
    }
  }
}

/** 启动运行时：先装一轮，再按 POLL_MS 轮询做热加载。重复调用是幂等的。 */
export async function startPluginClients(): Promise<void> {
  if (started) return
  started = true
  try {
    await pollOnce()
  } catch {
    /* 引擎还没起来 / 老引擎没有这个端点。
       **这里必须回滚 started 并且不启动轮询。**
       以前无论成败都挂上 setInterval，于是引擎启动那几秒里，一个 3 秒的轮询会持续打 API，
       和启动引导抢引擎连接 —— 症状就是卡在「正在准备一个新对话…」，
       要手动点一下「新建对话」才连得上。
       现在失败就干净退出，由 App 在 engine.ready 变 true 时重新调用。 */
    started = false
    return
  }
  // Slow requests must not accumulate overlapping imports/activations. Hidden windows
  // resume their hot-load check when visible; no plugin work is lost.
  let polling = false
  if (pollTimer === null) pollTimer = window.setInterval(() => {
    if (polling || document.hidden || !useEngine.getState().ready) return
    polling = true
    void pollOnce().catch(() => {}).finally(() => { polling = false })
  }, POLL_MS)
}

/// react 走静态 import：插件拿到的就是宿主这一份，不会出现两个 React 实例。
import * as react from 'react'
import { useSyncExternalStore } from 'react'
import { useEngine } from '../../stores/engine'
