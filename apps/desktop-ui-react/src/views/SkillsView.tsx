import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, RefreshCw, Search, Terminal, Trash2, Wrench, X } from 'lucide-react'
import { AnimatedNumber } from '../components/ui/Number'
import { cn } from '../lib/cn'
import { motionOn } from '../lib/motionPref'
import { useEngine } from '../stores/engine'
import { useLibrary, type CatalogEntry } from '../stores/library'
import { PageHeader, Empty, STAGGER_STEP_MS } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, Badge } from '../components/ui/Input'
import { Segmented, SkeletonCard, SkeletonRows, Spinner, SwapIn, Switch } from '../components/ui/Controls'
// 首帧壳闸门：这一帧过去之前只画外壳（骨架），整棵舞台（工具条 + 左轨 + 卡片网格）挪到下一帧。
import { useFirstFrame } from '../components/ui/firstFrame'
// 注：AI 状态动效（AgentState）由 components/ai/AgentState.tsx 提供，本页此刻还没有该文件，
// 因此「加载中」一律先用骨架屏（SkeletonCard / SkeletonRows）占位。
// TODO(components/ai/AgentState)：等它落地后，把这里的骨架换成 <AgentState state="running" size="sm" />。
import { Dialog } from '../components/ui/Overlay'
import { catalogCategory, catalogIcon, CATALOG_CATEGORIES } from '../components/skills/catalogMeta'
import { RemoteMcpBrowser, type RemoteInstalledEcho } from '../components/skills/RemoteMcpBrowser'
import { McpLaunchEditor } from '../components/skills/McpLaunchEditor'
import { SkillMarketBrowser } from '../components/skills/SkillMarketBrowser'
import { REMOTE_SOURCES, type RemoteEntry, type RemoteSourceKey } from '../components/skills/remoteSources'
import { RuntimeBar } from '../components/skills/RuntimeBar'
import { RuntimeHelpDialog } from '../components/skills/RuntimeHelpDialog'
import { RuntimeInstallDialog } from '../components/skills/RuntimeInstallDialog'
import { ChainInstallDialog, EMPTY_TOOL_OUTCOME, type ToolInstallOutcome } from '../components/skills/ChainInstallDialog'
import { waitInstallTask } from '../components/skills/installClient'
import { TaskBoard } from '../components/skills/TaskBoard'
import { InstallParamsDialog, parameterHelp } from '../components/skills/InstallParamsDialog'
import {
  entryRuntimeIds, helpTargetFor, matchRuntimeIds, runtimeLabel, runtimeStatusFor, type RuntimeHelpTarget,
} from '../components/skills/runtimeMeta'

/* ── 四个视图：市场 / 已安装 / 远程源 / 任务，外加「方向性」切换 ──
   stores/ui.ts 的 ViewKey 只有 chat / skills / artifacts / settings 四个值，外壳的导航栏、
   命令面板、设置里的「默认页」全都按它排；把子页提升成新的 ViewKey，要同时改 App 的
   VIEW_ORDER / PAGE / VIEW_CHUNK、Rail、CommandPalette 与默认页偏好，代价远大于收益。
   所以这里选了**同一视图内可分页到达的四个子视图**：顶部一条分段控件（就是那枚会滑动的
   指示器）+ 面包屑说明「现在在哪一层」，四者之间共用同一套 8px 方向性过渡；
   它们仍然只是导航栏上「技能中心」这一页，不改任何顶层导航。 */
type SubView = 'market' | 'installed' | 'remote' | 'tasks'

/** 市场里的四个分段（沿用改造前的三个市场页签，加上 0.9.7 的第三方技能）。 */
type MarketSeg = 'skills' | 'tools' | 'updates' | 'third'

/** 内容键 = 子视图 + 该子视图内的分段：舞台按它播过渡，视图内换分段同样是方向性的。 */
type ContentKey = 'market:skills' | 'market:tools' | 'market:updates' | 'market:third' | 'installed:mcp' | 'installed:skills' | 'remote' | 'tasks'

const SUB_LABEL: Record<SubView, string> = { market: '市场', installed: '已安装', remote: '远程源', tasks: '任务' }
const SEG_LABEL: Record<MarketSeg, string> = { skills: '技能市场', tools: '工具市场', updates: '更新', third: '第三方' }

const SUB_VIEWS: Array<{ key: SubView; label: string }> =
  (['market', 'installed', 'remote', 'tasks'] as SubView[]).map((key) => ({ key, label: SUB_LABEL[key] }))

const MARKET_SEGS: Array<{ key: MarketSeg; label: string }> =
  (['skills', 'tools', 'updates', 'third'] as MarketSeg[]).map((key) => ({ key, label: SEG_LABEL[key] }))

/** 内容键的固定顺序：四个视图与视图内的分段排在**同一条线**上，
    方向 = 「这一次是往右走还是往左走」，新内容从哪一侧的 8px 进来由它决定。 */
const CONTENT_ORDER: ContentKey[] = [
  'market:skills', 'market:tools', 'market:updates', 'market:third', 'installed:mcp', 'installed:skills', 'remote', 'tasks',
]

/** 方向性过渡：位移 8px、时长 180ms、曲线取令牌 --ease-soft（大面板位移一律不过冲）。 */
const SHIFT_PX = 8
const SHIFT_MS = 180
const SHIFT_EASE = 'var(--ease-soft)'

/** 内容键 → 它属于哪个视图 / 哪个分段 / 卡片走 mcp 还是 skills 那一套。 */
function partsOf(key: ContentKey): { view: SubView; seg: MarketSeg; kind: 'mcp' | 'skills' } {
  // 「任务」子视图没有内部分段（它自己管列表），seg 只是占位，不参与渲染判断。
  if (key === 'tasks') return { view: 'tasks', seg: 'skills', kind: 'skills' }
  if (key === 'remote') return { view: 'remote', seg: 'skills', kind: 'mcp' }
  if (key === 'installed:skills') return { view: 'installed', seg: 'skills', kind: 'skills' }
  if (key === 'installed:mcp') return { view: 'installed', seg: 'skills', kind: 'mcp' }
  if (key === 'market:tools') return { view: 'market', seg: 'tools', kind: 'mcp' }
  if (key === 'market:updates') return { view: 'market', seg: 'updates', kind: 'skills' }
  if (key === 'market:third') return { view: 'market', seg: 'third', kind: 'skills' }
  return { view: 'market', seg: 'skills', kind: 'skills' }
}

const segKey = (seg: MarketSeg): ContentKey =>
  (seg === 'tools' ? 'market:tools' : seg === 'updates' ? 'market:updates' : seg === 'third' ? 'market:third' : 'market:skills')

const kindKey = (kind: 'mcp' | 'skills'): ContentKey => (kind === 'skills' ? 'installed:skills' : 'installed:mcp')

/** 这一次切换要不要省掉过渡：动效开关 / 系统「减少动态效果」/ 省电档任一为真就瞬时换页。 */
function shiftInstant(): boolean {
  if (!motionOn()) return true
  return document.documentElement.dataset.perf === 'low'
}

/** /api/catalog 的 MCP 条目：比通用 CatalogEntry 多出启动命令与平台/运行时可用性。 */
interface ToolEntry extends CatalogEntry {
  transport?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  platforms?: string[]
  requires?: string[]
  required_parameters?: Array<{ key: string; label: string; secret?: boolean; description?: string; placeholder?: string }>
  available?: boolean
  unavailable_reason?: string | null
}

/** /api/runtime/installed 的 MCP 记录（含用户手写进 mcp_servers.json 的）。 */
interface InstalledMcp {
  id: string
  name?: string
  description?: string
  source?: string
  enabled?: boolean
  transport?: string
  command?: string
  launch?: string
  status?: string
  error?: string | null
  tools_count?: number
  available?: boolean
  unavailable_reason?: string | null
  path?: string
}

interface InstalledSkill { id: string; name?: string; enabled?: boolean; path?: string }

interface InstalledPayload { skills?: InstalledSkill[]; mcp?: InstalledMcp[] }

const STATUS_STYLE: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  // 装完的落点就是「已连接」：工具数紧跟在后面（已安装页那一行会显示成「已连接 · N 个工具」）。
  running: { label: '已连接', tone: 'ok' },
  idle: { label: '已连接（无工具）', tone: 'neutral' },
  error: { label: '启动失败', tone: 'danger' },
  disabled: { label: '已停用', tone: 'neutral' },
  unknown: { label: '未连接', tone: 'warn' },
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 左侧来源/分类列表的一行：选中态用左侧强调条「滑入」表达，
    行本身只做底色与 1px 位移的过渡，不动宽高。 */
