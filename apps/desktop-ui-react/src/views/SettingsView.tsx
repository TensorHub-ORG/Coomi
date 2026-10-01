import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEngine } from '../stores/engine'
import { useSession } from '../stores/session'
import {
  useUi,
  resolveContentPx,
  MESSAGE_WIDTHS,
  READING_MAX_W,
  type CrashRecoveryMode,
  type Density,
  type InsertMode,
  type MessageWidthMode,
  type ThemeMode,
  type ViewKey,
} from '../stores/ui'
// 空态文案轮换的开关（键 coomi.rotateCopy.v1，默认开）：见 lib/rotateCopy.ts。
import { readRotateCopyEnabled, writeRotateCopyEnabled } from '../lib/rotateCopy'
import { useViewportWidth } from '../components/shell/dockShared'
import { usePaneActive } from '../components/shell/navPause'
import { fmtBytes, prettyPath, shortPath } from '../lib/format'
import { ipc } from '../lib/ipc'
import { PageHeader, Section, Cell } from '../components/ui/Card'
// 分组导航 + 「旧出 / 新入」的过渡与卡片错峰（都在这个组件里，视图只负责给数据与滚动位置）。
import { GroupNav, GroupTransition, Stagger, StaggerGrid } from '../components/settings/GroupTransition'
// 界面字号三档：选项与「旧值归一」都在这个表里；落盘/生效仍走 stores/ui.ts 既有的外观设置那条路。
import { UI_FONT_SCALES, nearestFontScale } from '../components/settings/uiFontScale'
import { ProviderWizard } from '../components/settings/ProviderWizard'
import { EngineLogDialog } from '../components/settings/EngineLogDialog'
// 重启的两个动作（引擎 / 应用）与 SkillsView 的安装完成卡共用一处实现。
import { restartAppNow, restartEngineNow } from '../components/skills/RestartPrompt'
// 开发者面板：与「引擎与诊断」归在同一分组，只显示引擎真实返回的数据。
import { DeveloperPanel } from '../components/settings/DeveloperPanel'
// 下载与镜像 / 存储位置：同样归在「引擎与诊断」分组，排在开发者面板前面（用户能看到的那两块）。
import { MirrorPanel } from '../components/settings/MirrorPanel'
import { StoragePanel } from '../components/settings/StoragePanel'
// 上下文压缩：自动压缩何时触发、压完留多少（跟着「AI 能力」分组显示）。
import { CompactionPanel } from '../components/settings/CompactionPanel'
// 经验库：「长期记忆」开关下真正被引擎记住的那些失败经验（可查看 / 可删）。
import { MemoryLessonsPanel } from '../components/settings/MemoryLessonsPanel'
// 任务轨迹：每轮任务的成败 / 失败类型 / 轮次 / 最后的工具 / 耗时（同样挂在「AI 能力」分组下）。
import { TrajectoryPanel } from '../components/settings/TrajectoryPanel'
import logo from '../assets/coomi-logo.png'
import { Button } from '../components/ui/Button'
import { Input, Badge } from '../components/ui/Input'
import { Segmented, Skeleton, SkeletonRows, Spinner, Switch } from '../components/ui/Controls'
// 注：AI 状态动效（AgentState）由 components/ai/AgentState.tsx 提供，本页此刻还没有该文件，
// 「加载中」一律先用骨架屏占位。TODO(components/ai/AgentState)：就绪后换成 <AgentState state="running" size="sm" />。
import { useAgent, EFFORT_LABELS, PERMISSION_LABELS, type PermissionMode, type ReasoningEffort } from '../stores/agent'
import { useCapabilities, type Capabilities } from '../stores/capabilities'
import { Menu } from '../components/ui/Menu'
import { Select } from '../components/ui/Select'
// 插件：外观组的「插件主题」下拉与「插件」分组共用同一份 store（见 components/plugins/pluginStore.ts）。
import { usePluginStore, activeThemePluginId, pluginName, themePlugins } from '../components/plugins/pluginStore'
// 「再看一次」入口：引导的开关在它自己的 store 里（首次启动那套强制勾选不受影响）。
import { openOnboarding } from '../components/onboarding/store'
import { cn } from '../lib/cn'
import { Trash2, RefreshCw, FolderOpen, Plus, Brain, Shield, Wrench, Server, LifeBuoy, Download, AlertTriangle } from 'lucide-react'

/** 关于页显示的「构建日期」：**必须取本地日期**。
 *  用 toISOString() 拿到的是 UTC 日期 —— 东八区凌晨 0~8 点时它还是前一天，
 *  于是「构建日期」看起来永远停在昨天。 */
function localDateStamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

interface Provider {
  id: string
  name?: string
  model?: string
  active?: boolean
  type?: string
  baseUrl?: string
  models?: string[]
  modelContextWindows?: Record<string, number>
  modelDescriptions?: Record<string, string>
  modelParameters?: Record<string, { max_output_tokens?: number }>
  capabilityOverrides?: Record<string, Record<string, boolean>>
}
interface LifeSettings {
  enabled: boolean
  delivery: string
  dailyMode: string
  dailyLimitCustom: number
  globalMode: boolean
  windowStartMinutes: number
  windowEndMinutes: number
  minIntervalMinutes: number
  quietAfterTurnMinutes: number
}

/** 壳命令 update_check 的返回（Tauri 侧是 camelCase 的 UpdateCheckReport）。
    服务端缺字段时的降级都在壳里做完：notes 一定有可读文案，downloadUrl 缺了就按
    /api/v1/download/{code}/{windows} 拼，size 换不成字节就是 null。 */
interface UpdateReport {
  current: string
  latest: string
  hasUpdate: boolean
  name: string
  notes: string
  downloadUrl: string
  size: number | null
  publishedAt: string | null
  /** 安装包摘要（清单给了才有）：一键更新在下载后拿它校验。 */
  sha256: string | null
  /** 清单里可选的镜像地址列表（壳按顺序重试）。 */
  urls?: string[]
}

/** 壳命令 download_update / verify_sha256 / install_update 的返回。 */
interface UpdateActionReport {
  status: string
  message: string
  path?: string
  url?: string
}

/** 壳发来的 update:progress 事件（下载阶段每 600ms 一条）。 */
interface UpdateProgressPayload {
  phase: string
  got: number
  total: number
  speed: number
  message: string
}

/** 检查更新的三态 + 结果：错误态单独存一份可读原因，别把失败伪装成「已是最新」。 */
interface UpdateState {
  status: 'idle' | 'checking' | 'done' | 'error'
  report?: UpdateReport
  error?: string
}

/** 设置分组：左列导航，右侧只渲染当前组。**放在组件外** —— 它是静态表，
    写在组件里等于每次渲染都新建一份，GroupNav 的 props 永远不相等（连带它的指南针测量一起重跑）。 */
const GROUPS = [
  { key: 'general', label: '通用' },
  { key: 'appearance', label: '外观' },
 
  { key: 'models', label: '模型与厂商' },
  { key: 'workspace', label: '工作区' },
  { key: 'ai', label: 'AI 能力' },
  { key: 'life', label: '数字生命体' },
  { key: 'engine', label: '引擎与诊断' },
  { key: 'about', label: '关于' },
] as const

/** 分组 key 的联合类型（表在上面，类型跟着表走）。 */
type GroupKey = (typeof GROUPS)[number]['key']


const RECENT_KEY = 'coomi.recentCwd.v1'

function readRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[] } catch { return [] }
}

function pushRecent(dir: string): string[] {
  const list = [dir, ...readRecent().filter((d) => d !== dir)].slice(0, 5)
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)) } catch { /* 忽略 */ }
  return list
}

const hhmm = (minutes: number): string =>
  String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0')

/** 量对话列当前宽度：对话页在同一个内容层里（挂载集合是「当前 + 上一次」），
    所以在设置页也能量到对话列的真实布局宽度，「自适应」档位显示的才是当前像素值。 */
function useChatColumnWidth(): number {
  // 页面前后台：设置页被换下去之后（隐藏但还挂着）这个轮询就该停 ——
  // clientWidth 每次都触发一次同步布局，躲在 opacity:0 后面每 600ms 量一次纯属白烧主线程。
  const active = usePaneActive()
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!active) return
    let done = false
    const measure = (): boolean => {
      const col = document.querySelector<HTMLElement>('[data-chat-col]')
      if (!col || col.clientWidth <= 0) return false
      // 量到的是同一个宽度就不写 state：这个轮询每 600ms 一次，同值 setState 会白白排一轮渲染
      // （设置页两百多个格子 + 一堆 Segmented，多渲染一次都是钱）。
      setWidth((prev) => (prev === col.clientWidth ? prev : col.clientWidth))
      return true
    }
    if (measure()) return
    // 对话页还没挂载过（默认页不是对话）时轮询等一会儿，拿到就停。
    const timer = window.setInterval(() => {
      if (measure()) { done = true; window.clearInterval(timer) }
    }, 600)
    return () => { if (!done) window.clearInterval(timer) }
  }, [active])
  return width
}

