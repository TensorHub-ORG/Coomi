import { create } from 'zustand'
import { useEngine } from './engine'
import type { RemoteEntry, RemoteSourceKey } from '../components/skills/remoteSources'
import { normalizeRuntimes, runtimeHint, type RuntimeStatus } from '../components/skills/runtimeMeta'
import {
  cancelEngineTask, fetchRuntimeInstallPlan, installRemoteMcp, pollRuntimeInstall, runtimeTaskLabel,
  startRuntimeInstallTask,
  type McpInstallDefinition, type McpInstallResult, type RuntimeInstallPlan, type RuntimeProbe,
} from '../components/skills/installClient'

export interface CatalogEntry {
  id: string
  name?: string
  description?: string
  version?: string
  author?: string
  repository?: string
  enabled?: boolean
  installed?: boolean
}

export interface FileEntry { name: string; path: string; type: 'file' | 'dir'; size: number; modified?: number }

/* ── 装完之后要不要重启 ──
   装运行环境（Node / uv / winget 这类）改的是 PATH，而 PATH 只在进程启动时读一次：
   引擎还是老环境就会「装好了却找不到命令」，只有重启**应用**（引擎跟着重启）才是真的刷新。
   只写 MCP 条目时配置已经热重载，重启**引擎**就够。这里只记「最近一次安装建议重启谁」，
   弹不弹、什么时候弹由 components/skills/RestartPrompt 决定（含「本次不再提示」）。 */
export interface RestartHint {
  /** app = 建议重启应用（PATH 变了）；engine = 重启引擎即可。 */
  target: 'app' | 'engine'
  /** 一句上下文，例如「刚装好 uv」。 */
  label: string
  at: number
}

/* ── 远程 MCP 源 ──
   取数逻辑在 components/skills/remoteSources.ts（六种源的解析各不相同），store 只保存
   每个源各自的结果与状态：切来切去不必重新打网络，也不会把 A 源的结果显示在 B 源下面。 */
export interface RemoteState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  entries: RemoteEntry[]
  error: string
  /** 实际请求的地址（展示与排查用）。 */
  url: string
  /** 解析提示，例如「跳过 N 条没有名称的记录」。 */
  note: string
  fetchedAt: number
}

const REMOTE_SOURCES_ALL: RemoteSourceKey[] = ['official', 'npm', 'github', 'smithery', 'pulsemcp', 'custom']

const REMOTE_EMPTY: RemoteState = { status: 'idle', entries: [], error: '', url: '', note: '', fetchedAt: 0 }

function emptyRemote(): Record<RemoteSourceKey, RemoteState> {
  return REMOTE_SOURCES_ALL.reduce((acc, key) => {
    acc[key] = { ...REMOTE_EMPTY }
    return acc
  }, {} as Record<RemoteSourceKey, RemoteState>)
}

function isRemoteSourceKey(value: string | null): value is RemoteSourceKey {
  return !!value && (REMOTE_SOURCES_ALL as string[]).includes(value)
}

/* ── 运行环境一键安装的进度模型 ──
   一张进度卡就是这份状态的一个切面：planning（取计划）→ ready（确认卡）→ running（winget
   跑着，日志在刷新）→ done / failed / cancelled；引擎没有 install-plan 接口时是 unsupported，
   界面据此降级回「复制命令」；Docker 这类引擎不代装的走 guided（只给人工引导）。 */
export type RuntimeInstallPhase =
  | 'planning' | 'ready' | 'running' | 'done' | 'failed' | 'cancelled' | 'guided' | 'unsupported'

export interface RuntimeInstallProgress {
  id: string
  label: string
  phase: RuntimeInstallPhase
  /** 引擎给的确认卡数据（命令、作用域、是否可装、步骤）。 */
  plan: RuntimeInstallPlan | null
  /** 确认卡/降级模式上展示的命令（与引擎实际执行同源）。 */
  command: string
  log: string[]
  status: string
  /** 失败原因（含 stderr 尾部）。 */
  error: string
  /** 非失败的一句补充（例如「装好了但还没探测到，可能需要重开 Coomi」）。 */
  notice: string
  guidance: string
  before: RuntimeProbe | null
  after: RuntimeProbe | null
  taskId: string
  /** 实时输出来自哪个接口：install-status（完整）或任务日志（兜底）。 */
  source: 'install-status' | 'task-log' | 'none'
  startedAt: number
  finishedAt: number
}