function RailItem({ active, label, hint, count, onClick }: {
  active: boolean
  label: string
  hint?: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type='button'
      aria-current={active || undefined}
      title={hint}
      onClick={onClick}
      className={cn(
        // 远程源/分类列表的一行：描边走令牌 v2（透明 → hover --line → 选中 --row-active-line），
        // 圆角取 v2 的行圆角 --r-md，焦点环交给 base.css 统一画（组件里不写 outline）。
        'relative mb-0.5 flex h-8 w-full items-center gap-2 rounded-md border px-3 pl-3.5 text-left text-12',
        'transition-[background-color,border-color,color,transform] duration-[var(--motion-fast)] ease-[var(--ease-enter)]',
        active
          ? 'border-row-active-line bg-row-active text-ink'
          : 'border-transparent text-ink-2 hover:translate-x-[1px] hover:border-line hover:bg-hover',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute left-0.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary',
          'transition-[opacity,transform] duration-[var(--motion-fast)] ease-[var(--ease-enter)]',
          active ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0',
        )}
      />
      <span className='truncate'>{label}</span>
      {count === undefined ? null : <span className='ml-auto shrink-0 text-11 tabular-nums text-ink-4'>{count}</span>}
    </button>
  )
}

/** 列表一页多少条：内置目录（52 条）也按页铺，不再用「首屏 20 项、其余空闲补齐」那套
    —— 那套会让用户以为每个分类只有一屏，看不到「还有多少」。 */
const LIST_PAGE_SIZE = 24

/** 卡片错峰入场：步长 20ms（取自 ui/Card 的 STAGGER_STEP_MS，全站同一档），
    超过 10 张不再往后排；这条延迟只在「首次进入某个内容键」时才挂（见 firstEntry）。 */
const stagger = (i: number): React.CSSProperties => ({ animationDelay: STAGGER_STEP_MS * Math.min(i, 10) + 'ms' })

/** 列表分页：一页 24 条，滚到底自动续页（见 renderPanel 的 onScroll），按钮兜底。
    换视图 / 换分段 / 换分类 / 改关键词（resetKey 变了）都从第一页重来；
    数据变短（搜索滤掉大半）时把页码收回来，免得停在第 3 页显示成一片空白。 */
function usePagedList(total: number, resetKey: string, pageSize = LIST_PAGE_SIZE) {
  const [pages, setPages] = useState(1)
  const keyRef = useRef(resetKey)
  useEffect(() => {
    if (keyRef.current === resetKey) return
    keyRef.current = resetKey
    setPages(1)
  }, [resetKey])
  useEffect(() => {
    const max = Math.max(1, Math.ceil(total / pageSize))
    setPages((prev) => (prev > max ? max : prev))
  }, [total, pageSize])
  const shown = Math.min(total, pages * pageSize)
  const loadMore = useCallback(() => {
    setPages((prev) => Math.min(prev + 1, Math.max(1, Math.ceil(total / pageSize))))
  }, [total, pageSize])
  return { shown, hasMore: shown < total, loadMore }
}

/** 列表页脚：已加载 N 条 / 共 M 条，到底了就写「没有更多了」；还有下一屏时给一枚兜底按钮。 */
function ListPager({ loaded, total, hasMore, onLoadMore }: {
  loaded: number
  total: number
  hasMore: boolean
  onLoadMore: () => void
}) {
  if (total <= 0) return null
  return (
    <div className='mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 pb-1 text-11 text-ink-4'>
      <span>
        已加载 <span className='tabular-nums text-ink-2'>{loaded}</span> 条
        <span className='px-1'>/</span>共 <span className='tabular-nums text-ink-2'>{total}</span> 条
        {hasMore ? '' : ' · 没有更多了'}
      </span>
      {hasMore ? <Button variant='secondary' size='sm' onClick={onLoadMore}>加载更多</Button> : null}
    </div>
  )
}

/** 已安装页的一行：把 MCP 与 Skill 两种来源归一成同一张卡。 */
interface InstalledItem {
  kind: 'mcp' | 'skills'
  id: string
  name: string
  description: string
  enabled: boolean
  available: boolean
  reason: string
  detail: string
  status: string
  statusLabel: string
  statusTone: 'ok' | 'warn' | 'danger' | 'neutral'
  toolsCount: number
  error: string
  source: string
}

/** 已安装条目的处置优先级：失败 > 未连接 > 运行中 > 已停用。
    「未连接」比「停用」靠前：前者是引擎连不上（要处理），后者是用户自己关的（本就不用管）。 */
function installedRank(item: InstalledItem): number {
  if (item.status === 'error') return 0
  if (!item.enabled) return 3
  if (item.status === 'unknown') return 1
  return 2
}