/** 固定档位的中文名：档位数值本身在 stores/ui.ts 的 MESSAGE_WIDTHS 里维护。 */
const WIDTH_LABELS: Record<number, string> = { 680: '窄', 768: '标准', 960: '宽' }

/** 本地留痕体积上限的常用档位（MB）：0 = 不限（默认）。
    引擎可能回读到一个自定义值（如 128），那就把它补进选项 —— 否则 Segmented 找不到匹配项，
    整组会一个都不高亮。1~4096 的有效范围由 stores/capabilities.ts 的 engineValue 先夹好。 */
const TRACE_MAX_PRESETS = [0, 64, 256, 1024]
function traceMaxOptions(current: number): Array<{ value: string; label: string }> {
  const values = TRACE_MAX_PRESETS.includes(current) ? TRACE_MAX_PRESETS : [...TRACE_MAX_PRESETS, current].sort((a, b) => a - b)
  return values.map((v) => ({ value: String(v), label: v === 0 ? '不限' : v + ' MB' }))
}

/** 消息栏宽度：固定档 窄/标准/宽 + 自适应，并给实时预览与当前像素值。 */
function MessageWidthField({ mode, width, onMode, onWidth, wide }: {
  mode: MessageWidthMode
  width: number
  onMode: (m: MessageWidthMode) => void
  onWidth: (px: number) => void
  /** 跨列提示：内容本身永远走整行（Cell wide），这里只是让外层 StaggerGrid 知道
      这一格要补 lg:col-span-2——格子被错峰包了一层，跨列得由外层补。 */
  wide?: boolean
}) {
  const viewport = useViewportWidth()
  const colWidth = useChatColumnWidth()
  // 对话列左右各 12px 内边距，才是正文列的可用宽度。
  const inner = Math.max(0, colWidth - 24)
  const prefs = useUi((s) => s.prefs)
  const px = resolveContentPx({ ...prefs, messageWidth: width, messageWidthMode: mode }, inner, viewport)
  const ratio = colWidth > 0 ? Math.min(1, px / colWidth) : 0.6
  return (
    <Cell
      // 这一格永远走整行；wide 参数只决定外层 StaggerGrid 是否补 lg:col-span-2。
      wide={wide ?? true}
      label='消息栏宽度'
      hint={mode === 'fluid'
        ? '自适应：跟随窗口放宽到上限，正文另有阅读上限（约 ' + READING_MAX_W + 'px）'
        : '固定宽度：无论窗口多大，对话正文都不超过这个宽度'}
      className='items-start'
    >
      <div className='flex w-full min-w-0 flex-col gap-2'>
        <div className='flex min-w-0 flex-wrap items-center justify-end gap-2'>
          <Segmented<string>
            className='min-w-0 max-w-full'
            value={mode === 'fluid' ? 'fluid' : String(width)}
            onChange={(v) => { if (v === 'fluid') onMode('fluid'); else { onWidth(Number(v)); onMode('fixed') } }}
            options={[
              ...MESSAGE_WIDTHS.map((n) => ({ value: String(n), label: WIDTH_LABELS[n] + ' ' + n })),
              { value: 'fluid', label: '自适应' },
            ]}
          />
          <span className='shrink-0 font-mono text-11 text-ink-4' data-testid='message-width-px'>
            {mode === 'fluid' ? '自适应 · 当前 ' + px + 'px' : '固定 ' + px + 'px'}
          </span>
        </div>
        {/* 实时预览：按对话列等比缩放，条形宽度就是正文列在对话列里的占比 */}
        <div className='w-full overflow-hidden rounded-md border border-line bg-muted p-1.5' data-testid='message-width-preview'>
          <div
            className='mx-auto h-9 rounded-xs border-x border-primary/30 bg-primary-soft transition-[width] duration-[var(--motion-base)] ease-[var(--ease-enter)]'
            style={{ width: Math.max(8, Math.round(ratio * 100)) + '%' }}
          />
          <p className='mt-1 text-center text-11 text-ink-4'>
            {colWidth > 0 ? '对话列 ' + colWidth + 'px · 正文 ' + px + 'px' : '正文 ' + px + 'px'}
          </p>
        </div>
      </div>
    </Cell>
  )
}