function emptyRuntimeProgress(id: string, label = ''): RuntimeInstallProgress {
  return {
    id,
    label: label || id,
    phase: 'planning',
    plan: null,
    command: '',
    log: [],
    status: '',
    error: '',
    notice: '',
    guidance: '',
    before: null,
    after: null,
    taskId: '',
    source: 'none',
    startedAt: Date.now(),
    finishedAt: 0,
  }
}

/** 安装轮询：900ms 一问（winget 的输出是流式的，日志看起来才像实时）；
 *  35 分钟硬上限与引擎侧的任务超时（30 分钟）留出余量。 */
const RUNTIME_INSTALL_POLL_MS = 900
const RUNTIME_INSTALL_DEADLINE_MS = 35 * 60 * 1000
/** 正在轮询的安装：stop=true 时循环退出（用户取消）。 */
const runtimeInstallRuns = new Map<string, { stop: boolean }>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms) })
}

/** 失败摘要里附带的日志尾部：winget 的原话比我们的转述有用得多。 */
function logTail(lines: string[], count = 3): string {
  const trimmed = lines.map((line) => line.trim()).filter(Boolean)
  return trimmed.slice(-count).join(' | ').slice(0, 400)
}

/** 写一份进度快照（按 id 合并）：所有安装流程都只经这里改状态，避免各处各写一份。 */
function patchRuntimeProgress(id: string, patch: Partial<RuntimeInstallProgress>): RuntimeInstallProgress {
  const key = id.trim().toLowerCase()
  const previous = useLibrary.getState().runtimeInstalls[key] ?? emptyRuntimeProgress(key)
  const next = { ...previous, ...patch, id: key }
  useLibrary.setState((state) => ({ runtimeInstalls: { ...state.runtimeInstalls, [key]: next } }))
  return next
}

const KEY_REMOTE_SOURCE = 'coomi.mcpRemoteSource'
const KEY_SOURCE_URL = 'coomi.mcpSourceUrl'
const KEY_SMITHERY = 'coomi.mcpSmitheryKey'

function readLocal(key: string): string {
  try { return localStorage.getItem(key) ?? '' } catch { return '' }
}

function writeLocal(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* 隐私模式忽略 */ }
}

/** 上次选中的源；本地存了不认识的值（老版本/手工改过）就退回官方注册表。 */
function readRemoteSource(): RemoteSourceKey {
  const stored = readLocal(KEY_REMOTE_SOURCE)
  return isRemoteSourceKey(stored) ? stored : 'official'
}