export function SkillsView() {
  /* 首帧只画外壳：这一页的首屏要把「分段 + 左轨 + 整屏卡片 + 四个对话框」一次性算完，
     而它又是路由级懒加载的 —— 首帧之前浏览器拿不到任何新内容，用户看到的就是卡住。
     骨架用页面里本来就有的 SkeletonCard（形状与真卡片一致），下一帧再挂正文。 */
  const firstFrameReady = useFirstFrame()
  const ready = useEngine((s) => s.ready)
  const skills = useLibrary((s) => s.skills)
  const tools = useLibrary((s) => s.tools) as ToolEntry[]
  const runtimes = useLibrary((s) => s.runtimes)
  const loadCatalog = useLibrary((s) => s.loadCatalog)
  const loadRuntimes = useLibrary((s) => s.loadRuntimes)
  // 切页/重挂载专用（见 stores/library 的 ensureCatalog）：够新就不打网络。
  const ensureCatalog = useLibrary((s) => s.ensureCatalog)
  const ensureRuntimes = useLibrary((s) => s.ensureRuntimes)
  const recheckEnvironment = useLibrary((s) => s.recheckEnvironment)
  const storeError = useLibrary((s) => s.error)
  /// 远程源记在 store 里（切到「远程源」视图再回来，还停在原来的源，结果也不用重拉）。
  const storedSource = useLibrary((s) => s.remoteSource)
  const setRemoteSource = useLibrary((s) => s.setRemoteSource)
  const [source, setSource] = useState<RemoteSourceKey>(storedSource)
  /* ── 内容舞台的状态：当前内容键 + 正在退场的那一份 + 方向 + 新内容落位没有 ──
     contentRef 是给事件回调读「上一个内容键」用的：setState 是异步的，闭包里的 content
     可能是旧值，方向一旦算错，左右就颠倒了。 */
  const [content, setContent] = useState<ContentKey>('market:tools')
  const contentRef = useRef<ContentKey>(content)
  contentRef.current = content
  const [leaving, setLeaving] = useState<ContentKey | null>(null)
  const [dir, setDir] = useState<1 | -1>(1)
  const [entered, setEntered] = useState(true)
  /** 三个视图 / 三个分段的拆解：控制条、卡片、空态读的都是它。 */
  const { view, seg: marketSeg, kind: catalogKind } = partsOf(content)
  /** 「已安装」视图的两个分段：工具（MCP）与技能（Skills）各一套计数与空态。 */
  const installedKind: 'mcp' | 'skills' = content === 'installed:skills' ? 'skills' : 'mcp'
  /** 展开着详情的已安装卡片（键是 kind:id）：折叠动画走 .collapse，见 renderInstalled。 */
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部')
  const [detail, setDetail] = useState<ToolEntry | null>(null)
  /** 需要填参数的条目：点「安装」先弹表单，而不是带着空参数去装。 */
  const [installTarget, setInstallTarget] = useState<ToolEntry | null>(null)
  /** 「怎么装」帮助弹窗：认不出具体运行时（例如平台限制）时 target 为 null。 */
  const [help, setHelp] = useState<{ target: RuntimeHelpTarget | null; reason: string; entryName: string } | null>(null)
  const [installed, setInstalled] = useState<InstalledPayload>({})
  const [installedLoaded, setInstalledLoaded] = useState(false)
  /** 每条条目各自「正在装/正在卸/正在切开关」：以前是一个字符串（只记得住最后点的那条），
   *  并排装两条时后点的会解锁先点的按钮，先点的 finally 又会解锁后点的（状态互相串台）。 */
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set<string>())
  const markBusy = useCallback((id: string, on: boolean): void => {
    setBusy((prev) => {
      if (prev.has(id) === on) return prev
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const [notice, setNotice] = useState('')
  /// 顶部提示：只写值真的变了的那一次。**引用必须恒定** ——
  /// 它会被当成 onNotice 传进 RemoteMcpBrowser，而那边的 run() 依赖它；
  /// 不稳定的引用会让「切源时自动拉一次」那个 effect 每次渲染都重跑（并顺手 setQuery('')），
  /// 那就是一条自己喂自己的渲染环路。
  const writeNotice = useCallback((text: string): void => {
    setNotice((prev) => (prev === text ? prev : text))
  }, [])
  /// 目录还在拉的这段窗口：用骨架屏占位，而不是甩一行「加载中…」。
  const [catalogPending, setCatalogPending] = useState(false)
  /// 一键装运行环境：状态条上的「一键装」与灰显条目的「一键装环境并安装」都落到这里。
  const [runtimeTarget, setRuntimeTarget] = useState<{ id: string; label: string } | null>(null)
  /// 缺运行环境的内置条目：一张两步进度卡（先装环境，再装这条）。
  const [chainTarget, setChainTarget] = useState<{ entry: ToolEntry; runtimeId: string; runtimeName: string } | null>(null)

  /* ── 视图导航与方向性过渡 ── */

  /** 切到某个内容键：老内容留在原地退场，新内容从对侧 8px 外进；方向按 CONTENT_ORDER 算。 */
  const goTo = useCallback((next: ContentKey): void => {
    const prev = contentRef.current
    if (prev === next) return
    contentRef.current = next
    setContent(next)
    // 动效关掉时不留任何残留：不挂退场副本，新内容直接落位。
    if (shiftInstant()) { setLeaving(null); setEntered(true); return }
    setDir(CONTENT_ORDER.indexOf(next) >= CONTENT_ORDER.indexOf(prev) ? 1 : -1)
    setEntered(false)
    setLeaving(prev)
  }, [])

  /** 每个视图上次停在哪一格：切走再切回来要回到原处，而不是打回默认格。 */
  const lastSeg = useRef<MarketSeg>('tools')
  const lastKind = useRef<'mcp' | 'skills'>('mcp')
  useEffect(() => {
    if (view === 'market') lastSeg.current = marketSeg
    else if (view === 'installed') lastKind.current = installedKind
  }, [view, marketSeg, installedKind])

  /** 顶部三个视图：切回某个视图时停在这个视图上次用过的分段上。 */
  const goSubView = useCallback((next: SubView): void => {
    if (next === 'tasks') { goTo('tasks'); return }
    if (next === 'remote') { goTo('remote'); return }
    if (next === 'installed') { goTo(kindKey(lastKind.current)); return }
    goTo(segKey(lastSeg.current))
  }, [goTo])

  /* 过渡的两拍：
     ① 新内容先按「起步态」（对侧 8px + 透明）真画一帧，两帧后再落位 —— 过渡必须有起点
        （单帧会偶发不播，与 SwapIn 同一套做法）；
     ② 退场的那一份等过渡播完（180ms + 一点余量）再摘掉。 */
  useEffect(() => {
    if (shiftInstant()) { setEntered((was) => (was ? was : true)); setLeaving((was) => (was === null ? was : null)); return }
    let inner = 0
    const outer = window.requestAnimationFrame(() => { inner = window.requestAnimationFrame(() => setEntered((was) => (was ? was : true))) })
    const timer = window.setTimeout(() => setLeaving((was) => (was === null ? was : null)), SHIFT_MS + 40)
    return () => {
      window.cancelAnimationFrame(outer)
      if (inner) window.cancelAnimationFrame(inner)
      window.clearTimeout(timer)
    }
  }, [content])

  /** 退场那一份直接复用上一次渲染出来的节点（元素引用相同 → React 直接跳过这棵树的重渲染）：
     「切换时只重渲染当前内容、其余最多留一份且冻结」因此是结构上的保证，不靠 memo 猜依赖。 */
  const panelCache = useRef(new Map<ContentKey, ReactNode>())

  useEffect(() => {
    if (!ready) return
    // 目录到手就把骨架窗口收掉。这一支原来直接 return：目录回得比那 900ms 快时，
    // 定时器会被 cleanup 摘掉、再没人把 catalogPending 置回 false，
    // 「首屏骨架」于是永远停在那里（CDP 里 24 条骨架条就是这么被抓出来的）。
    if (tools.length || skills.length) { setCatalogPending(false); return }
    setCatalogPending(true)
    const timer = window.setTimeout(() => setCatalogPending(false), 900)
    return () => window.clearTimeout(timer)
  }, [ready, tools.length, skills.length])

  /** 「已安装」页的数据源：直接读运行时配置（含手动写进 mcp_servers.json 的条目）。 */
  /// 已安装清单最近一次成功的时刻（切页 TTL 用）。
  const installedCheckedAt = useRef(0)

  const loadInstalled = useCallback(async () => {
    try {
      const data = await useEngine.getState().api<InstalledPayload>('/api/runtime/installed')
      setInstalled(data ?? {})
      installedCheckedAt.current = Date.now()
    } catch (e) {
      setNotice('读取已安装列表失败：' + describe(e))
    } finally {
      setInstalledLoaded(true)
    }
  }, [])

  /** 手动刷新（按钮 / 重新检测）：**强制**重拉三份数据。 */
  const refresh = useCallback(async () => {
    // /api/catalog 给出条目的可用性，/api/runtime/runtimes 给出本机运行环境：两者要一起拉。
    await Promise.all([loadCatalog(), loadInstalled(), loadRuntimes()])
  }, [loadCatalog, loadInstalled, loadRuntimes])

  /** 挂载时用这一条：60 秒内的数据直接复用，不再打网络。
      切页卡顿的主因就是「每次挂载都 refresh 三张网络 + 重渲染整张目录」（见 App 的 liveViews）。 */
  const ensureFresh = useCallback(async (maxAgeMs = 60_000) => {
    const stale = Date.now() - installedCheckedAt.current >= maxAgeMs
    await Promise.all([
      ensureCatalog(maxAgeMs),
      ensureRuntimes(maxAgeMs),
      stale ? loadInstalled() : Promise.resolve(),
    ])
  }, [ensureCatalog, ensureRuntimes, loadInstalled])

  useEffect(() => { if (ready) void ensureFresh() }, [ready, ensureFresh])

  /** 「重新检测」在飞的路数：>0 时状态条 / 灰显卡片上的重检按钮禁用并显示进行中文案。
      用**计数**而不是布尔：状态条、灰显卡片、帮助弹窗、一键安装卡都可能在同一两秒里各触发一次，
      布尔会被先返回的那一路提前关掉，按钮就又在「其实还在拉」的时候变回可点。
      为什么不直接用 store 的 runtimesStatus === 'loading'：那只是 runtimes 这一段在拉；
      目录、已安装清单这两段里它已经回到 ready，按钮会中途解锁 —— 正是「点不动还没反应」的来源。 */
  const [recheckDepth, setRecheckDepth] = useState(0)
  const rechecking = recheckDepth > 0

  /** 状态条与卡片上的「重新检测」：重新拉运行环境 + 目录 + 已安装清单。 */
  const recheckAll = useCallback(async () => {
    setRecheckDepth((n) => n + 1)
    try {
      /* **串行**而不是原来的 Promise.all（那是「recheckEnvironment 内部再 Promise.all」的两层并发，
         峰值同一瞬间 3 条重请求：/api/runtime/runtimes 约 2.3s、/api/catalog 约 3.3s，
         且前者要逐个 fork 子进程探测 10 个运行时 —— 连点几次就是几十次进程创建，机器被打满，
         外壳的看门狗还会把这种假死误判成引擎卡死）。
         取舍：总耗时从「最慢的那条」变成「三条之和」，顺序固定为
         runtimes → catalog → installed，所以「缺哪个运行环境」这条最受关注的信息最先回来；
         换来的是峰值降到 1 条请求，界面在等待期间仍然可交互，也不会再把引擎逼到被杀。
         （recheckEnvironment 自己内部也已改成 runtimes → catalog 串行，见 stores/library。） */
      await recheckEnvironment()
      await loadInstalled()
    } finally {
      setRecheckDepth((n) => (n > 0 ? n - 1 : 0))
    }
  }, [recheckEnvironment, loadInstalled])

  const catalogTools = useMemo(() => new Map(tools.map((e) => [e.id, e])), [tools])
  const catalogSkills = useMemo(() => new Map((skills as ToolEntry[]).map((e) => [e.id, e])), [skills])

  /// 远程条目命中内置目录 id 时可以直接装；两个集合交给远程浏览器判断。
  const builtinIds = useMemo(() => new Set(tools.map((e) => e.id)), [tools])
  const installedIds = useMemo(
    () => new Set([...(installed.mcp ?? []).map((m) => m.id), ...(installed.skills ?? []).map((s) => s.id)]),
    [installed],
  )
  /// 自定义安装的片段要告诉用户写到哪个文件：路径由运行时接口给出。
  const configPath = useMemo(() => (installed.mcp ?? []).find((m) => m.path)?.path ?? '', [installed])

  /** 已安装清单：MCP 与 Skill 合流，并补齐目录里的名称/描述。 */
  const installedItems = useMemo<InstalledItem[]>(() => {
    const items: InstalledItem[] = []
    for (const server of installed.mcp ?? []) {
      const meta = catalogTools.get(server.id)
      const style = STATUS_STYLE[server.status ?? 'unknown'] ?? STATUS_STYLE.unknown
      items.push({
        kind: 'mcp',
        id: server.id,
        name: meta?.name || server.name || server.id,
        description: server.description || meta?.description || '',
        enabled: server.enabled !== false,
        available: server.available !== false,
        reason: server.unavailable_reason ?? '',
        detail: server.launch || server.command || '',
        status: server.status ?? 'unknown',
        statusLabel: style.label,
        statusTone: style.tone,
        toolsCount: server.tools_count ?? 0,
        error: server.error ?? '',
        source: server.source === 'manual' ? '手动配置' : '工具市场',
      })
    }
    for (const skill of installed.skills ?? []) {
      const meta = catalogSkills.get(skill.id)
      items.push({
        kind: 'skills',
        id: skill.id,
        name: meta?.name || skill.name || skill.id,
        description: meta?.description || '',
        enabled: skill.enabled !== false,
        available: meta?.available !== false,
        reason: meta?.unavailable_reason ?? '',
        detail: skill.path ?? '',
        status: skill.enabled === false ? 'disabled' : 'running',
        statusLabel: skill.enabled === false ? '已停用' : '已启用',
        statusTone: skill.enabled === false ? 'neutral' : 'ok',
        toolsCount: 0,
        error: '',
        source: meta ? '技能目录' : '本地安装',
      })
    }
    // 默认排序：失败 > 未连接 > 运行中 > 已停用；同级按名称，要处理的永远排在最前。
    return items.sort((a, b) => installedRank(a) - installedRank(b) || a.name.localeCompare(b.name))
  }, [installed, catalogTools, catalogSkills])

  /** 「市场 › 工具市场」这一格走内置随包目录，技能 / 更新走技能目录（与改造前一一对应）。
      其余视图这两份数据不参与渲染，口径统一成「只看 market:tools 分段」。 */
  const toolsSeg = marketSeg === 'tools'
  const sourceList: CatalogEntry[] = toolsSeg ? tools : skills
  const detailKind: 'mcp' | 'skills' = catalogKind

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sourceList.filter((e) => {
      // 分类只属于内置工具目录（分类轨只在「工具市场」分段里出现）：
      // 换到技能 / 更新时不该再被上一次选的分类滤成一张空列表。
      if (toolsSeg && category !== '全部' && catalogCategory(e.id) !== category) return false
      if (!q) return true
      return (e.name ?? e.id).toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q)
    })
  }, [sourceList, query, category, toolsSeg])

  /** 当前分段（工具 / 技能）的清单，再叠一层搜索框的过滤。 */
  const installedList = useMemo(() => {
    const q = query.trim().toLowerCase()
    return installedItems.filter((e) => {
      if (e.kind !== installedKind) return false
      if (!q) return true
      return e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)
    })
  }, [installedItems, installedKind, query])

  /** 分段计数 + 顶部那条统计（统计按全量算，两个分段都看得见总盘子有多大）。 */
  const installedCounts = useMemo(() => ({
    total: installedItems.length,
    running: installedItems.filter((e) => installedRank(e) === 2).length,
    mcp: installedItems.filter((e) => e.kind === 'mcp').length,
    skills: installedItems.filter((e) => e.kind === 'skills').length,
  }), [installedItems])

  /** 内置目录与已安装列表都按页铺：一页 24 条，滚到底自动续页，按钮兜底（见 usePagedList）。 */
  const marketPager = usePagedList(list.length, 'market:' + marketSeg + ':' + category + ':' + query)
  const installedPager = usePagedList(installedList.length, 'installed:' + installedKind + ':' + query)
  /** 滚动自动续页的节流时间戳（见 renderPanel 的 onScroll）。 */
  const lastAutoLoad = useRef(0)

  /* ── 卡片错峰：只在「首次进入该页签」播一次 ──
     两个判据都不能省：
     ①「进过」按**真的铺出卡片**那一刻算，而不是「面板挂上了」——首屏那几帧还是骨架
       （目录 / 已安装清单还没回来），那时就记作进过的话，数据落地时卡片便不再算首次入场，
       20ms 错峰永远轮不到第一屏；而这一页默认就落在工具市场上。
     ② 关掉错峰这一步**不触发重渲染**（改 ref 而不是 state）：空闲补齐那一拍若把动画类摘掉，
       错峰会断在半路 —— 连后来补上的那 10 张也一起没有动画。 */
  const seenKeys = useRef(new Set<ContentKey>())
  const staggerOn = useRef(true)
  const staggerKey = useRef(content)
  if (staggerKey.current !== content) {
    staggerKey.current = content
    staggerOn.current = !seenKeys.current.has(content)
  }
  const hasItems = view === 'installed' ? installedList.length > 0 : list.length > 0
  useEffect(() => {
    if (!staggerOn.current || !hasItems) return
    // 320ms ≈ 错峰最长延迟（10 × 20ms）+ 卡片入场（--motion-base）：等它播完再记「进过」。
    const timer = window.setTimeout(() => { seenKeys.current.add(content); staggerOn.current = false }, 320)
    return () => window.clearTimeout(timer)
  }, [content, hasItems])
  const firstEntry = staggerOn.current

  const toggleCard = useCallback((key: string) => {
    setOpenCards((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  /* ── 安装 ── */

  /** 目录安装（引擎已任务化，见 installClient 的 waitInstallTask）：
      POST 立刻拿 task_id → 轮询到终态（顺便把日志尾部显示在提示条上）→ 刷新目录与已安装。 */
  const runCatalogInstall = async (path: string, body: unknown, name: string): Promise<void> => {
    setNotice('正在安装 ' + name + '…')
    const reply = await useEngine.getState().api<{ task_id?: string }>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const taskId = reply?.task_id ?? ''
    // 旧版引擎（没有任务化）会同步装完再回包：那就不用等，直接刷新。
    if (!taskId) {
      setNotice('已安装 ' + name + '，可在「已安装」页启停')
      await refresh()
      return
    }
    const outcome = await waitInstallTask(taskId, {
      onTick: (info) => {
        const last = info.tail.split('\n').filter(Boolean).slice(-1)[0] ?? ''
        setNotice('正在安装 ' + name + '…' + (last ? '（' + last.slice(0, 90) + '）' : ''))
      },
    })
    if (!outcome.ok) {
      setNotice('安装 ' + name + ' 失败：' + (outcome.error || '').split('\n')[0].slice(0, 200))
      return
    }
    setNotice('已安装 ' + name + '，可在「已安装」页启停')
    await refresh()
  }

  /** 安装 MCP：带上必填参数（密钥/路径），装完立刻刷新「已安装」。 */
  const installTool = async (entry: ToolEntry, values: Record<string, string>): Promise<void> => {
    markBusy(entry.id, true)
    setNotice('')
    try {
      await runCatalogInstall('/api/catalog/mcp/install', { id: entry.id, values }, entry.name || entry.id)
    } catch (e) {
      setNotice('安装失败：' + describe(e))
    } finally {
      markBusy(entry.id, false)
    }
  }

  const installSkill = async (entry: CatalogEntry): Promise<void> => {
    markBusy(entry.id, true)
    setNotice('')
    try {
      await runCatalogInstall('/api/catalog/skills/install', { id: entry.id }, entry.name || entry.id)
    } catch (e) {
      setNotice('安装失败：' + describe(e))
    } finally {
      markBusy(entry.id, false)
    }
  }

  /** 卡片上的「安装」：要填参数的条目先弹表单，不需要参数的直接装。 */
  const startInstall = (entry: ToolEntry, kind: 'mcp' | 'skills'): void => {
    if (kind !== 'mcp') { void installSkill(entry); return }
    if ((entry.required_parameters ?? []).length) { setInstallTarget(entry); return }
    void installTool(entry, {})
  }

  /* ── 一键安装：运行环境 / 两步链 / 远程条目 ── */

  /** 这条灰显条目缺哪个运行时（引擎没做环境检测时返回空：那就不提供一键装，避免误装）。 */
  const chainRuntimeFor = useCallback((entry: ToolEntry): string => {
    if (!runtimes.length) return ''
    for (const id of entryRuntimeIds(entry)) {
      const status = runtimeStatusFor(runtimes, id)
      if (status && !status.found) return status.id
    }
    return ''
  }, [runtimes])

  /** 读一眼刚装好的条目在引擎里的真实状态（连接状态与工具数）。 */
  const readInstalledRow = useCallback(async (id: string): Promise<{ status: string; toolsCount: number; error: string } | null> => {
    try {
      const data = await useEngine.getState().api<InstalledPayload>('/api/runtime/installed')
      const row = (data.mcp ?? []).find((m) => m.id.toLowerCase() === id.toLowerCase())
      return row ? { status: row.status ?? 'unknown', toolsCount: row.tools_count ?? 0, error: row.error ?? '' } : null
    } catch {
      return null
    }
  }, [])

  /** 两步卡的第 2 步（内置目录条目）：装完回读一次状态，把「已连接 · N 个工具」带回卡上。 */
  const installCatalogOutcome = useCallback(async (entry: ToolEntry): Promise<ToolInstallOutcome> => {
    try {
      const reply = await useEngine.getState().api<{ task_id?: string }>('/api/catalog/mcp/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: entry.id, values: {} }),
      })
      // 步骤 2 要等安装真的结束（引擎已把它任务化）：否则「已连接 · N 个工具」会读在写入之前。
      const taskId = reply?.task_id ?? ''
      if (taskId) {
        const outcome = await waitInstallTask(taskId)
        if (!outcome.ok) {
          return { ...EMPTY_TOOL_OUTCOME, ok: false, error: outcome.error || '安装失败', tail: outcome.tail, message: '' }
        }
      }
    } catch (e) {
      const message = describe(e)
      return { ...EMPTY_TOOL_OUTCOME, ok: false, error: message, conflict: /HTTP 409/.test(message), message }
    }
    await refresh()
    const row = await readInstalledRow(entry.id)
    const connected = !!row && !row.error && row.status !== 'unknown'
    return {
      ...EMPTY_TOOL_OUTCOME,
      ok: connected,
      connected,
      toolsCount: row?.toolsCount ?? 0,
      error: connected ? '' : (row?.error || '装完了，但引擎没能连上它'),
      tail: row?.error ?? '',
      message: '',
    }
  }, [refresh, readInstalledRow])

  /** 条目装完：刷新「目录 + 已安装」两条链路，并把连接状态回显到页面顶部。 */
  const echoInstalled = useCallback((name: string, echo: RemoteInstalledEcho) => {
    void refresh()
    if (echo.ok) setNotice('已安装 ' + name + '：已连接 · ' + echo.toolsCount + ' 个工具')
    else if (echo.saved) setNotice('已写入配置：' + name + ' 这条引擎暂时连不上，展开卡片可以看到引擎的原话')
    else setNotice('安装 ' + name + ' 失败：' + echo.error)
  }, [refresh])

  const onRemoteInstalled = useCallback((entry: RemoteEntry, echo: RemoteInstalledEcho) => {
    echoInstalled(echo.name || entry.name || entry.id, echo)
  }, [echoInstalled])

  const removeEntry = async (kind: 'mcp' | 'skills', id: string): Promise<void> => {
    markBusy(id, true)
    setNotice('')
    try {
      await useEngine.getState().api('/api/catalog/' + kind + '/' + encodeURIComponent(id), { method: 'DELETE' })
      setNotice('已卸载 ' + id)
      await refresh()
    } catch (e) {
      setNotice('卸载失败：' + describe(e))
    } finally {
      markBusy(id, false)
    }
  }

  const toggleEntry = async (kind: 'mcp' | 'skills', id: string, enabled: boolean): Promise<void> => {
    markBusy(id, true)
    setNotice('')
    try {
      await useEngine.getState().api('/api/catalog/' + kind + '/' + encodeURIComponent(id) + '/enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      await refresh()
    } catch (e) {
      setNotice((enabled ? '启用失败：' : '停用失败：') + describe(e))
    } finally {
      markBusy(id, false)
    }
  }

  /* ── 「怎么装」 ── */

  /** 这条条目缺哪个运行时：先用条目自己的 command/requires 推断，再退回原因文本。 */
  const runtimeTargetFor = useCallback((entry: ToolEntry): RuntimeHelpTarget | null => {
    for (const id of entryRuntimeIds(entry)) {
      const status = runtimeStatusFor(runtimes, id)
      if (status?.found) continue
      return helpTargetFor(id, runtimes)
    }
    const fromReason = matchRuntimeIds(entry.unavailable_reason ?? '')
    return fromReason.length ? helpTargetFor(fromReason[0], runtimes) : null
  }, [runtimes])

  const openHelp = useCallback((entry: ToolEntry): void => {
    setHelp({
      target: runtimeTargetFor(entry),
      reason: entry.unavailable_reason ?? '',
      entryName: entry.name || entry.id,
    })
  }, [runtimeTargetFor])

  const helpForReason = useCallback((reason: string, name: string): void => {
    const ids = matchRuntimeIds(reason)
    setHelp({ target: ids.length ? helpTargetFor(ids[0], runtimes) : null, reason, entryName: name })
  }, [runtimes])

  const openDetail = (entry: ToolEntry): void => setDetail(entry)

  /** 远程条目命中内置目录时走这里：要参数的先弹表单，否则直接安装。 */
  const openBuiltinInstall = useCallback((id: string): void => {
    const entry = catalogTools.get(id)
    if (!entry) {
      setNotice('内置目录里没有 ' + id + '：可以「生成配置」把片段写进 mcp_servers.json')
      return
    }
    startInstall(entry, 'mcp')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogTools])

  const categories = useMemo(() => {
    const used = new Set(sourceList.map((e) => catalogCategory(e.id)))
    return CATALOG_CATEGORIES.filter((c) => c === '全部' || used.has(c))
  }, [sourceList])

  const detailCommand = detail
    ? [detail.command ?? '', ...(detail.args ?? [])].filter(Boolean).join(' ')
    : ''

  const detailBody = detail ? (
    <div className='flex flex-col gap-3'>
      <div className='flex items-center gap-3'>
        <span className='flex h-11 w-11 items-center justify-center rounded-lg bg-primary-soft text-primary'>{catalogIcon(detail.id)}</span>
        <div className='min-w-0'>
          <div className='flex items-center gap-2'>
            <span className='text-15 font-medium text-ink'>{detail.name || detail.id}</span>
            <Badge tone={detail.installed ? 'primary' : 'neutral'}>{detail.installed ? '已安装' : '未安装'}</Badge>
            {detail.available === false ? <Badge tone='warn'>本机不可用</Badge> : null}
          </div>
          <div className='mt-0.5 font-mono text-11 text-ink-4'>{detail.id} · {catalogCategory(detail.id)}</div>
        </div>
      </div>
      <p className='text-13 leading-[1.7] text-ink-2'>{detail.description || '暂无描述'}</p>
      {detail.available === false ? (
        <div className='flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft p-3 text-12 text-ink-2'>
          <AlertTriangle size={14} className='mt-0.5 shrink-0 text-warn' />
          <span>{detail.unavailable_reason || '当前系统不支持该条目'}</span>
        </div>
      ) : null}
      <div className='rounded-lg border border-line bg-muted p-3'>
        <div className='text-11 text-ink-4'>启动命令</div>
        <div className='mt-1 break-all font-mono text-11 leading-[1.6] text-ink-2'>{detailCommand || '（未提供）'}</div>
      </div>
      {(detail.required_parameters ?? []).length ? (
        <div className='rounded-lg border border-line bg-muted p-3'>
          <div className='text-11 text-ink-4'>安装前需要填写 {(detail.required_parameters ?? []).length} 个参数</div>
          <div className='mt-1.5 flex flex-col gap-1.5'>
            {(detail.required_parameters ?? []).map((p) => (
              <div key={p.key}>
                <div className='text-12 text-ink-2'>
                  {p.label} <span className='font-mono text-11 text-ink-4'>{p.key}</span>
                </div>
                <div className='text-11 leading-[1.6] text-ink-4'>{parameterHelp(p, detail)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className='rounded-lg border border-line bg-muted p-3 text-12 text-ink-3'>
          安装后由引擎以 stdio 方式拉起，无需额外参数。
        </div>
      )}
    </div>
  ) : null

  /** 已安装卡片：标题行 + 说明 + 可展开的详情。
      「展开/收起」统一走 base.css 的 .collapse（grid-template-rows 0fr↔1fr + opacity，
      时长 --motion-collapse）；折叠态自带 visibility:hidden + pointer-events:none，
      收起来的内容既看不见也点不到，也不会被 Tab 走到。 */
  const renderInstalled = () => {
    // 骨架屏：形状就是下面的卡片（图标 + 标题 + 两行说明）。
    if (!installedLoaded) return <SkeletonRows rows={4} className='px-0 py-1' />
    return (
      <div className='flex flex-col gap-3'>
        {/* 两个分段（工具 / 技能）与那条按全量算的统计搬到了本视图的工具条上，计数一个没少。 */}
        {!installedList.length ? (
          /* 这一分段里有东西、只是被搜索框滤空了：给「没有匹配的结果」，不要误报成「还没装过」。 */
          query.trim() && installedCounts[installedKind] > 0 ? (
            <Empty
              art='search'
              className='animate-card-in'
              title='没有匹配的结果'
              description={'这个分段里有 ' + installedCounts[installedKind] + ' 项，但没有一项匹配「' + query.trim() + '」。'}
              action={<Button variant='secondary' size='sm' onClick={() => setQuery('')}>清空搜索</Button>}
            />
          ) : installedKind === 'mcp' ? (
            <Empty
              art='tasks'
              className='animate-card-in'
              title='还没有已安装的工具'
              description='去「市场 › 工具市场」挑一个装上，装完会立刻出现在这里，可随时启停或卸载。'
              action={<Button variant='primary' size='sm' onClick={() => goTo('market:tools')}><Download size={13} /> 去工具市场</Button>}
            />
          ) : (
            <Empty
              art='artifacts'
              className='animate-card-in'
              title='还没有已安装的技能'
              description='去「市场 › 技能市场」装一个：技能是写给 Agent 的说明书，装完会出现在这里，可随时停用或卸载。'
              action={<Button variant='primary' size='sm' onClick={() => goTo('market:skills')}><Download size={13} /> 去技能市场</Button>}
            />
          )
        ) : (
          <div className='flex flex-col gap-2.5'>
            {installedList.slice(0, installedPager.shown).map((item, i) => {
              const cardKey = item.kind + ':' + item.id
              const open = !!openCards[cardKey]
              const panelId = 'installed-detail-' + installedKind + '-' + i
              return (
                <article
                  key={cardKey}
                  style={firstEntry ? stagger(i) : undefined}
                  className={cn('card-lift rounded-lg border border-line bg-surface elev-1 p-4', firstEntry && 'animate-card-in')}
                >
                  <div className='flex items-start gap-3'>
                    <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', item.enabled ? 'bg-primary-soft text-primary' : 'bg-sunken text-ink-3')}>
                      {catalogIcon(item.id)}
                    </span>
                    <div className='min-w-0 flex-1'>
                      <div className='flex flex-wrap items-center gap-1.5'>
                        <h3 className='truncate text-13 font-medium text-ink'>{item.name}</h3>
                        <Badge tone={item.statusTone}>{item.statusLabel}</Badge>
                        <Badge tone='neutral'>{item.kind === 'mcp' ? 'MCP 服务器' : '技能'}</Badge>
                        <Badge tone='neutral'>{item.source}</Badge>
                        {item.available ? null : <Badge tone='warn'>本机不可用</Badge>}
                      </div>
                      {item.description ? <p className='mt-1 line-clamp-2 text-12 leading-[1.6] text-ink-3'>{item.description}</p> : null}
                      {item.kind === 'mcp' ? (
                        <div className='mt-1.5 flex items-center gap-1.5 text-11 text-ink-4'>
                          <Terminal size={12} className='shrink-0' />
                          <span className='truncate font-mono' title={item.detail}>{item.detail || '（未提供启动命令）'}</span>
                          {item.toolsCount > 0 ? (
                            <span className='flex shrink-0 items-baseline gap-1'>
                              <span>·</span>
                              <AnimatedNumber value={item.toolsCount} format={{ maximumFractionDigits: 0 }} />
                              <span>个工具</span>
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <div className='mt-1.5 truncate font-mono text-11 text-ink-4' title={item.detail}>{item.detail}</div>
                      )}
                      {item.error ? <p className='mt-1.5 flex items-start gap-1.5 text-11 leading-[1.6] text-danger'><AlertTriangle size={12} className='mt-0.5 shrink-0' />{item.error}</p> : null}
                      {item.available ? null : (
                        <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
                          <p className='text-11 leading-[1.6] text-warn'>{item.reason}</p>
                          <Button variant='secondary' size='sm' onClick={() => helpForReason(item.reason, item.name)}>
                            <Wrench size={13} /> 怎么装
                          </Button>
                          <Button variant='ghost' size='sm' disabled={busy.has(item.id) || rechecking} onClick={() => { setNotice('正在重新检测运行环境…'); void recheckAll() }}>
                            {rechecking ? <Spinner /> : <RefreshCw size={13} />} {rechecking ? '正在重新检测…' : '重新检测'}
                          </Button>
                        </div>
                      )}
      
                      {/* 展开/收起：箭头只转 transform，内容走 .collapse（0fr↔1fr + 淡入淡出）。 */}
                      <div className='mt-1.5 flex items-center gap-1.5'>
                        <Button variant='ghost' size='sm' aria-expanded={open} aria-controls={panelId} onClick={() => toggleCard(cardKey)}>
                          <ChevronDown size={13} className={cn('transition-transform duration-[var(--motion-collapse)] ease-[var(--ease-enter)]', open && 'rotate-180')} />
                          {open ? '收起详情' : '详情'}
                        </Button>
                        {item.kind === 'mcp' ? <McpLaunchEditor id={item.id} onSaved={() => { void loadInstalled() }} /> : null}
                      </div>
                      {/* 折叠内容的直接子元素必须「干净」：间距与描边放在再下一层，折叠态才收得到 0。 */}
                      <div id={panelId} className='collapse' data-open={open}>
                        <div>
                          <div className='mt-2.5 grid grid-cols-1 gap-x-6 gap-y-1.5 border-t border-line-soft pt-2.5 text-11 leading-[1.6] sm:grid-cols-2'>
                            <div className='min-w-0'>
                              <div className='text-ink-4'>条目 id</div>
                              <div className='truncate font-mono text-ink-2' title={item.id}>{item.id}</div>
                            </div>
                            <div className='min-w-0'>
                              <div className='text-ink-4'>来源</div>
                              <div className='truncate text-ink-2'>{item.source}</div>
                            </div>
                            <div className='min-w-0 sm:col-span-2'>
                              <div className='text-ink-4'>{item.kind === 'mcp' ? '启动命令' : '安装位置'}</div>
                              <div className='break-all font-mono text-ink-2'>{item.detail || '（未提供）'}</div>
                            </div>
                            {item.kind === 'mcp' ? (
                              <div className='min-w-0'>
                                <div className='text-ink-4'>引擎回报的工具数</div>
                                <div className='tabular-nums text-ink-2'>{item.toolsCount} 个</div>
                              </div>
                            ) : null}
                            <div className='min-w-0'>
                              <div className='text-ink-4'>引擎原话</div>
                              <div className='break-all text-ink-2'>{item.error || (item.available ? '没有回报错误' : (item.reason || '这条在本机不可用'))}</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className='flex shrink-0 items-center gap-1.5'>
                      <Switch
                        checked={item.enabled}
                        disabled={busy.has(item.id)}
                        onCheckedChange={(next) => void toggleEntry(item.kind, item.id, next)}
                      />
                      <Button variant='danger' size='sm' disabled={busy.has(item.id)} onClick={() => void removeEntry(item.kind, item.id)}>
                        <Trash2 size={13} /> 卸载
                      </Button>
                    </div>
                  </div>
                </article>
                )
            })}
            <ListPager
              loaded={installedPager.shown}
              total={installedList.length}
              hasMore={installedPager.hasMore}
              onLoadMore={installedPager.loadMore}
            />
          </div>
        )}
      </div>
    )
  }

  const renderCards = (kind: 'mcp' | 'skills') => (
    // 一页 24 张（见 usePagedList）；错峰只在首次进入这个内容键时挂一次。
    <>
    <div className='grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3'>
      {list.slice(0, marketPager.shown).map((raw, i) => {
        const e = raw as ToolEntry
        const unavailable = e.available === false
        const params = e.required_parameters ?? []
        /// 缺哪个运行时（只有引擎做过环境检测时才给值）：有值就提供「一键装环境并安装」。
        const missingRuntime = unavailable && !params.length ? chainRuntimeFor(e) : ''
        return (
          <article
            key={e.id}
            style={firstEntry ? stagger(i) : undefined}
            className={cn(
              // 边框 / 悬浮 / 焦点统一到令牌 v2：默认 --line，hover（.card-lift）与键盘焦点都抬到 --line-strong。
              'card-lift flex cursor-pointer flex-col rounded-lg border border-line bg-surface elev-1 p-4',
              firstEntry && 'animate-card-in',
              'focus-visible:border-line-strong',
              unavailable && 'opacity-80',
            )}
            // 键盘可达：Enter / 空格与点击同效，焦点环由 base.css 的 :focus-visible 统一画。
            tabIndex={0}
            onClick={() => openDetail(e)}
            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDetail(e) } }}
          >
            <div className='flex items-start gap-3'>
              <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', e.installed ? 'bg-primary-soft text-primary' : 'bg-sunken text-ink-3')}>
                {catalogIcon(e.id)}
              </span>
              <div className='min-w-0 flex-1'>
                <div className='flex items-center gap-1.5'>
                  <h3 className='truncate text-13 font-medium text-ink'>{e.name || e.id}</h3>
                  {e.installed ? <CheckCircle2 size={13} className='shrink-0 text-ok' /> : null}
                </div>
                <div className='mt-0.5 text-11 text-ink-4'>{catalogCategory(e.id)}</div>
              </div>
            </div>
            <p className='mt-2.5 line-clamp-2 flex-1 text-12 leading-[1.6] text-ink-3'>{e.description || '暂无描述'}</p>
            {unavailable ? (
              <p className='mt-2 line-clamp-2 text-11 leading-[1.6] text-warn'>{e.unavailable_reason}</p>
            ) : null}
            {!unavailable && params.length ? (
              <p className='mt-2 text-11 text-ink-4'>安装时要填 {params.length} 个参数：{params.map((p) => p.label).join('、')}</p>
            ) : null}
            <div className='mt-3 flex flex-wrap items-center gap-1.5'>
              {e.installed ? (
                <>
                  <Badge tone='ok'>已安装</Badge>
                  <span className='flex-1' />
                  <Button variant='ghost' size='sm' onClick={(ev) => { ev.stopPropagation(); openDetail(e) }}>详情</Button>
                  <Button variant='ghost' size='sm' disabled={busy.has(e.id)} onClick={(ev) => { ev.stopPropagation(); void removeEntry(kind, e.id) }}>
                    <Trash2 size={13} /> 卸载
                  </Button>
                </>
              ) : unavailable ? (
                <>
                  <Badge tone='warn'>本机不可用</Badge>
                  <span className='flex-1' />
                  {missingRuntime ? (
                    <Button
                      variant='primary'
                      size='sm'
                      title={'先装上 ' + runtimeLabel(missingRuntime) + '，再自动装这条（一张进度卡两步）'}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        setChainTarget({ entry: e, runtimeId: missingRuntime, runtimeName: runtimeLabel(missingRuntime) })
                      }}
                    >
                      <Wrench size={13} /> 一键装环境并安装
                    </Button>
                  ) : (
                    <Button variant='primary' size='sm' onClick={(ev) => { ev.stopPropagation(); openHelp(e) }}>
                      <Wrench size={13} /> 怎么装
                    </Button>
                  )}
                  <Button variant='secondary' size='sm' disabled={rechecking} onClick={(ev) => { ev.stopPropagation(); setNotice('正在重新检测运行环境…'); void recheckAll() }}>
                    {rechecking ? <Spinner /> : <RefreshCw size={13} />} {rechecking ? '正在重新检测…' : '我已装好，重新检测'}
                  </Button>
                </>
              ) : (
                <>
                  {params.length ? <Badge tone='warn'>需填参数</Badge> : null}
                  <span className='flex-1' />
                  <Button variant='ghost' size='sm' onClick={(ev) => { ev.stopPropagation(); openDetail(e) }}>详情</Button>
                  <Button
                    variant='primary'
                    size='sm'
                    disabled={busy.has(e.id)}
                    title={params.length ? '先填好必填参数，再安装' : '直接安装这条'}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      startInstall(e, kind)
                    }}
                  >
                    <Download size={13} /> 安装
                  </Button>
                </>
              )}
            </div>
          </article>
        )
      })}
    </div>
    <ListPager
      loaded={marketPager.shown}
      total={list.length}
      hasMore={marketPager.hasMore}
      onLoadMore={marketPager.loadMore}
    />
    </>
  )

  /** 远程源视图的左轨：六个远程源（取自 components/skills/remoteSources.ts）。 */
  const sourceItems = REMOTE_SOURCES.map((s) => ({ key: s.key, label: s.label, hint: s.hint }))

  /** 这一次渲染要不要省掉过渡（动效开关 / 减少动态效果 / 省电档）：一回渲染只问一次。 */
  const instantShift = shiftInstant()

  /** 舞台每一格的位移与透明度：当前那份按「落位没有」决定，退场那份退到反方向 8px。 */
  const panelStyle = (current: boolean, outgoing: boolean): React.CSSProperties => {
    const transition = instantShift
      ? undefined
      : 'transform ' + SHIFT_MS + 'ms ' + SHIFT_EASE + ', opacity ' + SHIFT_MS + 'ms ' + SHIFT_EASE
    if (current) {
      // 起步态那一帧必须**没有过渡**：过渡属性若和位移同一次样式变更生效，浏览器会从
      // 「上一格的位置」补一段（0 → 8px），新内容就会先滑出去再滑回来，看着像抖一下。
      if (!entered) {
        return { transition: 'none', willChange: 'transform, opacity', transform: 'translateX(' + dir * SHIFT_PX + 'px)', opacity: 0 }
      }
      return { transition, willChange: 'transform, opacity', transform: 'translateX(0px)', opacity: 1 }
    }
    if (outgoing) {
      return { transition, willChange: 'transform, opacity', transform: 'translateX(' + (-dir * SHIFT_PX) + 'px)', opacity: 0 }
    }
    return { opacity: 0 }
  }

  /** 一块内容（子视图 + 分段）：工具条（分段 / 搜索 / 状态条）+ 左轨（分类或远程源）+ 正文。
      只有「当前内容键」会走到这里；退场那一份直接复用缓存节点（见 panelCache），不参与重渲染。
      注意：这里读的 list / installedList / 搜索词都是**当前内容键**算出来的那一份。 */
  const renderPanel = (key: ContentKey): ReactNode => {
    const here = partsOf(key)
    // 全局搜索框只对内置目录（技能/工具/更新）与「已安装」有意义：远程源与第三方页自带搜索，
    // 「任务」子视图没有可过滤的目录列表。
    const showSearch = (here.view === 'market' && here.seg !== 'third') || here.view === 'installed'
    /// 运行环境状态条：工具市场（内置 + 远程源）与技能市场都要看得到，与改造前一致。
    const showRuntimeBar = here.view === 'remote' || (here.view === 'market' && here.seg !== 'updates')
    const toolsRail = here.view === 'market' && here.seg === 'tools'
    return (
      <div className='flex min-h-0 flex-1 flex-col'>
        <div className='flex flex-wrap items-center gap-3'>
          {here.view === 'market' ? (
            /* 市场里的三个分段：技能 / 工具 / 更新，指示器与改造前同一枚（会滑过去）。 */
            <Segmented<MarketSeg>
              size='lg'
              value={here.seg}
              options={MARKET_SEGS.map((s) => ({ value: s.key, label: s.label }))}
              onChange={(next) => goTo(segKey(next))}
              ariaLabel='市场分段'
              className='shrink-0 border-line bg-muted'
            />
          ) : here.view === 'installed' ? (
            /* 已安装的两个分段：工具（MCP）/ 技能（Skills）各带计数；右边一条统计按全量算。 */
            <Segmented<'mcp' | 'skills'>
              size='lg'
              value={installedKind}
              options={[
                { value: 'mcp', label: <span className='flex items-center gap-1.5'>工具（MCP）<span className='tabular-nums text-ink-4'>{installedCounts.mcp}</span></span> },
                { value: 'skills', label: <span className='flex items-center gap-1.5'>技能（Skills）<span className='tabular-nums text-ink-4'>{installedCounts.skills}</span></span> },
              ]}
              onChange={(next) => goTo(kindKey(next))}
              ariaLabel='已安装分段'
              className='border-line bg-muted'
            />
          ) : null}
          {showSearch ? (
            <div className='relative max-w-[260px] flex-1'>
              <Search size={13} className='pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4' />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder='搜索工具 / 技能' className='pl-7' />
            </div>
          ) : null}
          {here.view === 'installed' ? (
            <span className='text-12 text-ink-3'>
              共 <span className='tabular-nums text-ink-2'>{installedCounts.total}</span>
              <span className='px-1 text-ink-4'>·</span>
              运行中 <span className='tabular-nums text-ink-2'>{installedCounts.running}</span>
            </span>
          ) : null}
        </div>
        {showRuntimeBar ? (
          <RuntimeBar
            onRecheck={recheckAll}
            onInstallRuntime={(id, label) => setRuntimeTarget({ id, label })}
          />
        ) : null}
        <div className='flex min-h-0 flex-1 gap-4 pt-4'>
          {toolsRail ? (
            <aside className='w-[168px] shrink-0 overflow-y-auto'>
              <div className='mb-1 px-3 text-11 text-ink-4'>分类</div>
              {categories.map((c) => (
                <RailItem
                  key={c}
                  active={category === c}
                  label={c}
                  count={sourceList.filter((e) => c === '全部' || catalogCategory(e.id) === c).length}
                  onClick={() => setCategory(c)}
                />
              ))}
            </aside>
          ) : null}
          {here.view === 'remote' ? (
            <aside className='w-[168px] shrink-0 overflow-y-auto'>
              <div className='mb-1 px-3 text-11 text-ink-4'>来源</div>
              {sourceItems.map((item) => (
                <RailItem
                  key={item.key}
                  active={source === item.key}
                  label={item.label}
                  hint={item.hint}
                  onClick={() => {
                    setSource(item.key)
                    setRemoteSource(item.key)
                    setNotice('')
                  }}
                />
              ))}
            </aside>
          ) : null}
          {/* 滚到离底 240px 内自动续下一页（见 usePagedList）：远程源那一份自己带滚动容器，这里只管内置两套列表。
              内置列表没有网络往返，一次手势里几十个 scroll 事件会把页码一路顶到最后一页，所以节流 400ms。 */}
          <div
            className={cn('min-h-0 flex-1', here.view === 'remote' || here.view === 'tasks' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto')}
            onScroll={(event) => {
              const el = event.currentTarget
              if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return
              const now = Date.now()
              if (now - lastAutoLoad.current < 400) return
              lastAutoLoad.current = now
              if (here.view === 'market') marketPager.loadMore()
              else if (here.view === 'installed') installedPager.loadMore()
            }}
          >
            {/* 首屏加载：目录还没回来时先铺卡片骨架，不再出现「正在连接引擎…」这种一行字 */}
            {!ready || (catalogPending && here.view !== 'remote' && here.view !== 'tasks') ? (
              <div className='grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3'>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <SkeletonCard key={i} style={stagger(i)} className='animate-card-in' />
                ))}
              </div>
            ) : here.view === 'tasks' ? (
              /* 「任务」子视图：列表 / 日志 / 参数都由 TaskBoard 自己管，这里只负责把它放进舞台。 */
              <TaskBoard />
            ) : here.view === 'installed' ? (
              renderInstalled()
            ) : here.view === 'remote' ? (
              /* 换远程源：容器重放入场动画，浏览器组件本身不重挂载（内部状态与已拉取结果都留着） */
              <SwapIn token={'remote:' + source} className='flex min-h-0 flex-col'>
                <RemoteMcpBrowser
                  sourceKey={source}
                  builtinIds={builtinIds}
                  installedIds={installedIds}
                  configPath={configPath}
                  onInstallBuiltin={openBuiltinInstall}
                  onNotice={writeNotice}
                  onInstalled={onRemoteInstalled}
                />
              </SwapIn>
            ) : here.view === 'market' && here.seg === 'third' ? (
              /* 第三方页：官方清单 + 自定义清单两个来源，浏览器自带搜索/分页/去重。 */
              <SwapIn token={'skill-market:' + (installed.skills ?? []).length} className='flex min-h-0 flex-col'>
                <SkillMarketBrowser
                  installedSkills={installed.skills ?? []}
                  onNotice={writeNotice}
                  onChanged={refresh}
                />
              </SwapIn>
            ) : (
              <>
                {!list.length ? (
                  <Empty
                    art='search'
                    title={query.trim() ? '没有匹配的结果' : '这一分类下没有条目'}
                    description={query.trim() ? '换个关键词，或清空搜索框看这一分类的全部条目。' : '换个分类，或去「远程源」视图里找找。'}
                  />
                ) : null}
                {renderCards(here.kind)}
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  /* 页头 + 视图导航：**首帧壳与正文共用同一份**。外壳照画这一层，
     于是「骨架 → 正文」那一跳里页头与分段控件始终在原位，切换那一帧不跳版。
     分段控件仍然可点（goSubView 改的是 content，正文那一帧直接按新键渲染）。 */
  const pageTop = (
    <>
      <PageHeader
        title='技能中心'
        description='为 Coomi 添加新能力。发现技能、连接工具，在这里管理每一项任务。'
        actions={<Button variant='ghost' size='md' onClick={() => void refresh()}><RefreshCw size={14} /> 刷新</Button>}
      />
      {/* 视图导航：三个视图一条分段控件（滑动指示器），左边是说明「现在在哪一层」的面包屑。 */}
      <div className='flex flex-wrap items-center gap-3 px-8'>
        <nav aria-label='面包屑' className='flex shrink-0 items-center gap-1.5 text-12 text-ink-4'>
          <span>技能中心</span>
          <ChevronRight size={12} aria-hidden className='shrink-0' />
          <span className='text-ink-2'>{SUB_LABEL[view]}</span>
          {view === 'market' ? (
            <>
              <ChevronRight size={12} aria-hidden className='shrink-0' />
              <span className='text-ink-2'>{SEG_LABEL[marketSeg]}</span>
            </>
          ) : null}
        </nav>
        <Segmented<SubView>
          size='lg'
          value={view}
          options={SUB_VIEWS.map((v) => ({ value: v.key, label: v.label }))}
          onChange={goSubView}
          ariaLabel='技能中心视图'
          className='shrink-0 border-line bg-muted'
        />
      </div>
      {notice ? <p className='px-8 pt-2 text-12 text-ink-3'>{notice}</p> : null}
      {storeError ? <p className='px-8 pt-2 text-12 text-danger'>{storeError}</p> : null}
    </>
  )

  /* ── 首帧壳 ──
     与设置页同一条原则：首帧只画外壳，整棵舞台（renderPanel：工具条 + 左轨 + 卡片网格，
     以及每次渲染都要为退场快照重算的那一份）挪到外壳画过之后再算。
     骨架复用页面里原本就有的那张「目录还没回来」的骨架（SkeletonCard 六张），
     所以首帧看到的就是今天目录未加载时的样子 —— 没有引入任何新形态。
     取数照旧从挂载那一刻起并行跑（ensureFresh），正文那一帧数据通常已经在手。 */
  if (!firstFrameReady) {
    return (
      <main data-skills-page data-skills-shell className='flex min-h-0 flex-1 flex-col bg-canvas'>
        {pageTop}
        <div data-skill-stage className='relative min-h-0 flex-1 overflow-hidden'>
          <div className='absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden px-8 pb-4 pt-2'>
            <div className='grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3'>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <SkeletonCard key={i} style={stagger(i)} className='animate-card-in' />
              ))}
            </div>
          </div>
        </div>
      </main>
    )
  }

  // 当前内容每次渲染都重算，并覆盖缓存里的那一份：退场时就拿它当冻结快照（引用不变 → 不重渲染）。
  panelCache.current.set(content, renderPanel(content))

  return (
    <main data-skills-page className='flex min-h-0 flex-1 flex-col bg-canvas'>
      {pageTop}
      {/* ── 视图舞台 ──
          CONTENT_ORDER 的六个内容键各占一个**固定位置**的容器（DOM 顺序恒定，过渡不会被重排打断）：
          当前那份渲染正文，正在退场的那份复用上一次的节点（冻结，最多留一份），其余是空壳。
          方向性：新内容从 dir×8px 处淡入，老内容向反方向退 8px 淡出，180ms / --ease-soft。 */}
      <div data-skill-stage className='relative min-h-0 flex-1 overflow-hidden'>
        {CONTENT_ORDER.map((key) => {
          const current = key === content
          const outgoing = !current && key === leaving
          return (
            <div
              key={key}
              data-skill-panel={key}
              data-skill-panel-state={current ? 'current' : outgoing ? 'leaving' : 'idle'}
              inert={!current}
              aria-hidden={!current}
              className={cn(
                'absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden px-8 pb-4 pt-2',
                !current && 'pointer-events-none',
              )}
              style={panelStyle(current, outgoing)}
            >
              {current || outgoing ? panelCache.current.get(key) ?? null : null}
            </div>
          )
        })}
      </div>
      <Dialog
        open={!!detail}
        onOpenChange={(open) => { if (!open) setDetail(null) }}
        title={detail?.name || detail?.id || ''}
        width={520}
        footer={
          detail ? (
            <>
              <Button variant='ghost' onClick={() => setDetail(null)}><X size={13} /> 关闭</Button>
              {detail.installed ? (
                <Button variant='danger' disabled={busy.has(detail.id)} onClick={() => { void removeEntry(detailKind, detail.id); setDetail(null) }}>卸载</Button>
              ) : detail.available === false ? (
                <Button variant='primary' onClick={() => { const entry = detail; setDetail(null); openHelp(entry) }}>
                  <Wrench size={13} /> 怎么装
                </Button>
              ) : (
                <Button
                  variant='primary'
                  disabled={busy.has(detail.id)}
                  onClick={() => { const entry = detail; setDetail(null); startInstall(entry, detailKind) }}
                >
                  <Download size={13} /> {(detail.required_parameters ?? []).length ? '填写参数并安装' : '安装'}
                </Button>
              )}
            </>
          ) : null
        }
      >
        {detailBody}
      </Dialog>
      <InstallParamsDialog
        open={!!installTarget}
        onOpenChange={(open) => { if (!open) setInstallTarget(null) }}
        entry={installTarget}
        busy={!!installTarget && busy.has(installTarget.id)}
        onSubmit={async (values) => {
          const entry = installTarget
          if (!entry) return
          await installTool(entry, values)
          setInstallTarget(null)
        }}
      />
      <RuntimeHelpDialog
        open={!!help}
        onOpenChange={(open) => { if (!open) setHelp(null) }}
        target={help?.target ?? null}
        reason={help?.reason ?? ''}
        entryName={help?.entryName ?? ''}
        onRecheck={recheckAll}
        onOneClick={help?.target ? () => {
          const target = help?.target
          setHelp(null)
          if (target) setRuntimeTarget({ id: target.id, label: target.label })
        } : undefined}
      />

      {/* 一键装运行环境（状态条 / 灰显条目 / 怎么装弹窗里的入口都落到这一张卡） */}
      <RuntimeInstallDialog
        open={!!runtimeTarget}
        onOpenChange={(open) => { if (!open) setRuntimeTarget(null) }}
        runtimeId={runtimeTarget?.id ?? null}
        runtimeIdLabel={runtimeTarget?.label}
        onRecheck={recheckAll}
      />

      {/* 缺运行环境的条目：两步卡（先装环境，再自动装这条） */}
      <ChainInstallDialog
        open={!!chainTarget}
        onOpenChange={(open) => { if (!open) setChainTarget(null) }}
        runtimeId={chainTarget?.runtimeId ?? ''}
        runtimeName={chainTarget?.runtimeName}
        toolName={chainTarget ? (chainTarget.entry.name || chainTarget.entry.id) : ''}
        onInstallTool={async () => (chainTarget ? await installCatalogOutcome(chainTarget.entry) : EMPTY_TOOL_OUTCOME)}
        onRecheck={recheckAll}
        onInstalled={(outcome) => {
          const entry = chainTarget?.entry
          if (!entry) return
          const name = entry.name || entry.id
          echoInstalled(name, {
            name,
            ok: outcome.ok,
            saved: outcome.ok,
            connected: outcome.connected,
            toolsCount: outcome.toolsCount,
            error: outcome.error,
          })
        }}
      />
    </main>
  )
}