export function SettingsView() {
  /* ── 字段选择器，不是整对象订阅 ──
     这三行原来是 useEngine() / useSession() / useUi()：整对象订阅＝**任何一个字段**一变
     就要把整个设置页重渲染一遍。而引擎的 usage 每来一个 token 就换一次引用，
     生成中待在设置页＝每隔几十毫秒重渲染一次整页（两百多个格子 + 一堆 Segmented）。
     现在按字段各订各的；动作（setPrefs / api / applyCwd…）从 store 上取，引用恒定，
     所以下面那几百行模板一行都不用改。 */
  const engineReady = useEngine((s) => s.ready)
  const engineCwd = useEngine((s) => s.cwd)
  const engineVersion = useEngine((s) => s.version)
  const engineStatus = useEngine((s) => s.status)
  const enginePort = useEngine((s) => s.port)
  const engineLastError = useEngine((s) => s.lastError)
  const engine = useMemo(() => ({
    ready: engineReady,
    cwd: engineCwd,
    version: engineVersion,
    status: engineStatus,
    port: enginePort,
    lastError: engineLastError,
    api: useEngine.getState().api,
    stop: useEngine.getState().stop,
  }), [engineReady, engineCwd, engineVersion, engineStatus, enginePort, engineLastError])
  const pendingCwd = useSession((s) => s.pendingCwd)
  const session = useMemo(() => ({
    pendingCwd,
    applyCwd: useSession.getState().applyCwd,
    rememberCwd: useSession.getState().rememberCwd,
  }), [pendingCwd])
  const prefs = useUi((s) => s.prefs)
  const themeMode = useUi((s) => s.themeMode)
  const fontScale = useUi((s) => s.fontScale)
  const ui = useMemo(() => ({
    prefs, themeMode, fontScale,
    setPrefs: useUi.getState().setPrefs,
    setThemeMode: useUi.getState().setThemeMode,
    setFontScale: useUi.getState().setFontScale,
  }), [prefs, themeMode, fontScale])
  /* ── 插件：外观组的插件主题下拉。候选项 = 已启用且带主题的插件；没有就整行隐藏。
     #185（无限渲染）根因：选择器直接返回 themePlugins(...) 的派生结果，每次调用都新建数组，
     引用永远不等 → 依赖它的 effect 每帧都跑 → setState → 循环。这里只订阅稳定引用
     （plugins 数组 / prefs 对象），派生结果用 useMemo 缓存，引用只在真正变化时更新。 ── */
  const pluginEntries = usePluginStore((s) => s.plugins)
  const pluginPrefs = usePluginStore((s) => s.prefs)
  const pluginThemes = useMemo(() => themePlugins(pluginEntries, pluginPrefs), [pluginEntries, pluginPrefs])
  const activePluginThemeId = useMemo(() => activeThemePluginId(pluginEntries, pluginPrefs), [pluginEntries, pluginPrefs])
  const setPluginTheme = usePluginStore((s) => s.setThemeSelected)
  const agentPermission = useAgent((s) => s.permission)
  const agentEffort = useAgent((s) => s.effort)
  const agentMaxToolRounds = useAgent((s) => s.maxToolRounds)
  const agent = useMemo(() => ({
    permission: agentPermission,
    effort: agentEffort,
    maxToolRounds: agentMaxToolRounds,
    setPermission: useAgent.getState().setPermission,
    setEffort: useAgent.getState().setEffort,
    setMaxToolRounds: useAgent.getState().setMaxToolRounds,
  }), [agentPermission, agentEffort, agentMaxToolRounds])

  const [providers, setProviders] = useState<Provider[]>([])
  /// 每个 Provider 拉到的模型列表（自动获取，不再手打模型名）。
  const [modelMap, setModelMap] = useState<Record<string, string[]>>({})
  const [adding, setAdding] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  /** 传给 ProviderWizard 的「正在编辑的那一条」：**必须 memo**。
      ProviderWizard 的重置 effect 依赖它是「同一条厂商」这件事，而对象字面量每次渲染都是新的引用：
      向导一开着，设置页的任何一次重渲染（引擎 usage、提示文案、分组切换）都会重新触发那个 effect，
      把整个模型表按新 uid 重建一遍（memo 行的引用全失效 → 整表重挂载）。 */
  const editingSnapshot = useMemo<Provider | null>(() => (editingProvider ? {
    id: editingProvider.id,
    name: editingProvider.name,
    model: editingProvider.model,
    type: editingProvider.type,
    baseUrl: editingProvider.baseUrl,
    models: editingProvider.models,
    modelContextWindows: editingProvider.modelContextWindows,
    modelDescriptions: editingProvider.modelDescriptions,
    modelParameters: editingProvider.modelParameters,
    capabilityOverrides: editingProvider.capabilityOverrides,
  } : null), [editingProvider])
  /** 已有厂商的 id：传给向导做「自动生成标识」的避重表（引用要稳，否则向导会重算）。 */
  const providerIds = useMemo(() => providers.map((item) => item.id), [providers])
  const [life, setLife] = useState<LifeSettings | null>(null)
  const [lifeBusy, setLifeBusy] = useState(false)
  const [dataHome, setDataHome] = useState('')
  const [logPath, setLogPath] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const [recent, setRecent] = useState<string[]>(readRecent())
  const [notice, setNotice] = useState('')
  /// 桌面壳行为（关闭到托盘 / 开机自启），由 Tauri 侧持久化在 desktop-ui.json。
  const [desktopPrefs, setDesktopPrefs] = useState({ closeToTray: true, autostart: false })
  const caps = useCapabilities((s) => s.caps)
  const setCaps = useCapabilities((s) => s.set)
  /// 设置分组：左列导航，右侧只渲染当前组（分组表在文件顶部，静态一份）。
  /// 空态那句话每 14 秒换一组（默认开）。刻意**不**并进 ui.prefs：它落在自己的
  /// localStorage 键上（coomi.rotateCopy.v1），偏好结构不动，空态那边按订阅即时跟上。
  const [rotateCopy, setRotateCopy] = useState(readRotateCopyEnabled)
  const [group, setGroup] = useState<GroupKey>('appearance')
  /// 分组切换方向：1＝往后面的分组切（内容向上走）。GroupTransition 依据它决定进出场方向。
  const [groupDir, setGroupDir] = useState(1)
  /// 分组内容共用一个滚动容器，所以**每个分组各自记一份滚动位置**：
  /// 换组时先存下当前分组的 scrollTop，新分组挂载时再由 GroupTransition 放回去。
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const scrollMemo = useRef<Record<string, number>>({})

  const selectGroup = (next: GroupKey): void => {
    if (next === group) return
    const from = GROUPS.findIndex((g) => g.key === group)
    const to = GROUPS.findIndex((g) => g.key === next)
    setGroupDir(to >= from ? 1 : -1)
    scrollMemo.current[group] = bodyRef.current?.scrollTop ?? 0
    setGroup(next)
  }
  /// 「模型与厂商」首次加载：接口回来之前铺骨架，避免闪一下空面板。
  const [providersPending, setProvidersPending] = useState(false)

  /// 一句一闪而过的提示：只写值真的有变化的那一次 —— 同值 setState 会白排一轮渲染
  /// （设置页两百多个格子 + 一堆 Segmented，多渲染一次都是钱）。
  const flash = useCallback((text: string): void => {
    setNotice((prev) => (prev === text ? prev : text))
    window.setTimeout(() => setNotice((prev) => (prev === text ? '' : prev)), 2200)
  }, [])

  /* ── 检查更新（关于页）──
     以前这里是一句写死的 flash('已是最新版本')：点了等于没点，用户拿不到任何真实信息。
     现在真调壳命令 update_check —— 壳直连发布服务 /api/v1/info，只读 latest_version_code /
     latest_version / platforms.windows 三个字段，缺说明、缺下载地址、缺 sha256 都由壳侧降级。
     网络不通时壳回的是可读中文原因，这里原样摊给用户看，不做静默兜底。 */
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })
  /// 结果快照：写进 JSX 里少几次可选链，回调里也读得到同一个值。
  const updateReport = update.report
  /* ── 客户端版本（关于页）──
     不再写死版本号：优先用 update_check 返回的 current（壳读的就是打包配置，随
     tauri.conf.json 走，权威）；没检查过就用 withGlobalTauri 注入的
     __TAURI__.app.getVersion()（本机 API，零网络开销）兜底；两个都拿不到显示「—」。 */
  const [tauriVersion, setTauriVersion] = useState<string | null>(null)
  useEffect(() => {
    if (updateReport?.current) return // 壳已返回版本，直接用，不再重复取
    const app = (window as unknown as { __TAURI__?: { app?: { getVersion?: () => Promise<string> } } }).__TAURI__?.app
    app?.getVersion?.()
      .then((v) => setTauriVersion(v || null))
      .catch(() => { /* 拿不到就显示「—」，不阻塞页面 */ })
  }, [updateReport?.current])
  /// 客户端版本：检查更新的 current 优先，其次 tauriVersion，最后「—」。
  const clientVersion = updateReport?.current || tauriVersion || '—'

  const checkUpdate = useCallback(async (): Promise<void> => {
    setUpdate({ status: 'checking' })
    try {
      const report = await ipc<UpdateReport>('update_check')
      setUpdate({ status: 'done', report })
      flash(report.hasUpdate ? '发现新版本 ' + report.latest : '已是最新版本（' + report.current + '）')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setUpdate({ status: 'error', error: message })
      flash('检查更新失败：' + message)
    }
  }, [flash])

  /* ── 一键更新（下载 → 校验 → 静默安装 → 重启）──
     以前这里只有一个「用浏览器下载」：既不认镜像（国内直连 raw 常断），也不校验摘要，
     装完还得用户自己去点。现在整条链路都在壳里：镜像改写 + sha256 校验 + NSIS /S 安装。
     唯一的人工介入是 perMachine 安装会弹一次 UAC（点「是」）。 */
  const [updateProgress, setUpdateProgress] = useState<UpdateProgressPayload | null>(null)
  const [updatePhase, setUpdatePhase] = useState<{ text: string; tone: 'info' | 'ok' | 'error' } | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    const listen = (window as unknown as {
      __TAURI__?: { event?: { listen?: (name: string, handler: (event: { payload?: UpdateProgressPayload }) => void) => Promise<() => void> } }
    }).__TAURI__?.event?.listen
    if (typeof listen !== 'function') return
    let unlisten: (() => void) | undefined
    void listen('update:progress', (event) => {
      const payload = event.payload
      if (!payload) return
      setUpdateProgress(payload)
      if (payload.phase === 'download') setUpdatePhase({ text: payload.message || '正在下载更新包…', tone: 'info' })
    }).then((fn) => { unlisten = fn }).catch(() => { /* 壳不支持事件：进度条不显示，流程照走 */ })
    return () => { unlisten?.() }
  }, [])

  /** 总大小未知时给「下载中」，知道就按 report.size 算百分比。 */
  const percentNumber = (progress: UpdateProgressPayload): number => {
    const total = progress.total || updateReport?.size || 0
    if (!total || !progress.got) return 0
    return Math.max(0, Math.min(100, Math.round((progress.got / total) * 100)))
  }

  const installUpdate = useCallback(async (): Promise<void> => {
    if (installing) return
    setInstalling(true)
    setUpdateProgress(null)
    setUpdatePhase({ text: '正在准备下载…', tone: 'info' })
    try {
      const download = await ipc<UpdateActionReport>('download_update', { url: null })
      if (download.status !== 'ok' || !download.path) {
        throw new Error(download.message || '下载失败')
      }
      setUpdateProgress(null)
      setUpdatePhase({ text: '正在校验安装包…', tone: 'info' })
      const verify = await ipc<UpdateActionReport>('verify_sha256', {
        path: download.path,
        sha256: updateReport?.sha256 ?? null,
      })
      // 只有「校验通过」才继续。壳侧已把「清单缺 sha256」从 skipped 改成硬拒绝，
      // 这里也不再接受 skipped —— 以前会带着一个未校验的安装包直接进安装流程。
      if (verify.status !== 'ok') {
        throw new Error(verify.message || '校验失败')
      }
      setUpdatePhase({ text: '校验通过，正在启动安装程序…', tone: 'info' })
      const install = await ipc<UpdateActionReport>('install_update', {
        path: download.path,
        sha256: updateReport?.sha256 ?? null,
      })
      if (install.status !== 'ok') throw new Error(install.message || '无法启动安装程序')
      setUpdatePhase({
        text: install.message + '：它会关闭本应用并自动重开，稍等片刻即可用上新版本。',
        tone: 'ok',
      })
      flash('更新已开始，应用即将重启')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setUpdatePhase({ text: '一键更新失败：' + message + '（可用「手动下载」自己装）', tone: 'error' })
      flash('一键更新失败：' + message)
    } finally {
      setInstalling(false)
    }
  }, [flash, installing, updateReport?.sha256])

  const loadProviders = useCallback(async () => {
    if (!engine.ready) return
    try {
      const d = await engine.api<{ providers?: Provider[] }>('/api/providers')
      setProviders(d.providers ?? [])
    } catch { /* 引擎未就绪时静默 */ }
  }, [engine])

  /// 从上游 /models 拉取该 Provider 的可用模型（引擎侧探测，密钥不出本机）。
  const fetchModels = useCallback(async (id: string, silent = false): Promise<string[]> => {
    try {
      const d = await engine.api<{ models?: string[]; stale?: boolean }>(
        '/api/providers/' + encodeURIComponent(id) + '/discover-models',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persist: false }) },
      )
      const models = d.models ?? []
      setModelMap((m) => ({ ...m, [id]: models }))
      if (!silent) flash(models.length ? '拉取到 ' + models.length + ' 个模型' : '上游没有返回模型')
      return models
    } catch (e) {
      if (!silent) flash('获取模型失败：' + (e instanceof Error ? e.message : String(e)))
      return []
    } finally { /* 无 spinner */ }
  }, [engine])

  const loadLife = useCallback(async () => {
    if (!engine.ready) return
    try { setLife(await engine.api<LifeSettings>('/api/life/settings')) } catch { /* 忽略 */ }
  }, [engine])

  useEffect(() => { void loadProviders(); void loadLife() }, [loadProviders, loadLife])

  useEffect(() => {
    if (!engine.ready) return
    if (providers.length) return
    setProvidersPending(true)
    const timer = window.setTimeout(() => setProvidersPending(false), 900)
    return () => window.clearTimeout(timer)
  }, [engine.ready, providers.length])

  /// Provider 列表就绪后自动补一次模型列表：用户不该为了选模型先点一遍「获取」。
  useEffect(() => {
    if (!engine.ready || !providers.length) return
    for (const p of providers) {
      if (!modelMap[p.id]) void fetchModels(p.id, true)
    }
    // 只在 provider 集合变化时触发；modelMap 故意不进依赖，避免自激。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.ready, providers, fetchModels])

  useEffect(() => {
    if (!engine.ready) return
    void ipc<string>('data_home').then(setDataHome).catch(() => {})
    void ipc<string | null>('engine_log_path').then((p) => setLogPath(p ?? '')).catch(() => {})
    // 桌面壳的后台运行开关（老版本壳没有这个命令，失败时保持默认值即可）。
    void ipc<{ closeToTray: boolean; autostart: boolean }>('desktop_prefs')
      .then((prefs) => setDesktopPrefs({ closeToTray: prefs?.closeToTray ?? true, autostart: prefs?.autostart ?? false }))
      .catch(() => {})
  }, [engine.ready])

  const patchLife = async (patch: Partial<LifeSettings>): Promise<void> => {
    setLifeBusy(true)
    try {
      const next = await engine.api<LifeSettings>('/api/life/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      setLife(next)
    } catch (e) { flash('保存失败：' + (e instanceof Error ? e.message : String(e))) } finally { setLifeBusy(false) }
  }

  const pickDefaultCwd = async (): Promise<void> => {
    const dir = await ipc<string | null>('pick_directory')
    if (!dir) return
    await session.applyCwd(dir)
    setRecent(pushRecent(dir))
    flash('默认工作目录已更新')
  }

  const rawCwd = session.pendingCwd || engine.cwd || ''
  const defaultCwd = prettyPath(rawCwd)

  return (
    <main className='flex min-h-0 flex-1 flex-col bg-canvas'>
      <div className='flex min-h-0 flex-1 gap-6 px-8 pb-8'>
        <GroupNav className='w-[176px] pt-1' groups={GROUPS} value={group} onChange={selectGroup} />
        {/* 分组标题吸顶：标题跟着内容一起滚，滚到顶就停住并压一层毛玻璃。
            切分组不再是硬切：旧分组先退场、新分组再入场（方向按分组顺序），
            组内卡片按 20ms 错峰进来；每个分组的滚动位置各自记忆（scrollMemo）。 */}
        <div ref={bodyRef} className='min-h-0 flex-1 overflow-y-auto' data-testid='settings-body'>
          <PageHeader
            className='mb-1'
            sticky
            title='设置'
            description='外观、模型、工作区、数字生命体与引擎，都集中在这里。'
            actions={notice ? <span className='text-12 text-ok'>{notice}</span> : null}
          />
          <GroupTransition
            groupKey={group}
            dir={groupDir}
            scroller={bodyRef}
            scrollTop={scrollMemo.current[group] ?? 0}
            className='px-8 pb-4'
          >
          <div className='flex max-w-[860px] flex-col gap-5'>
          <Section className={group === 'general' ? '' : 'hidden'} title='通用' description='启动行为、发送行为与危险操作的确认策略。'>
          <StaggerGrid>
            <Cell label='启动时打开的页面' hint='下次启动默认进入这个页面'>
              <Segmented<ViewKey>
                value={ui.prefs.defaultView}
                onChange={(v) => ui.setPrefs({ defaultView: v })}
                options={[{ value: 'chat', label: '对话' }, { value: 'skills', label: '技能中心' }, { value: 'artifacts', label: '产物中心' }]}
              />
            </Cell>
            {/* 发送时插话模式：字段就是 stores/ui.ts 的 prefs.insertMode（现为 'interrupt' | 'queue'）。
                插队＝生成中按 Enter 打断当前轮、立刻发送新消息（已生成内容保留）；
                排队＝本轮跑完再按顺序执行，一个字不丢。对话页输入区右下角的同名菜单
                读写的是同一个字段，两处不会各存一份默认值。 */}
            <Cell
              label='发送时插话模式'
              hint={ui.prefs.insertMode === 'interrupt'
                ? '插队：生成中按 Enter 打断当前轮并立刻发送（已生成内容保留）'
                : '排队：生成中按 Enter 先排队，本轮结束后按顺序执行（不打断、不丢内容）'}
            >
              <Segmented<InsertMode>
                value={ui.prefs.insertMode}
                onChange={(v) => ui.setPrefs({ insertMode: v })}
                options={[{ value: 'interrupt', label: '插队' }, { value: 'queue', label: '排队' }]}
              />
            </Cell>
            <Cell label='危险操作二次确认' hint='删除对话、卸载技能、清理缓存前先问一次'>
              <Switch checked={ui.prefs.confirmDanger} onCheckedChange={(v) => ui.setPrefs({ confirmDanger: v })} />
            </Cell>
            {/* 安全模式（自救开关）：字段是 stores/ui.ts 的 prefs.safeMode（默认 false）。
                打开＝精简模式 —— 动效、富预览、语法高亮、长列表虚拟化与刻度轨重算全部让路，
                界面只画纯文本。发消息时整屏卡死的话，先靠它把界面救回来再查原因。
                另外两个入口：启动时在地址栏加 ?safe=1，或把 localStorage 的 coomi.safe.v1 设成 1
                （界面卡到点不动设置页时，那两条还走得通）。 */}
            <Cell
              label={<span className='flex items-center gap-2'><LifeBuoy size={14} className='text-ink-3' /> 安全模式</span>}
              hint={ui.prefs.safeMode
                ? '已开启：动效、富预览、语法高亮与长列表虚拟化都关了，只画纯文本 —— 卡死时自救用'
                : '界面卡死 / 一卡一顿时打开：关掉动效、富预览、语法高亮与虚拟化，只画纯文本'}
            >
              <Switch checked={ui.prefs.safeMode} onCheckedChange={(v) => ui.setPrefs({ safeMode: v })} />
            </Cell>
            <Cell
              label={<span className='flex items-center gap-2'><Shield size={14} className='text-ink-3' /> 任务放行程度</span>}
              hint={PERMISSION_LABELS.find((p) => p.value === agent.permission)?.hint}
            >
              <Segmented<PermissionMode>
                value={agent.permission}
                onChange={(v) => void agent.setPermission(v)}
                options={PERMISSION_LABELS.map((p) => ({ value: p.value, label: p.label }))}
              />
            </Cell>
            {agent.permission === 'full' ? (
              <p className='px-1 pb-2 text-12 text-warn'>完全放行后 Agent 不再停下询问，包含删除类操作——只建议在你完全信任当前任务时使用。</p>
            ) : null}
            <Cell label='关闭窗口时最小化到托盘' hint='后台继续运行引擎与正在跑的任务；从托盘图标可以再打开或退出'>
              <Switch
                checked={desktopPrefs.closeToTray}
                onCheckedChange={(v) => {
                  setDesktopPrefs((prev) => ({ ...prev, closeToTray: v }))
                  void ipc('set_close_to_tray', { enabled: v }).catch(() => setDesktopPrefs((prev) => ({ ...prev, closeToTray: !v })))
                }}
              />
            </Cell>
            <Cell label='开机自动启动' hint='登录后在后台启动 Coomi（不弹出窗口，直接进托盘）'>
              <Switch
                checked={desktopPrefs.autostart}
                onCheckedChange={(v) => {
                  setDesktopPrefs((prev) => ({ ...prev, autostart: v }))
                  void ipc<boolean>('set_autostart', { enabled: v })
                    .then((ok) => setDesktopPrefs((prev) => ({ ...prev, autostart: ok ? v : !v })))
                    .catch(() => setDesktopPrefs((prev) => ({ ...prev, autostart: !v })))
                }}
              />
            </Cell>
          </StaggerGrid>
          </Section>

          <Section className={group === 'appearance' ? '' : 'hidden'} title='外观' description='主题、字号、密度与消息栏宽度。'>
          <StaggerGrid>
            <Cell label='字体' hint='默认内置 HarmonyOS Sans SC；系统字体更省内存'>
              <Segmented<'harmony' | 'system'>
                value={ui.prefs.fontFamily}
                onChange={(v) => ui.setPrefs({ fontFamily: v })}
                options={[{ value: 'harmony', label: 'HarmonyOS Sans' }, { value: 'system', label: '系统字体' }]}
              />
            </Cell>
            <Cell label='主题' hint='跟随系统会随 Windows 深浅色切换'>
              <Segmented<ThemeMode>
                value={ui.themeMode}
                onChange={(v) => ui.setThemeMode(v)}
                options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]}
              />
            </Cell>
            {/* 插件主题：有「已启用且带主题」的插件才显示这一行；选「默认」恢复内置主题。 */}
            {pluginThemes.length ? (
              <Cell
                label='插件主题'
                hint='插件提供的整套配色与圆角令牌；切换立即生效，选「默认」恢复内置主题。'
              >
                <Select
                  value={activePluginThemeId ?? '__default__'}
                  width={190}
                  onChange={(v) => setPluginTheme(v === '__default__' ? null : v)}
                  options={[
                    { value: '__default__', label: '默认（无插件主题）' },
                    ...pluginThemes.map((p) => ({ value: p.id, label: pluginName(p) })),
                  ]}
                />
              </Cell>
            ) : null}
            {/* 界面字号：写进 <html> 的 --ui-font-scale（stores/ui.ts 的 setFontScale），
                即时生效并落 localStorage（键 coomi.fontScale）——与主题 / 字体 / 密度同一条路。
                默认「较大」(1.08)：theme.css 的 --ui-font-scale 默认值同样是 1.08（12px→约 13、13px→约 14）。
                旧存档里的 0.92 / 1.16 由 nearestFontScale 归到最近档显示，不悄悄改用户落盘的值。 */}
            <Cell label='界面字号' hint='全局缩放，中英文一起变；改完立即生效并记住'>
              <Segmented<string>
                value={String(nearestFontScale(ui.fontScale))}
                onChange={(v) => ui.setFontScale(Number(v))}
                options={UI_FONT_SCALES.map((o) => ({ value: String(o.value), label: o.label }))}
              />
            </Cell>
            <Cell label='界面密度' hint='控制页面留白与行高'>
              <Segmented<Density>
                value={ui.prefs.density}
                onChange={(v) => ui.setPrefs({ density: v })}
                options={[{ value: 'compact', label: '紧凑' }, { value: 'cozy', label: '舒适' }]}
              />
            </Cell>
            <MessageWidthField
              wide
              mode={ui.prefs.messageWidthMode}
              width={ui.prefs.messageWidth}
              onMode={(m) => ui.setPrefs({ messageWidthMode: m })}
              onWidth={(px) => ui.setPrefs({ messageWidth: px, messageWidthMode: 'fixed' })}
            />
            <Cell label='界面动效' hint='关闭后所有过渡与动画立即完成'>
              <Switch checked={ui.prefs.motion} onCheckedChange={(v) => ui.setPrefs({ motion: v })} />
            </Cell>
            {/* 空态文案轮换：只影响「新对话」首屏那句话（每 14 秒换一组，上下翻页式切换）。
                开关落在 coomi.rotateCopy.v1，写完立刻通知已挂载的空态（见 lib/rotateCopy.ts）。 */}
            <Cell label='空态文案轮换' hint={rotateCopy ? '新对话首屏那句标题每 14 秒上下翻页换一组' : '已关闭：首屏那句标题固定不动'}>
              <Switch
                checked={rotateCopy}
                onCheckedChange={(v) => { writeRotateCopyEnabled(v); setRotateCopy(v) }}
              />
            </Cell>
            {/* 性能模式：字段是 stores/ui.ts 的 prefs.perf（'high' | 'low'，默认 high）。
                打开＝省电档：html[data-perf=low]，毛玻璃、点阵循环动效与设置页错峰都收掉，
                长会话也更早交给虚拟列表。整档只认这一处开关，组件不各存一份。 */}
            <Cell
              label='性能模式'
              hint={ui.prefs.perf === 'low'
                ? '省电档已开启：关毛玻璃与点阵动效、长会话更早虚拟化'
                : '机器吃紧或要省电时打开：关毛玻璃与点阵动效、长会话更早虚拟化'}
            >
              <Switch
                checked={ui.prefs.perf === 'low'}
                onCheckedChange={(v) => ui.setPrefs({ perf: v ? 'low' : 'high' })}
              />
            </Cell>
          </StaggerGrid>
          </Section>

          {/* 插件中心已移到左侧导航栏（Rail → 插件 图标），设置页不再内嵌。 */}

          <Section
            className={group === 'models' ? '' : 'hidden'}
            title='模型与 Provider'
            description='OpenAI 兼容接口；当前使用的 Provider 决定对话走哪条链路。'
            actions={<Button variant='ghost' size='sm' onClick={() => void loadProviders()}><RefreshCw size={13} /> 刷新</Button>}
          >
            {/* 这块是整块内容，不能塞进 StaggerGrid（那是两列网格，会被压成半列宽的竖条）。 */}
            <div
              className={cn('@container flex min-w-0 flex-col gap-3 px-5 py-4', group === 'models' ? '' : 'hidden')}
              data-testid='providers-panel'
            >
              <div className='grid min-w-0 grid-cols-1 gap-2.5 @2xl:grid-cols-3' data-testid='providers-top'>
                {/* 三张并列卡：思考强度 / 单轮工具上限 / 添加厂商。
                    每张外面包一层 Stagger：跟着分组入场一起 20ms 错峰。 */}
                <Stagger>
                <div className='card-lift flex flex-col justify-between rounded-xl border border-line bg-surface elev-1 p-4'>
                  <div className='flex items-center gap-1.5 text-12 text-ink-3'><Brain size={13} /> 思考强度</div>
                  <div className='mt-2 text-18 font-semibold text-ink'>{EFFORT_LABELS.find((e) => e.value === agent.effort)?.label ?? '自动'}</div>
                  <p className='mt-1 text-11 text-ink-4'>{EFFORT_LABELS.find((e) => e.value === agent.effort)?.hint}</p>
                  <div className='mt-3 flex flex-wrap gap-1'>
                    {EFFORT_LABELS.map((e) => (
                      <button
                        key={e.value}
                        type='button'
                        onClick={() => void agent.setEffort(e.value as ReasoningEffort)}
                        className={
                          'h-6 rounded-md border px-2 text-11 transition-colors ' +
                          (e.value === agent.effort ? 'border-primary/40 bg-primary-soft text-primary' : 'border-line text-ink-3 hover:text-ink')
                        }
                      >
                        {e.label}
                      </button>
                    ))}
                  </div>
                </div>
                </Stagger>
                <Stagger>
                <div className='card-lift flex flex-col justify-between rounded-xl border border-line bg-surface elev-1 p-4'>
                  <div className='flex items-center gap-1.5 text-12 text-ink-3'><Wrench size={13} /> 单轮最大工具调用次数</div>
                  <div className='mt-2 flex items-baseline gap-2'>
                    <Input
                      className='h-9 w-[96px] text-15'
                      type='number'
                      value={agent.maxToolRounds}
                      onChange={(e) => void agent.setMaxToolRounds(Number(e.target.value))}
                    />
                    <span className='text-11 text-ink-4'>1–512</span>
                  </div>
                  <p className='mt-2 text-11 text-ink-4'>复杂任务可调高；过高会让一轮跑很久。</p>
                </div>
                </Stagger>
                <Stagger>
                <button
                  type='button'
                  onClick={() => setAdding(true)}
                  className='card-lift flex flex-col items-start justify-center gap-2 rounded-xl border border-dashed border-primary/40 bg-primary-soft p-4 text-left'
                >
                  <span className='flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white'><Plus size={18} /></span>
                  <span className='text-14 font-medium text-primary'>添加厂商</span>
                  <span className='text-11 text-primary/70'>选接口类型 → 填地址与 API Key → 获取模型</span>
                </button>
                </Stagger>
              </div>

              {/* 厂商：按列排布，卡片可编辑；容器窄了自动回落到单列，不挤压卡片 */}
              <div className='grid min-w-0 grid-cols-1 gap-2.5 @2xl:grid-cols-2' data-testid='providers-grid'>
              {providers.map((p) => {
                const models = modelMap[p.id] ?? []
                return (
                  <Stagger key={p.id}>
                  <div data-testid='provider-card' className='card-lift min-w-0 rounded-xl border border-line bg-surface elev-1 p-4'>
                    {/* 卡片头三列栅格：图标 / 可压缩文本列 / 固定操作列。
                        中间列必须写 minmax(0,1fr) 而不是 1fr——少了 min-width:0，
                        长厂商名会把右侧按钮顶出卡片边框。 */}
                    <div className='grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3'>
                      <span className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary'>
                        <Server size={16} />
                      </span>
                      <div className='min-w-0'>
                        <div className='flex min-w-0 items-center gap-2'>
                          <span className='truncate text-14 font-medium text-ink' title={p.name || p.id}>{p.name || p.id}</span>
                          {p.active ? <Badge tone='primary' className='shrink-0'>当前</Badge> : null}
                        </div>
                        <div className='mt-0.5 break-all font-mono text-11 text-ink-4' title={p.baseUrl || undefined}>{p.baseUrl || '—'}</div>
                      </div>
                      <div className='flex shrink-0 items-center gap-1.5'>
                        {/* 这里不再提供“选择默认模型”：用哪个模型完全在对话页选。 */}
                        <Button variant='primary' size='sm' onClick={() => setEditingProvider({ id: p.id, name: p.name, model: p.model, type: p.type, baseUrl: p.baseUrl, models: p.models, modelContextWindows: p.modelContextWindows, modelDescriptions: p.modelDescriptions, modelParameters: p.modelParameters, capabilityOverrides: p.capabilityOverrides })}>编辑</Button>
                        <Button variant='ghost' size='icon-sm' className='text-ink-3 hover:text-danger' title='删除厂商' onClick={() => void engine.api('/api/providers/' + encodeURIComponent(p.id), { method: 'DELETE' })
                          .then(() => { void loadProviders(); useAgent.getState().bumpProviders() })
                          .catch(() => flash('删除失败'))}>
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </div>
                    <div className='mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line-soft pt-2.5 text-11 text-ink-4'>
                      <span className='shrink-0 rounded bg-sunken px-1.5 py-0.5'>
                        {p.type === 'openai_compatible' ? 'OpenAI 兼容' : (p.type || '未标注类型')}
                      </span>
                      <span className='min-w-0 break-all font-mono' title={p.id}>{p.id}</span>
                      <span className='ml-auto shrink-0 whitespace-nowrap'>{models.length ? models.length + ' 个模型' : '暂无模型'}</span>
                    </div>
                  </div>
                  </Stagger>
                )
              })}
              </div>
              {/* 首屏加载：接口回来之前铺行骨架，别让模型分组空着一块 */}
              {providersPending && !providers.length ? <SkeletonRows rows={4} className='px-1' /> : null}
              {!providers.length && !providersPending ? (
                <Cell label='还没有 Provider' hint='添加一个 OpenAI 兼容接口即可开始对话' />
              ) : null}
            </div>
          </Section>

          <Section className={group === 'workspace' ? '' : 'hidden'} title='工作区' description='新会话默认落在哪个目录。'>
          <StaggerGrid>
            <Cell
              label='默认工作目录'
              hint={<span className='block break-all font-mono' title={rawCwd || undefined}>{defaultCwd || '—'}</span>}
            >
              <Menu
                align='end'
                items={[
                  ...(recent.length ? recent.map((d) => ({ label: shortPath(d, 40), onSelect: () => { void session.applyCwd(d); flash('已切换默认目录') } })) : []),
                  ...(recent.length ? [{ divider: true }] : []),
                  { label: '恢复引擎默认', onSelect: () => { session.rememberCwd(''); if (engine.cwd) void session.applyCwd(engine.cwd).catch(() => {}) } },
                ]}
                trigger={<Button variant='secondary' size='sm'>最近目录</Button>}
              />
              <Button variant='primary' size='sm' onClick={() => void pickDefaultCwd()}><FolderOpen size={13} /> 更改</Button>
            </Cell>
            <Cell label='在资源管理器中打开' hint='当前默认工作目录的实际位置'>
              <Button variant='ghost' size='sm' disabled={!defaultCwd} onClick={() => void ipc('open_path', { path: defaultCwd })}>打开</Button>
            </Cell>
            <Cell label='最近使用过的目录' hint={recent.length ? undefined : '还没有记录'}>
              <span className='text-12 text-ink-4'>{recent.length} 个</span>
            </Cell>
          </StaggerGrid>
          </Section>

          <Section className={group === 'ai' ? '' : 'hidden'} title='AI 能力' description='每一项都能单独开关；关闭立即生效，情感类默认关闭以免影响输出风格。'>
          <StaggerGrid>
            {([
              ['memory', '长期记忆', '跨会话记住事实与偏好，相关时自动注入'],
              ['memoryWrite', '记忆写入', '关闭后只读不写，不再记录新记忆'],
              ['memoryAutoInject', '自动注入', '关闭后 AI 仍可主动检索记忆'],
              ['memoryVector', '向量检索', '关闭后退回关键词匹配'],
              ['compression', '上下文压缩', '接近上限时自动压缩历史'],
              ['autoPinMilestones', '自动钉住里程碑', '关键结论不参与压缩'],
              ['promptLayering', '提示词分层', '按层组装系统提示，各自独立预算'],
              ['skillOnDemand', '技能按需注入', '只在相关时注入技能，避免瞎用'],
              ['toolEnhance', '工具质量增强', '参数校验 / 失败重试 / 结果裁剪 / 缓存'],
              ['trustGate', '信任驱动放行', '连续成功自动升级放行，失败回落询问'],
              ['emotionTone', '情绪语气适配', '让回复语气随情绪与羁绊变化（默认关）'],
              ['persona', '人格注入', '把人格描述写进系统提示（默认关）'],
              ['subagents', '子代理', '允许主 AI 派发一对一子代理任务'],
              ['notifyGuard', '后台通知护栏', '尊重免打扰时段与每日上限'],
              ['backgroundNotify', '后台完成提醒', '窗口不在前台时，一轮回复结束后提醒你'],
              ['askUser', '反问澄清', '信息不足时让 AI 先问一句，而不是自己猜着做'],
              ['showArtifacts', '生成物卡片', '一轮结束后在回复下方列出本轮产出的文件（点开预览，右键另存）；关掉只是不显示这排卡片'],
              ['allowSaveAsRequest', '允许另存为', '产物卡片与预览面板里出现「另存为…」，点击会弹系统保存对话框（默认关，避免打断）'],
              ['metrics', '开发者度量', '本地记录质量指标（不上传）'],
            ] as Array<[keyof Capabilities, string, string]>).map(([key, label, hint]) => (
              <Cell key={key} label={label} hint={hint}>
                <Switch checked={Boolean(caps[key])} onCheckedChange={(v) => setCaps({ [key]: v } as Partial<Capabilities>)} />
              </Cell>
            ))}
            {/* ── 本地留痕（trajectory.jsonl）──
                两个键都在 settings.json 的 capabilities 块里，引擎侧字段是 local_trace_enabled /
                local_trace_max_mb（见 apps/coomi-rs/ui/src/web/mod.rs 的 CapabilitySettings）。
                读写与上面每一个开关完全同一条路：useCapabilities.set() → 先本地乐观生效 + 落
                localStorage，再把**变化的键** PUT 到 /api/agent/preferences（失败回滚）。
                默认「开 + 不限」：默认不限制增长，想控体积、或想彻底不留痕，再动下面这两项。 */}
            <Cell
              label='本地留痕'
              hint={caps.localTraceEnabled
                ? '开启中（默认）：每轮任务在本机落一行 trajectory.jsonl，是「越用越好用」的素材；只存本机、不上传'
                : '已关闭：引擎不再写本地轨迹文件（trajectory.jsonl）'}
            >
              <Switch checked={caps.localTraceEnabled} onCheckedChange={(v) => setCaps({ localTraceEnabled: v })} />
            </Cell>
            <Cell
              label='留痕体积上限'
              hint={caps.localTraceMaxMb > 0
                ? '已设为 ' + caps.localTraceMaxMb + ' MB 上限（引擎侧有效范围 1~4096）'
                : '不限（默认）：不限制增长；想给轨迹文件设个天花板时再选一档'}
            >
              <Segmented<string>
                value={String(caps.localTraceMaxMb ?? 0)}
                onChange={(v) => setCaps({ localTraceMaxMb: Number(v) })}
                options={traceMaxOptions(caps.localTraceMaxMb ?? 0)}
              />
            </Cell>
            <Cell label='压缩触发阈值' hint='上下文占用超过该比例时压缩（0.5–0.95）'>
              <Input
                className='h-8 w-[92px]'
                type='number'
                step='0.05'
                value={caps.compressionThreshold}
                onChange={(e) => setCaps({ compressionThreshold: Number(e.target.value) })}
              />
            </Cell>
            <Cell label='子代理并发上限' hint='0–5；设 0 等同关闭子代理'>
              <Input
                className='h-8 w-[92px]'
                type='number'
                value={caps.subagentConcurrency}
                onChange={(e) => setCaps({ subagentConcurrency: Number(e.target.value) })}
              />
            </Cell>
            {/* 提问等待超时：AI 停下来问你之后，多久没人理它就自动按「跳过」收掉这一问。
                「一直等」是默认档 —— 自动替用户跳过提问，比多等一会儿更让人意外。
                引擎还没上报这个键时只落在本地 localStorage，所以这里显式标注「仅本地」。 */}
            <Cell
              label='提问等待超时'
              hint={
                <>
                  等待回答超过这个时长就自动跳过，不让整轮对话干等
                  {engineReady ? null : <span className='ml-1.5 rounded bg-sunken px-1.5 py-0.5 text-11 text-ink-4'>仅本地 · 引擎未就绪</span>}
                </>
              }
            >
              <Segmented<string>
                value={String(caps.askUserTimeoutMinutes ?? 0)}
                onChange={(v) => setCaps({ askUserTimeoutMinutes: Number(v) })}
                options={[
                  { value: '0', label: '一直等' },
                  { value: '5', label: '5 分钟' },
                  { value: '15', label: '15 分钟' },
                  { value: '60', label: '60 分钟' },
                ]}
              />
            </Cell>
          </StaggerGrid>
          </Section>

          {/* 上下文压缩：跟在「AI 能力」分组后面的一小节，只在这一组显示（自己拉引擎有效值）。 */}
          <CompactionPanel active={group === 'ai'} />

          {/* 经验库：同样挂在「AI 能力」分组下、紧跟着「长期记忆」那一格 —— 那里只管记不记，
              这里才能看到记住了什么、效果如何、要不要删掉。只在这一组显示（active 时才去拉数据）。 */}
          <MemoryLessonsPanel active={group === 'ai'} />

          {/* 任务轨迹：trajectory.jsonl 的回放 —— 每轮跑了什么、成没成、卡在哪。
              与旁边几块同一套时机：只在这一组显示，active 时才去拉数据。 */}
          <TrajectoryPanel active={group === 'ai'} />

          <Section className={group === 'life' ? '' : 'hidden'} title='数字生命体' description='常驻伙伴的主动问候与免打扰策略。'>
          <StaggerGrid>
            <Cell label='启用数字生命体' hint='拥有情绪、羁绊与长期记忆的常驻伙伴'>
              {/* 载入时用同尺寸的骨架占位（开关形状），而不是一个小转圈把行高顶来顶去 */}
              {lifeBusy || !life
                ? <Skeleton className='h-[22px] w-[38px] rounded-full' />
                : <Switch checked={!!life.enabled} onCheckedChange={(v) => void patchLife({ enabled: v })} />}
            </Cell>
            <Cell label='每日主动上限' hint='控制一天最多主动找你几次'>
              <Segmented<string>
                value={life?.dailyMode ?? 'auto'}
                onChange={(v) => void patchLife({ dailyMode: v })}
                options={[{ value: 'off', label: '不主动' }, { value: 'auto', label: '自动' }, { value: 'custom', label: '自定义' }]}
              />
            </Cell>
            {life?.dailyMode === 'custom' ? (
              <Cell label='自定义条数' hint='每天 1–100 条'>
                <Input
                  className='h-7 w-20'
                  type='number'
                  value={life.dailyLimitCustom}
                  onChange={(e) => void patchLife({ dailyLimitCustom: Number(e.target.value) })}
                />
              </Cell>
            ) : null}
            <Cell label='免打扰时段' hint='这段时间内不会主动打扰你'>
              <span className='font-mono text-12 text-ink-2'>
                {hhmm(life?.windowStartMinutes ?? 540)} – {hhmm(life?.windowEndMinutes ?? 1380)}
              </span>
            </Cell>
            <Cell label='用在所有对话' hint='关闭时只有常驻会话使用数字生命体人格'>
              <Switch checked={!!life?.globalMode} onCheckedChange={(v) => void patchLife({ globalMode: v })} />
            </Cell>
          </StaggerGrid>
          </Section>

          <Section className={group === 'engine' ? '' : 'hidden'} title='引擎与诊断' description='后台引擎进程的状态与维护。'>
          <StaggerGrid>
            <Cell
              label='运行状态'
              hint={<span className='block break-all font-mono'>{engine.status === 'running' ? '运行中 · 端口 ' + engine.port : engine.status === 'starting' ? '启动中' : engine.status === 'stopped' ? '已停止' : '异常：' + (engine.lastError || '未知')}</span>}
            >
              {/* 两个重启不一样：引擎重启只重启后台进程（会话自动恢复）；
                  应用重启会退出重开——装了 Node / uv / winget 之后必须是这一档，PATH 才会刷新。 */}
              <Button variant='ghost' size='sm' title='只重启后台引擎进程：当前会话会自动恢复' onClick={() => void restartEngineNow()}>重启引擎</Button>
              <Button variant='ghost' size='sm' title='退出并重新打开 Coomi：装了运行环境（PATH 变了）时用这一档' onClick={() => void restartAppNow()}>重启应用</Button>
              <Button variant='ghost' size='sm' className='text-ink-3 hover:text-danger' onClick={() => void engine.stop()}>停止</Button>
            </Cell>
            {/* 崩溃恢复方式：默认「一键继续」（恢复完提示，用户点了才接着跑），
                另一档「自动继续」＝恢复完直接接着跑。存 ui.prefs。 */}
            <Cell
              label='崩溃后恢复方式'
              hint={ui.prefs.crashRecovery === 'auto'
                ? '引擎崩溃并重启后，自动把被打断的那一轮接着跑完'
                : '引擎崩溃并重启后先提示一句，由你点「继续」再接着跑'}
            >
              <Segmented<CrashRecoveryMode>
                value={ui.prefs.crashRecovery}
                onChange={(v) => ui.setPrefs({ crashRecovery: v })}
                options={[{ value: 'manual', label: '一键继续' }, { value: 'auto', label: '自动继续' }]}
              />
            </Cell>
            <Cell label='引擎版本' hint={<span className='font-mono'>{engine.version || '—'}</span>} />
            <Cell label='数据目录' hint={<span className='block break-all font-mono' title={dataHome || undefined}>{dataHome ? shortPath(dataHome, 52) : '—'}</span>}>
              <Button variant='ghost' size='sm' disabled={!dataHome} onClick={() => void ipc('open_path', { path: dataHome })}>打开</Button>
            </Cell>
            <Cell label='引擎日志' hint='查看引擎运行日志的末尾 300 行（只读）'>
              <Button variant='ghost' size='sm' onClick={() => setLogOpen(true)}>查看引擎日志</Button>
              <Button variant='ghost' size='sm' className='text-ink-3' onClick={() => void ipc<string | null>('engine_log_path').then((p) => { if (p) void ipc('open_path', { path: p }) }).catch(() => flash('日志文件打开失败'))}>所在文件夹</Button>
            </Cell>
            <Cell label='崩溃日志' hint={<span className='block break-all font-mono' title={logPath || undefined}>{logPath ? shortPath(logPath, 52) : '暂无'}</span>}>
              <Button variant='ghost' size='sm' disabled={!logPath} onClick={() => void ipc('open_path', { path: logPath })}>打开</Button>
            </Cell>
            <Cell label='维护' hint='备份会话与配置，或清理缓存（不影响会话）'>
              <Button
                variant='ghost' size='sm'
                onClick={() => void engine.api('/api/backup/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => flash('备份已创建')).catch(() => flash('备份失败'))}
              >创建备份</Button>
              <Button
                variant='ghost' size='sm'
                onClick={() => {
                  if (ui.prefs.confirmDanger && !window.confirm('清理缓存？会话记录不会被删除。')) return
                  void engine.api('/api/maintenance/clean', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => flash('清理完成')).catch(() => flash('清理失败'))
                }}
              >清理缓存</Button>
            </Cell>
          </StaggerGrid>
          </Section>

          {/* 两个数据面板：跟着分组一起挂载/隐藏，切到「引擎与诊断」时才各自去拉数据。 */}
          <MirrorPanel active={group === 'engine'} />
          <StoragePanel active={group === 'engine'} />

          <DeveloperPanel active={group === 'engine'} />

          <Section className={group === 'about' ? '' : 'hidden'} title='关于' description='版本、许可与项目信息。'>
          <StaggerGrid>
            <Cell wide className='items-start'>
              <div className='flex w-full items-start gap-4'>
                <img src={logo} alt='Coomi' className='h-14 w-14 rounded-2xl object-contain' />
                <div className='min-w-0 flex-1'>
                  <div className='flex items-center gap-2'>
                    <span className='text-16 font-semibold text-ink'>Coomi Desktop</span>
                    <span className='flex h-[20px] items-center rounded-full border border-warn/40 bg-warn-soft px-2 text-11 font-semibold tracking-[0.06em] text-warn'>BETA</span>
                  </div>
                  <div className='mt-0.5 font-mono text-12 text-ink-3'>Beta {clientVersion} · build {localDateStamp()}</div>
                  <p className='mt-2 max-w-[520px] text-12 leading-[1.6] text-ink-3'>
                    本地优先的智能体桌面端：引擎与数据都在你的机器上，模型通过你自己的 Provider 接入。
                  </p>
                </div>
              </div>
            </Cell>
            <Cell label='客户端版本' hint='当前安装的版本'><span className='font-mono text-12 text-ink-2'>Beta {clientVersion}</span></Cell>
            <Cell label='引擎版本' hint={<span className='font-mono text-12'>{engine.version || '—'}</span>} />
            {/* 检查更新：真调壳命令 update_check（壳读发布服务 /api/v1/info），失败给可读原因。 */}
            <Cell
              label='检查更新'
              hint={update.status === 'checking'
                ? '正在请求发布服务…'
                : update.status === 'error'
                  ? '检查失败：' + (update.error || '未知原因')
                  : update.status === 'done'
                    ? (updateReport?.hasUpdate
                      ? '有新版本：' + (updateReport?.latest ?? '') + '（当前 ' + (updateReport?.current ?? '') + '）'
                      : '已是最新版本（' + (updateReport?.current ?? '') + '）')
                    : '只查询版本信息，不上传任何本地数据'}
            >
              <Button variant='secondary' size='sm' disabled={update.status === 'checking'} onClick={() => void checkUpdate()}>
                {update.status === 'checking' ? <Spinner /> : <RefreshCw size={13} />} 检查更新
              </Button>
              {update.status === 'done' && updateReport?.hasUpdate && updateReport.downloadUrl ? (
                <>
                  <Button
                    variant='primary'
                    size='sm'
                    disabled={installing}
                    onClick={() => void installUpdate()}
                  >
                    {installing ? <Spinner /> : <Download size={13} />} {installing ? '正在更新…' : '一键更新'}
                  </Button>
                  {/* 一键更新失败 / 想自己下：浏览器那条路留着当兜底。 */}
                  <Button
                    variant='ghost'
                    size='sm'
                    disabled={installing}
                    title='用浏览器下载安装包（一键更新出问题时用）'
                    onClick={() => void ipc('open_external', { url: updateReport?.downloadUrl ?? '' })}
                  >
                    手动下载
                  </Button>
                </>
              ) : null}
            </Cell>
            {/* 一键更新进度：下载（带速度）/ 校验 / 安装三段都写在这里，失败原因也写在这里。 */}
            {updatePhase ? (
              <Cell wide className='items-start'>
                <div className='w-full min-w-0 text-12 leading-[1.7]'>
                  <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
                    <span className={updatePhase.tone === 'error' ? 'text-danger' : 'text-ink-2'}>
                      {updatePhase.tone === 'error' ? <AlertTriangle size={12} className='mr-1 inline align-[-2px]' /> : null}
                      {updatePhase.text}
                    </span>
                    {updateProgress ? (
                      <span className='font-mono text-11 text-ink-4'>
                        {percentNumber(updateProgress) ? percentNumber(updateProgress) + '%' : '下载中'} · {fmtBytes(updateProgress.got)}{updateProgress.speed ? ' · ' + fmtBytes(updateProgress.speed) + '/s' : ''}
                      </span>
                    ) : null}
                  </div>
                  {/* 下载进度条：总大小未知时用不确定态（继续滚动的条），不假装知道百分比。 */}
                  {updateProgress ? (
                    <div className='mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-sunken'>
                      <div
                        className='h-full rounded-full bg-primary transition-[width] duration-300'
                        style={{ width: percentNumber(updateProgress) ? percentNumber(updateProgress) + '%' : '100%' }}
                      />
                    </div>
                  ) : null}
                </div>
              </Cell>
            ) : null}
            <Cell label='制作人' hint={<span className='font-mono text-12 text-ink-2'>星奈_Star</span>} />
            {/* 更新详情：只在真的拿到结果之后出现，缺什么显示什么（说明缺失时壳已给出兜底文案）。 */}
            {update.status === 'done' ? (
              <Cell wide className='items-start'>
                <div className='w-full min-w-0 text-12 leading-[1.7] text-ink-3'>
                  <div className='flex flex-wrap items-center gap-x-4 gap-y-1'>
                    <span>当前版本 <span className='font-mono text-ink-2'>{updateReport?.current || '—'}</span></span>
                    <span>最新版本 <span className='font-mono text-ink-2'>{updateReport?.latest || '—'}</span></span>
                    <span>安装包 <span className='font-mono text-ink-2'>{updateReport?.size ? fmtBytes(updateReport.size) : '未知'}</span></span>
                    {updateReport?.publishedAt ? <span>发布时间 <span className='font-mono text-ink-2'>{updateReport.publishedAt}</span></span> : null}
                  </div>
                  <p className='mt-1 whitespace-pre-wrap break-words'>
                    更新说明：{updateReport?.notes || '服务端未提供更新说明'}
                  </p>
                </div>
              </Cell>
            ) : null}
            <Cell wide className='items-start'>
              <div className='w-full min-w-0 text-12 leading-[1.7] text-ink-3'>
                <span className='font-medium text-ink-2'>开源说明：</span>
                Coomi Desktop 源码公开在 GitHub 仓库 TensorHub-ORG/Coomi 的 coomi-desktop 分支（当前仍是 Beta 测试版，欢迎围观与自建）。问题反馈欢迎通过本页与帮助中心。
              </div>
            </Cell>
            <Cell label='数据目录' hint={<span className='block break-all font-mono text-12' title={dataHome || undefined}>{shortPath(dataHome, 46) || '—'}</span>}>
              <Button variant='ghost' size='sm' disabled={!dataHome} onClick={() => void ipc('open_path', { path: dataHome })}>打开</Button>
            </Cell>
            <Cell label='运行日志' hint={<span className='block break-all font-mono text-12' title={logPath || undefined}>{logPath ? shortPath(logPath, 46) : '暂无'}</span>}>
              <Button variant='ghost' size='sm' disabled={!logPath} onClick={() => void ipc('open_path', { path: logPath })}>打开</Button>
            </Cell>
            <Cell label='隐私与使用说明' hint='三步看完：这是什么、数据与隐私、权限与风险；内容有更新时会在启动时再提示一次'>
              <Button variant='ghost' size='sm' onClick={() => openOnboarding()}>再看一次</Button>
            </Cell>
            <Cell label='字体与许可' hint='内置 HarmonyOS Sans SC（华为，免费商用），许可随包分发'>
              <Button variant='ghost' size='sm' onClick={() => flash('许可文件：安装目录 / fonts / LICENSE-HarmonyOS-Sans.txt')}>查看说明</Button>
            </Cell>
            <Cell wide>
              <div className='flex w-full flex-wrap items-center gap-x-6 gap-y-2 text-12 text-ink-3'>
                <span className='flex items-center gap-1.5'><Shield size={13} className='text-ink-4' /> 数据不出本机：会话、记忆、密钥都存本地</span>
                <span className='flex items-center gap-1.5'><Brain size={13} className='text-ink-4' /> 记忆与上下文可随时清空</span>
                <span className='flex items-center gap-1.5'><RefreshCw size={13} className='text-ink-4' /> Beta 期间欢迎反馈问题</span>
              </div>
            </Cell>
          </StaggerGrid>
          </Section>
          </div>
          </GroupTransition>
        </div>
      </div>
      <EngineLogDialog open={logOpen} onOpenChange={setLogOpen} />
      <ProviderWizard
        open={adding || !!editingProvider}
        onOpenChange={(open) => { if (!open) { setAdding(false); setEditingProvider(null) } }}
        editing={editingSnapshot}
        // 新建时的标识自动避重：把已有 id 交给向导（它按名称生成，撞了就加后缀）。
        existingIds={providerIds}
        onSaved={() => {
          void loadProviders()
          // 广播给对话页与其它消费方：新增/修改厂商后，它们手里那份 providers 已经过期
          //（以前只有设置页刷新自己，回到对话页就被判成「还没有配置模型」）。
          useAgent.getState().bumpProviders()
        }}
      />
    </main>
  )
}