interface LibraryState {
  skills: CatalogEntry[]
  tools: CatalogEntry[]
  files: FileEntry[]
  currentPath: string
  preview: string
  previewName: string
  busy: string
  error: string
  loaded: boolean
  /** 当前选中的远程源（工具市场的来源切换）。 */
  remoteSource: RemoteSourceKey
  /** 自定义源的清单地址；对所有源都保留，切回来不用重填。 */
  remoteUrl: string
  /** Smithery 等源的 API Key（可选，明文存本地）。 */
  remoteKey: string
  /** 每个源各一份结果。 */
  remote: Record<RemoteSourceKey, RemoteState>
  /** 本机运行环境（node/npx/uv/uvx/docker/kubectl/git/ffmpeg），来自 /api/runtime/runtimes。 */
  runtimes: RuntimeStatus[]
  /** unsupported ＝ 引擎还没有这个接口（404），界面要降级而不是报错。 */
  runtimesStatus: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error'
  runtimesError: string
  runtimesCheckedAt: number
  loadRuntimes: () => Promise<void>
  /** 「重新检测」：重新拉目录 + 运行环境，让灰显条目有机会变回可安装。 */
  recheckEnvironment: () => Promise<void>
  /** 运行环境一键安装的进度：按运行时 id 存，进度卡直接订阅它。 */
  runtimeInstalls: Record<string, RuntimeInstallProgress>
  /** 取确认卡数据（只读）：让按钮在用户点之前就知道命令是什么、能不能装。 */
  prepareRuntimeInstall: (id: string, label?: string) => Promise<RuntimeInstallProgress>
  /** 确认后真正开装：起任务 → 轮询实时输出 → 结束后自动重新探测。resolve 时已是终态。 */
  runRuntimeInstall: (id: string) => Promise<RuntimeInstallProgress>
  cancelRuntimeInstall: (id: string) => Promise<void>
  resetRuntimeInstall: (id: string) => void
  /** 远程 MCP 一键安装：直接写进 config/mcp_servers.json 并热重载。 */
  installRemote: (definition: McpInstallDefinition) => Promise<McpInstallResult>
  /** 最近一次安装建议重启谁（null = 没有待处理的建议）。 */
  restartHint: RestartHint | null
  setRestartHint: (hint: RestartHint | null) => void
  setRemoteSource: (key: RemoteSourceKey) => void
  setRemoteUrl: (url: string) => void
  setRemoteKey: (key: string) => void
  setRemoteState: (key: RemoteSourceKey, patch: Partial<RemoteState>) => void
  loadCatalog: () => Promise<void>
  /** /api/catalog 最近一次成功的时刻（0 = 从没拉到过）。 */
  catalogCheckedAt: number
  /** 切页/重挂载专用：**数据够新就不打网络**。
      为什么需要它：技能中心每次挂载都会 refresh()（目录 + 已安装 + 运行环境 = 3 个 HTTP），
      而 App 的 liveViews 只保「当前 + 上一个」—— 切走即卸载、切回即重挂，
      低配机上来回切页就是反复打三张网络 + 重渲染整张目录。 */
  ensureCatalog: (maxAgeMs?: number) => Promise<void>
  /** 同上：运行环境。 */
  ensureRuntimes: (maxAgeMs?: number) => Promise<void>
  install: (kind: 'skills' | 'mcp', id: string) => Promise<void>
  uninstall: (kind: 'skills' | 'mcp', id: string) => Promise<void>
  listDir: (path: string) => Promise<void>
  readFile: (path: string) => Promise<void>
  clearPreview: () => void
}

/** 切页回看时的数据保鲜期：这么久以内的结果直接复用，不再打网络（见 ensureCatalog）。 */
const VIEW_DATA_MAX_AGE_MS = 60_000

/* ── 「重新检测」的两道刹车（见 recheckEnvironment） ──
   背景：这两个接口都不便宜 —— /api/runtime/runtimes 实测约 2.3s（逐个 fork 子进程探测 10 个
   运行时），/api/catalog 实测约 3.3s。而「重新检测」在界面上有多个入口（运行环境状态条、灰显
   条目卡片、帮助弹窗、一键安装卡），连点几次就是十几条重请求、几十次进程创建，机器会被瞬时
   打满，界面上看起来就是「卡死」。 */

/** 最短重检间隔：5 秒。
 *
 *  为什么是这个数：一次**完整**重检自己就要约 5.6s（2.3 + 3.3），人的连点间隔远小于它；
 *  而真正想要新结论的场景（去装完一个运行时再回来点）所花的墙钟时间通常是几十秒到几分钟。
 *  5 秒既吞得掉连点，又不会把「我确实刚装好，快再检测一次」这个意图误判成无操作。
 *
 *  语义选择：**同一个 5 秒窗口内直接复用现有数据、一个请求都不发；超过窗口才真打网络。**
 *  理由：另一条路是「用户点重新检测就永远强制刷新」，但那等于让上面那几个入口继续各自制造
 *  并发峰值；而且 Windows 上装运行环境改的是 PATH，不重开应用本来就检测不到差别，
 *  强刷给不出新结论 —— 反而把引擎的看门狗逼到误判卡死。 */
const ENV_RECHECK_MIN_MS = 5_000

/** 正在飞的那一次 recheckEnvironment。模块级即可：同一页面只会有一个 store 实例。
 *  连点两次时第二次复用这个 Promise，而不是再发一轮请求（见 recheckEnvironment）。 */
let environmentRecheckInFlight: Promise<void> | null = null

const TEXT_EXT = /\.(md|txt|json|ya?ml|toml|js|ts|tsx|jsx|css|html|py|rs|go|java|sh|ps1|c|cpp|h|sql|log|csv)$/i

export const useLibrary = create<LibraryState>((set, get) => ({
  skills: [],
  tools: [],
  files: [],
  currentPath: '',
  preview: '',
  previewName: '',
  busy: '',
  error: '',
  loaded: false,
  remoteSource: readRemoteSource(),
  remoteUrl: readLocal(KEY_SOURCE_URL),
  remoteKey: readLocal(KEY_SMITHERY),
  remote: emptyRemote(),
  runtimes: [],
  runtimesStatus: 'idle',
  runtimesError: '',
  runtimesCheckedAt: 0,
  runtimeInstalls: {},
  restartHint: null,

  setRestartHint: (hint) => set((state) => {
    // 引擎级建议不覆盖更强的「要重启应用」：链式安装先装运行时、再写 MCP 条目，
    // 后一步不该把前一步「PATH 变了」的结论盖掉（30 分钟内的 app 建议优先）。
    const strong = state.restartHint
    if (hint?.target === 'engine' && strong?.target === 'app' && Date.now() - strong.at < 30 * 60 * 1000) return {}
    return { restartHint: hint }
  }),

  setRemoteSource: (key) => {
    // 只认识的键才落本地：写坏了下次启动会选中一个不存在的源。
    if (!isRemoteSourceKey(key)) return
    writeLocal(KEY_REMOTE_SOURCE, key)
    set({ remoteSource: key })
  },

  setRemoteUrl: (url) => {
    writeLocal(KEY_SOURCE_URL, url)
    set({ remoteUrl: url })
  },

  setRemoteKey: (key) => {
    writeLocal(KEY_SMITHERY, key)
    set({ remoteKey: key })
  },

  setRemoteState: (key, patch) => set((state) => ({
    remote: { ...state.remote, [key]: { ...state.remote[key], ...patch } },
  })),

  loadCatalog: async () => {
    set({ error: '' })
    try {
      const data = await useEngine.getState().api<{ skills?: CatalogEntry[]; mcp?: CatalogEntry[] }>('/api/catalog')
      set({ skills: data.skills ?? [], tools: data.mcp ?? [], loaded: true, catalogCheckedAt: Date.now() })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  /** /api/runtime/runtimes：引擎还没上线这个接口时必须优雅降级（404 → unsupported）。 */
  loadRuntimes: async () => {
    set({ runtimesStatus: 'loading', runtimesError: '' })
    try {
      const data = await useEngine.getState().api<unknown>('/api/runtime/runtimes')
      const list = normalizeRuntimes(data)
      if (!list.length) {
        // 接口在、但没给出可识别的条目：按「暂不支持检测」处理，别让界面显示「全都缺」。
        set({ runtimes: [], runtimesStatus: 'unsupported', runtimesError: '', runtimesCheckedAt: Date.now() })
        return
      }
      set({ runtimes: list, runtimesStatus: 'ready', runtimesError: '', runtimesCheckedAt: Date.now() })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const unsupported = /HTTP 40[45]|not found|不支持/i.test(message)
      set({
        runtimes: [],
        runtimesStatus: unsupported ? 'unsupported' : 'error',
        runtimesError: unsupported ? '' : message,
        runtimesCheckedAt: Date.now(),
      })
    }
  },

  catalogCheckedAt: 0,

  ensureCatalog: async (maxAgeMs = VIEW_DATA_MAX_AGE_MS) => {
    const state = get()
    if (state.loaded && Date.now() - state.catalogCheckedAt < maxAgeMs) return
    await state.loadCatalog()
  },

  ensureRuntimes: async (maxAgeMs = VIEW_DATA_MAX_AGE_MS) => {
    const state = get()
    if (state.runtimesStatus !== 'idle' && Date.now() - state.runtimesCheckedAt < maxAgeMs) return
    await state.loadRuntimes()
  },

  /* ── 「重新检测」：两道刹车 + 串行 ──
     调用方（SkillsView 的 recheckAll / 状态条 / 灰显卡片 / 帮助弹窗）不需要任何改动。 */
  recheckEnvironment: async () => {
    // ① 在飞复用（in-flight 去重）：同一时刻只允许一次重检在网络上。
    //    连点两次 → 第二次拿到的是第一次那个 Promise，不会产生第二条 /api/runtime/runtimes。
    if (environmentRecheckInFlight) return environmentRecheckInFlight

    const run = (async () => {
      // ② 最短间隔（见 ENV_RECHECK_MIN_MS）：数据还热就直接复用，一个请求都不发。
      //    两条数据源**各自**判断新鲜度，与 ensureCatalog / ensureRuntimes 同一口径：
      //    只有真的过期的那个才重拉 —— 若用「任一新鲜就全都跳过」，一次只刷过 runtimes 的
      //    调用就会把更过期的 catalog 一起吞掉，界面上会留下对不上的可用性标记。
      const now = Date.now()
      // ③ 串行而不是 Promise.all：见 SkillsView.recheckAll 的取舍注释。
      //    先 runtimes（缺哪个运行环境是最受关注的信息），再 catalog。
      if (now - get().runtimesCheckedAt >= ENV_RECHECK_MIN_MS) await get().loadRuntimes()
      if (now - get().catalogCheckedAt >= ENV_RECHECK_MIN_MS) await get().loadCatalog()
    })()

    environmentRecheckInFlight = run
    try {
      await run
    } finally {
      // 无论成功失败都要清空：留着一个已 settle 的旧 Promise，后续每次「重新检测」都会
      // 立刻拿到它而什么都不做 —— 那就从「去重」变成了「永久失效」。
      if (environmentRecheckInFlight === run) environmentRecheckInFlight = null
    }
  },

  /* ── 运行环境一键安装 ── */

  prepareRuntimeInstall: async (id, label) => {
    const key = id.trim().toLowerCase()
    const current = get().runtimeInstalls[key]
    // 已经在跑、或计划已就绪：不重来 —— 否则确认卡上的命令会在用户眼皮底下被换掉。
    if (current && (current.phase === 'planning' || current.phase === 'ready' || current.phase === 'running')) return current
    const hint = runtimeHint(key)
    patchRuntimeProgress(key, {
      ...emptyRuntimeProgress(key, label || current?.label || hint.label || key),
      startedAt: Date.now(),
    })
    const reply = await fetchRuntimeInstallPlan(key)
    if (reply.unsupported) {
      // 引擎没有 install-plan 接口：降级成「复制命令」，命令来自 runtimeMeta 的兜底表。
      return patchRuntimeProgress(key, { phase: 'unsupported', command: hint.winget, error: '' })
    }
    if (!reply.plan) {
      return patchRuntimeProgress(key, { phase: 'failed', error: reply.error })
    }
    const plan = reply.plan
    return patchRuntimeProgress(key, {
      plan,
      label: plan.label || key,
      command: plan.command || plan.manualCommand,
      guidance: plan.guidance,
      // 引擎不代装的（Docker）直接进引导态，别让用户点了「开始安装」才知道装不了。
      phase: plan.installable ? 'ready' : 'guided',
      before: { label: plan.label || key, found: plan.found, version: plan.version, path: plan.path },
      error: '',
    })
  },

  runRuntimeInstall: async (id) => {
    const key = id.trim().toLowerCase()
    let progress = get().runtimeInstalls[key] ?? await get().prepareRuntimeInstall(key)
    if (progress.phase === 'running') return progress
    if (progress.phase === 'unsupported') return progress
    const label = progress.label || runtimeHint(key).label || key
    const started = await startRuntimeInstallTask(key)
    if (started.unsupported) {
      return patchRuntimeProgress(key, {
        phase: 'unsupported',
        command: progress.command || runtimeHint(key).winget,
        error: started.message,
      })
    }
    if (started.guided) {
      return patchRuntimeProgress(key, {
        phase: 'guided',
        guidance: started.guidance || progress.guidance,
        command: started.command || progress.command,
      })
    }
    if (!started.ok) {
      return patchRuntimeProgress(key, { phase: 'failed', error: started.message })
    }
    if (started.alreadyInstalled || !started.taskId) {
      await get().loadRuntimes()
      return patchRuntimeProgress(key, {
        phase: 'done',
        status: 'completed',
        before: started.before ?? progress.before,
        after: started.after ?? started.before ?? progress.before,
        notice: started.message,
        finishedAt: Date.now(),
      })
    }
    const run = { stop: false }
    runtimeInstallRuns.set(key, run)
    patchRuntimeProgress(key, {
      phase: 'running',
      taskId: started.taskId,
      status: started.status || 'queued',
      command: started.command || progress.command,
      before: started.before ?? progress.before,
      log: [],
      error: '',
      notice: '',
      startedAt: Date.now(),
      finishedAt: 0,
      source: 'none',
    })
    const deadline = Date.now() + RUNTIME_INSTALL_DEADLINE_MS
    let timedOut = false
    while (!run.stop) {
      await sleep(RUNTIME_INSTALL_POLL_MS)
      if (run.stop) break
      const snapshot = await pollRuntimeInstall(started.taskId)
      const latest = get().runtimeInstalls[key]
      progress = patchRuntimeProgress(key, {
        // 日志只在拿到内容时替换：某一轮读空不该把已有输出擦掉。
        log: snapshot.log.length ? snapshot.log : (latest?.log ?? []),
        status: snapshot.status || latest?.status || '',
        source: snapshot.source,
        before: snapshot.before ?? progress.before,
        after: snapshot.after ?? progress.after,
        error: snapshot.error || progress.error,
      })
      if (!snapshot.running) break
      if (Date.now() >= deadline) { timedOut = true; run.stop = true }
    }
    // 只有自己还是"当前那次安装"时才收尾：用户取消后立刻重试会起一轮新的，
    // 旧循环不能把新循环的状态与登记表擦掉。
    const ownsRun = runtimeInstallRuns.get(key) === run
    if (ownsRun) runtimeInstallRuns.delete(key)
    // 装完自动重新探测：新装的工具要重新扫一遍 PATH / winget shim 目录才会被认出来。
    await Promise.all([get().loadRuntimes(), get().loadCatalog()])
    if (!ownsRun && runtimeInstallRuns.has(key)) return get().runtimeInstalls[key] ?? progress
    const latest = get().runtimeInstalls[key]
    // 进度被 reset 掉了（对话框关掉后重开另一条）：不要再把状态写回来。
    if (!latest) return progress
    // 用户点了取消：引擎侧任务已经 DELETE，这里保持 cancelled，不要再写成失败。
    if (run.stop && !timedOut) {
      return patchRuntimeProgress(key, {
        phase: latest.phase === 'failed' ? 'failed' : 'cancelled',
        finishedAt: Date.now(),
      })
    }
    if (timedOut) {
      return patchRuntimeProgress(key, {
        phase: 'failed',
        error: label + ' 安装超时，界面不再等待（任务可能还在后台跑，可在任务中心查看或取消）',
        finishedAt: Date.now(),
      })
    }
    if (latest.status === 'completed') {
      const found = latest.after?.found === true
      // 运行环境装完了：PATH 变了，新起的进程才会读到 —— 建议重启应用（引擎跟着重启）。
      get().setRestartHint({ target: 'app', label: '刚装好 ' + label, at: Date.now() })
      return patchRuntimeProgress(key, {
        phase: 'done',
        error: '',
        notice: found
          ? ''
          : '安装命令执行成功，但重新探测仍未找到它：可能需要完全退出并重开一次 Coomi（新程序要重新读 PATH）。',
        finishedAt: Date.now(),
      })
    }
    if (latest.status === 'cancelled') {
      return patchRuntimeProgress(key, { phase: 'cancelled', error: '', finishedAt: Date.now() })
    }
    const tail = logTail(latest.log)
    const summary = latest.error || label + ' 安装失败（' + runtimeTaskLabel(latest.status) + '）'
    return patchRuntimeProgress(key, {
      phase: 'failed',
      error: tail ? summary + '：' + tail : summary,
      finishedAt: Date.now(),
    })
  },

  cancelRuntimeInstall: async (id) => {
    const key = id.trim().toLowerCase()
    const run = runtimeInstallRuns.get(key)
    if (run) run.stop = true
    const taskId = get().runtimeInstalls[key]?.taskId ?? ''
    // 引擎侧也取消：DELETE /api/tasks/{id} 会杀掉 winget 并落结果行，不留孤儿进程。
    if (taskId) await cancelEngineTask(taskId)
    patchRuntimeProgress(key, { phase: 'cancelled', error: '', finishedAt: Date.now() })
  },

  resetRuntimeInstall: (id) => {
    const key = id.trim().toLowerCase()
    const run = runtimeInstallRuns.get(key)
    if (run) run.stop = true
    set((state) => {
      const next = { ...state.runtimeInstalls }
      delete next[key]
      return { runtimeInstalls: next }
    })
  },

  /* ── 远程 MCP 一键安装 ── */

  installRemote: async (definition) => {
    const result = await installRemoteMcp(definition)
    // 写盘成功（含「已保存但连不上」）就刷目录：卡片上的已安装标记与新条目可用性都靠它。
    if (result.saved) {
      await get().loadCatalog()
      // 只写了 MCP 条目：配置已经热重载，重启引擎就够（不用重启整个应用）。
      get().setRestartHint({
        target: 'engine',
        label: '刚写入 MCP 条目 ' + (definition.name || definition.id),
        at: Date.now(),
      })
    }
    return result
  },

  install: async (kind, id) => {
    set({ busy: id })
    try {
      await useEngine.getState().api('/api/catalog/' + kind + '/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      })
      await get().loadCatalog()
      // 目录条目装卸只动配置：需要的话重启引擎就够。
      get().setRestartHint({ target: 'engine', label: '刚装好 ' + id, at: Date.now() })
    } catch (e) { set({ error: e instanceof Error ? e.message : String(e) }) } finally { set({ busy: '' }) }
  },

  uninstall: async (kind, id) => {
    set({ busy: id })
    try {
      await useEngine.getState().api('/api/catalog/' + kind + '/' + encodeURIComponent(id), { method: 'DELETE' })
      await get().loadCatalog()
      get().setRestartHint({ target: 'engine', label: '刚卸载 ' + id, at: Date.now() })
    } catch (e) { set({ error: e instanceof Error ? e.message : String(e) }) } finally { set({ busy: '' }) }
  },

  listDir: async (path) => {
    try {
      const data = await useEngine.getState().api<{ entries?: Array<Record<string, any>>; path?: string }>(
        '/api/fs/list?path=' + encodeURIComponent(path || '/'),
      )
      const base = data.path ?? path
      const join = (dir: string, name: string): string => {
        if (!dir) return name
        const sep = dir.includes('\\') ? '\\' : '/'
        return dir.replace(/[\\/]+$/, '') + sep + name
      }
      const files: FileEntry[] = (data.entries ?? []).map((e) => {
        const name = String(e.name ?? '')
        // 引擎只回 name/is_dir（不回绝对路径），这里自己拼；顺带兼容 type/path 字段。
        const isDir = typeof e.is_dir === 'boolean' ? e.is_dir : e.type === 'dir' || e.kind === 'dir'
        return {
          name,
          path: String(e.path ?? '') || join(base, name),
          type: isDir ? 'dir' : 'file',
          size: Number(e.size ?? 0),
          modified: typeof e.modified === 'number' ? e.modified : undefined,
        }
      })
      files.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      set({ files, currentPath: data.path ?? path, error: '' })
    } catch (e) { set({ error: e instanceof Error ? e.message : String(e), files: [] }) }
  },

  readFile: async (path) => {
    set({ preview: '', previewName: path.split(/[\\/]/).pop() ?? '' })
    if (!TEXT_EXT.test(path)) { set({ preview: '（二进制或不支持预览的文件类型，可用「在文件夹中显示」打开）' }); return }
    try {
      const res = await fetch('http://127.0.0.1:' + useEngine.getState().port + '/api/fs/raw?path=' + encodeURIComponent(path), {
        headers: useEngine.getState().authHeaders(),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const text = await res.text()
      set({ preview: text.length > 400_000 ? text.slice(0, 400_000) + '\n\n…（内容过长已截断）' : text })
    } catch (e) { set({ preview: '读取失败：' + (e instanceof Error ? e.message : String(e)) }) }
  },

  clearPreview: () => set({ preview: '', previewName: '' }),
}))
