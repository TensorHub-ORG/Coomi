import { Suspense, lazy, memo, startTransition, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { AppToaster } from './components/ui/AppToaster'
import { Group, Panel, usePanelRef, type PanelSize } from 'react-resizable-panels'
// motion 按需入口：全站只在根上挂一次 LazyMotion + domAnimation，
// 组件里一律用 m.*（不要 import 全量 motion），features 不重复加载。
import { LazyMotion, domAnimation } from 'motion/react'
import { PluginViewHost } from './components/plugins/PluginViewHost'
import { usePluginViews } from './stores/pluginViews'
import { TooltipProvider } from './components/ui/Overlay'
import { PanelSeparator } from './components/shell/ResizeHandle'
import { TitleBar } from './components/shell/TitleBar'
import { Rail } from './components/shell/Rail'
import { ListPane } from './components/shell/ListPane'
import { RightDock } from './components/shell/RightDock'
import { ContextMenuHost } from './components/ui/ContextMenuHost'
// 首次启动的三步引导（隐私与使用说明，强制勾选）：组件自身懒加载，同意过就不下载那份文案。
import { OnboardingGate } from './components/onboarding/OnboardingGate'
import { ChatView } from './views/ChatView'
import { DialogHost } from './components/ui/DialogHost'
import { useEngine } from './stores/engine'
// 插件：启动时拉一次插件清单并应用已选插件主题（壳命令缺失时 store 内部降级，不影响启动）。
import { usePluginStore } from './components/plugins/pluginStore'
import { useLibrary } from './stores/library'
import { markCollapseMotion } from './components/chat/collapseMotion'
import { startPluginClients, usePluginClientViews, findPluginClientView } from './components/plugins/clientRuntime'
import { PluginClientViewHost } from './components/plugins/PluginClientViewHost'
import { readDraft, readLastSession, useSession } from './stores/session'
// 启动引导的决策逻辑抽成纯函数：它漏过一个分支（空会话列表），造成过真机最难查的一次故障，
// 现在有 tests/check-bootstrap.mjs 盯着它。
import { pickStartupSession } from './lib/bootstrap'
import { useUi, type ViewKey } from './stores/ui'
import { cn } from './lib/cn'
// 渲染风暴探针：四个页面各挂一枚 React.Profiler，1 秒内提交超过 20 次就记录一次并自动切安全模式。
import { profilerOf, setStormListener } from './lib/stormProbe'
import { safeMode, setSafeMode, setSafeOverride } from './lib/guard'
// 切页过渡的「让路」闸门与隐藏页判据：外壳级基建，App 只负责开闸（见下面的切页动效）。
import { NAV_PAUSE_MS, PANE_ENTER_MS, PANE_EXIT_MS, PaneActiveProvider, endNavPause, markNavPause, navPauseBusy } from './components/shell/navPause'
import {
  COMPOSER_ZONE_H,
  DOCK_BAR_W,
  LIST_MAX_W,
  LIST_MIN_W,
  MAIN_MIN_W,
  PANEL_MIN_W,
  RAIL_W,
  panelMaxWidth,
  LIST_W,
  PANEL_DEFAULT_W,
  useDockWidth,
  useListPaneLayout,
  useListWidth,
  useViewportWidth,
} from './components/shell/dockShared'

/** 固定顺序：切页时 DOM 顺序不变，只切显示状态，动画与滚动位置才稳定。 */
const VIEW_ORDER: ViewKey[] = ['chat', 'skills', 'artifacts', 'settings']

/** 同时保持挂载的视图上限（当前 + 最近 3 个）：见 liveViews 的说明。 */
const LIVE_VIEWS_KEEP = 4

/* ── 路由级代码分割 ──
   对话页是首屏必需，静态引入；技能中心 / 产物中心 / 设置页各自成 chunk，
   只在真正切到那一页时才下载 —— 设置页（41KB 源码）与技能中心（41KB + 一堆对话框）
   原本全压在首屏主包里，首屏体积因此有一大截是「用户还没看的东西」。
   加载失败不做静默降级：chunk 拿不到就是拿不到，交给 React 抛错好过白屏。 */

/* ── chunk 就绪表：切页时间轴「要不要等动画」只看这张表 ──
   为什么需要它：切页时间轴原来把「挂正文」硬编码在**进场动画之后**（PANE_ENTER_MS=240ms），
   于是哪怕 chunk 早就在模块缓存里，每次切页也要先空等满 240ms —— 那 240ms 里主线程
   什么都没加载，纯粹在等定时器，用户看到的就是「点了以后卡一下才出内容」（真机 1~2 秒）。
   判据只有一个：目标页的 chunk 到没到。lazy() 的工厂是**唯一**真正加载 chunk 的地方，
   所以「就绪」就登记在那里（预取走的是同一个 import()，命中模块缓存，顺带补登记）。
   登记之后，App 的切页分支据此走「立刻挂正文」那条短时间轴（见下面切页 effect）。 */
const chunkReady = new Set<ViewKey>(['chat'])

const SkillsView = lazy(() => import('./views/SkillsView').then((m) => {
  chunkReady.add('skills')
  return { default: m.SkillsView }
}))
const ArtifactsView = lazy(() => import('./views/ArtifactsView').then((m) => {
  chunkReady.add('artifacts')
  return { default: m.ArtifactsView }
}))
const SettingsView = lazy(() => import('./views/SettingsView').then((m) => {
  chunkReady.add('settings')
  return { default: m.SettingsView }
}))

/** 这一页能不能「不等动画直接出内容」：静态引入的对话页天然可以；
    懒加载页看 chunk 是否已就绪 —— 没就绪就只能先挂骨架（由 Suspense 换成正文）。 */
function viewContentReady(key: ViewKey): boolean {
  return chunkReady.has(key)
}

/* 全局浮层同理：审批弹窗、追问弹窗、命令面板（Ctrl+K）首屏都不是必需的，
   各自成 chunk 之后主包只留「一定会用到」的东西。
   命令面板**两个都开**：只在真的按过 Ctrl+K 之后才挂载，所以它的 chunk
   也只在那时才下载（一直挂着 open=false 的 Dialog 会白白把这份代码拉下来）。 */
const ApprovalDialog = lazy(() => import('./components/chat/Dialogs').then((m) => ({ default: m.ApprovalDialog })))
const QuestionDialog = lazy(() => import('./components/chat/Dialogs').then((m) => ({ default: m.QuestionDialog })))
const CommandPalette = lazy(() => import('./components/shell/CommandPalette').then((m) => ({ default: m.CommandPalette })))

/* ── 页面组件表：零 props 的页面再包一层 memo ──
   App 会因为引擎就绪、会话标题、UI 开关这些变化重渲染，页面本身不接 props、
   各自订阅自己的 store，所以父组件的重渲染对它们毫无意义 —— 而在「切页那一拍」
   这件事代价最大：过渡回调里那一次同步渲染会把**已挂载的整页**再渲染一遍
   （长会话、长列表都在里面），挂载成本就这么被塞回过渡回调里了。
   memo 之后重渲染到这一层就停住：切页那一拍只新挂一份骨架，正文再晚一步挂。 */
const PAGE: Record<ViewKey, ComponentType> = {
  chat: memo(function ChatPage() { return <ChatView /> }),
  skills: memo(function SkillsPage() { return <SkillsView /> }),
  artifacts: memo(function ArtifactsPage() { return <ArtifactsView /> }),
  settings: memo(function SettingsPage() { return <SettingsView /> }),
}

/* ── 探针挂载点 + 显示名 ──
   ① 每一页外面再包一层 React.Profiler：onRender 就是「这一页提交了一次」，
      1 秒内超过 20 次 = 渲染风暴（见 lib/stormProbe.ts）；
   ② 显式写死 displayName：**这一层就是以后报错栈里的名字**。构建产物里函数名会被压成
      FB / MT 这种两个字母，没有 displayName 的话 componentStack 根本读不出是谁在刷。
      Profiler 的 id 用同一个名字，控制台记录与报错栈因此对得上。 */
const PAGE_NAME: Record<ViewKey, string> = {
  chat: 'ChatPage',
  skills: 'SkillsPage',
  artifacts: 'ArtifactsPage',
  settings: 'SettingsPage',
}
const PROBED: Record<ViewKey, ComponentType> = {
  chat: buildProbedPage('chat'),
  skills: buildProbedPage('skills'),
  artifacts: buildProbedPage('artifacts'),
  settings: buildProbedPage('settings'),
}

function buildProbedPage(key: ViewKey): ComponentType {
  const Page = PAGE[key]
  const name = PAGE_NAME[key]
  const Probed = function ProbedPage(): ReactNode { return profilerOf(name, <Page />) }
  Probed.displayName = name
  // memo 之后父组件（App）的重渲染到这一层就停住，探针只统计这一页自己的提交。
  const M = memo(Probed)
  M.displayName = name + 'Probe'
  return M
}

/** 探针 → 自动切安全模式并提示一次（注入点只有这一处）。 */
function onStorm(record: { component: string; commits: number; elapsedMs: number; renderMs: number }): void {
  if (safeMode()) return
  // 落盘 + 进程内一起开：下一次启动第一帧就是精简模式，不会再卡一次
  // （?safe=1 与 localStorage 两条退路见 lib/guard.ts）。
  setSafeOverride(true)
  setSafeMode(true)
  toast.error('界面出现渲染风暴，已自动切到安全模式', {
    description: record.component + ' 在 ' + Math.round(record.elapsedMs) + 'ms 内提交了 ' + record.commits
      + ' 次，渲染耗时 ' + Math.round(record.renderMs) + 'ms。动效、富预览与语法高亮已关闭。',
    id: 'coomi-render-storm',
    duration: 12_000,
  })
}

/* ── 面板内容容器 ──
   react-resizable-panels 的 Panel 把 className 落在内层 div 上，那层默认 overflow:auto，
   不盖掉就会在侧栏里多出一条滚动条；overflow 是唯一能用 style 覆盖的内联样式。 */
const PANEL_BOX = 'flex min-h-0 min-w-0 flex-col'
const PANEL_CLIP: React.CSSProperties = { overflow: 'hidden' }

/* ── 页面级过渡：**一条确定的路** ──
   换页动效只有一条路径：pane 自己按方向 class 播 CSS **动画**
   （pane-enter-right/left + pane-exit-right/left，规则在 base.css）。
   为什么是动画不是过渡：过渡要有「起点已经被画过一帧」才播得出来，而换页那一拍内容列
   正是空帧/骨架——过渡抓到空帧就什么都不播，这就是上一版「切页没动画」的根因。
   @keyframes 不读前一帧的值，class 挂上就播，所以这里一律用动画。
   View Transitions 降级成**实验开关**（默认关，见 vtExperimentOn）：
   能力位 html[data-vt] 保留，但默认不再走「先翻指针、下帧再挂内容」那条快照路。 */
type ViewTransitionLike = { finished: Promise<void>; updateCallbackDone: Promise<void> }
type StartViewTransition = (callback: () => void | Promise<void>) => ViewTransitionLike

/** 老 WebView2 没有这个 API：返回 null 就是「不支持」，不是错误。 */
function viewTransitionStarter(): StartViewTransition | null {
  const doc = document as unknown as { startViewTransition?: StartViewTransition }
  return typeof doc.startViewTransition === 'function' ? doc.startViewTransition.bind(document) : null
}

/** View Transitions 实验开关（默认关）：壳支持（html[data-vt='on']）**且**用户显式
   把 localStorage 的 coomi.vt 设成 'on' 才启用。省电档一律不启用——
   拍整页快照再逐帧合成是那一档里最贵的一件事。 */
const VT_EXPERIMENT_KEY = 'coomi.vt'
function vtExperimentOn(): boolean {
  const root = document.documentElement
  if (root.dataset.vt !== 'on') return false
  if (root.dataset.perf === 'low') return false
  try { return window.localStorage.getItem(VT_EXPERIMENT_KEY) === 'on' } catch { return false }
}

/** 动效开关与系统「减少动态效果」任一为真就整个跳过动画（瞬时换页，不闪不滑）。
    省电档（html[data-perf=low]）**不在**这里排除：它仍走同一条动画路径，
    只是 base.css 把位移与错峰归零，只留纯淡入——一条路径、两种力度，好过两条路各修一遍。 */
function motionAllowed(): boolean {
  /* 切页动画整体停用：切页直接换，不播方向动画、不开让路闸门、不进 ViewTransition。
     原因不是「动画不好看」，是它会卡：浏览器在快照冻结期完全不绘制，
     快速连点时每次点击又都在重置那条 140+240ms 的计时器 → 界面冻结、
     必须等动画播完才能换页（Chrome《How To Improve INP: View Transitions》讲的就是这个）。
     减动效开关仍照旧生效；这里是无条件关闭。 */
  return false
}

/** 导航方向：沿视图顺序往后走＝forward（新页从右侧进），往回走＝back。
    插件页（v2.1）不在 VIEW_ORDER 里：indexOf 返回 -1，于是「从核心页进插件页」是 forward、
    「从插件页回核心页」是 back —— 恰好是想要的方向，不用额外分支。 */
function navDirection(from: ViewKey, to: ViewKey): 'forward' | 'back' {
  const toIndex = VIEW_ORDER.indexOf(to)
  const fromIndex = VIEW_ORDER.indexOf(from)
  if (toIndex < 0) return 'forward'
  if (fromIndex < 0) return 'back'
  return toIndex < fromIndex ? 'back' : 'forward'
}

/* ── 插件页面的组件表（v2.1）──
   按 key 缓存：每次渲染都新建一个 memo 组件会让整页重挂载（滚动位置、iframe 状态全丢）。 */
const PLUGIN_PAGES = new Map<string, ComponentType>()
function pluginPage(key: string): ComponentType {
  const cached = PLUGIN_PAGES.get(key)
  if (cached) return cached
  const Page: ComponentType = memo(function PluginPage() { return <PluginViewHost viewKey={key} /> })
  PLUGIN_PAGES.set(key, Page)
  return Page
}

/* ── 客户端插件页面的组件表 ──
   与声明式插件页分开缓存：两者虽然都按 key 缓存，但渲染的东西不同 ——
   声明式是 iframe（隔离），客户端插件渲染插件自己的 React（全信任）。 */
const PLUGIN_CLIENT_PAGES = new Map<string, ComponentType>()
function pluginClientPage(key: string): ComponentType {
  const cached = PLUGIN_CLIENT_PAGES.get(key)
  if (cached) return cached
  const Page: ComponentType = memo(function PluginClientPage() { return <PluginClientViewHost viewKey={key} /> })
  PLUGIN_CLIENT_PAGES.set(key, Page)
  return Page
}

/** 视图 → 页面组件：核心四页查表，插件页现取（并缓存）。 */
function pageFor(key: ViewKey): ComponentType {
  const core = PROBED[key as 'chat'] as ComponentType | undefined
  if (core) return core
  const text = String(key)
  // `client:` 前缀 = 客户端插件注册的页面（渲染插件自己的 React）。
  return text.startsWith('client:') ? pluginClientPage(text) : pluginPage(text)
}

/** pane 在这次换页里的角色：进（在最上层滑入）/ 退（淡出后卸载）。 */
type PaneAnim = 'enter' | 'exit'

/** 这一拍换页的角色分配：谁进、谁退、往哪边。 */
interface NavState { seq: number; from: ViewKey; to: ViewKey; dir: 'forward' | 'back' }

/** 角色 + 方向 → 方向 class（base.css 里那四条规则，class 名就是「往哪边走」）。 */
function paneAnimClass(role: PaneAnim, dir: 'forward' | 'back'): string {
  if (role === 'enter') return dir === 'forward' ? 'pane-enter-right' : 'pane-enter-left'
  return dir === 'forward' ? 'pane-exit-left' : 'pane-exit-right'
}

/** 抽屉底边停在 Composer 输入区上方：先量输入框上沿，量不到时退回固定留白。
    抽屉是浮层，绝不能盖住输入框——否则窄窗口下用户连字都打不了。 */
function useComposerZoneHeight(active: boolean, shellRef: RefObject<HTMLDivElement | null>): number {
  const [zone, setZone] = useState(COMPOSER_ZONE_H)
  /// 当前值另存一份：观测器回调里读 ref，不把 zone 放进 effect 依赖（否则每次量完都要重挂观测器）。
  const zoneRef = useRef(zone)
  useEffect(() => {
    if (!active) return
    const area = document.querySelector('[data-chat-col] textarea')
    const shell = shellRef.current
    let frame = 0
    let disposed = false
    /// 观测器 / resize 的回调可能一帧来好几次：先合并到一拍 rAF，再比一次值。
    /// 值没变就**不 setState** —— 这是「量尺寸 → 改 state → 触发重排 → 再量」那条自激环路的断点。
    const commit = (next: number): void => {
      if (next === zoneRef.current) return
      zoneRef.current = next
      setZone(next)
    }
    const read = (): void => {
      if (disposed) return
      frame = 0
      if (!area || !shell) { commit(COMPOSER_ZONE_H); return }
      const rect = area.getBoundingClientRect()
      const shellRect = shell.getBoundingClientRect()
      commit(Math.max(COMPOSER_ZONE_H, Math.round(shellRect.bottom - rect.top + 8)))
    }
    const measure = (): void => { if (frame === 0) frame = window.requestAnimationFrame(read) }
    read()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (observer && area?.parentElement) observer.observe(area.parentElement)
    return () => {
      disposed = true
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [active, shellRef])
  return zone
}

/** 页面 chunk 的取数入口：同一份 import() 只写一次，
   空闲预热、悬停预热、按下预热这三条路都走它（重复调用命中模块缓存，不会重复请求）。 */
const VIEW_CHUNK: Partial<Record<ViewKey, () => Promise<unknown>>> = {
  skills: () => import('./views/SkillsView'),
  artifacts: () => import('./views/ArtifactsView'),
  settings: () => import('./views/SettingsView'),
}

/** 正在取、还没回来的那一页：pointerover 会随着指针在按钮里挪动反复触发，
    同一页在途时直接短路，免得每次都新建一条 promise 链（对同一个 URL 的重复 import() 会被
    模块系统缓存住，但仍然要新建 Promise 与回调；悬停事件密度不值得付这个）。 */
const chunkLoading = new Set<ViewKey>()

function prefetchView(key: ViewKey): void {
  const load = VIEW_CHUNK[key]
  if (!load || chunkLoading.has(key)) return
  chunkLoading.add(key)
  void load()
    // 取回来就登记进就绪表：切页时间轴据此走「不等动画」的快档（见切页 effect）。
    .then(() => { chunkReady.add(key) })
    // 失败要把在途标记也放开：这一下没取到不该让这一页永远走慢档（下次 hover 还能再试）。
    .catch(() => { chunkLoading.delete(key); chunkReady.delete(key) })
}

/** 首屏空闲时把三个非首页 chunk 预热掉：切页时它们已经在缓存里，
   而首屏该下载的东西一件都没被拖慢（空闲回调 / 2.5s 兜底，二者取先到）。 */
function warmViewChunks(): void {
  const warm = (): void => { for (const key of VIEW_ORDER) prefetchView(key) }
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
  if (typeof idle === 'function') idle(warm, { timeout: 2500 })
  else window.setTimeout(warm, 1200)
}

/* ── 切页那一拍的「让路」闸门 ──
   闸门本体（html[data-nav-busy] + 250ms 窗口 + 收闸时合并 flush）在
   components/shell/navPause.tsx：外壳里的轮询、页面里的观测器、这里的探活看门狗
   读的都是同一个判据，放在 App 里会让别人反向依赖 App。这里只负责开闸与收尾。 */

/** 目标页骨架：切过去的那一拍只画它（形状中性，四个页面共用一份）。
   正文要等过渡开播之后再挂 —— 见 App 里那次「两帧后落挂载」的注释。
   它同时是 chunk 还在路上时的 Suspense 占位（data-view-loading 这个标记保留）：
   「骨架 → 空面 → 内容」两跳看着就是闪一下，不如一路骨架到内容。 */
const SKELETON_BLOCKS = [96, 96, 64] as const

function ViewSkeleton() {
  return (
    // 高度一律写死、shrink-0：骨架与正文的占位高度对得上，切页时不会「先矮后高」
    // 把内容顶一下；外层 pane 是 absolute inset-0，所以换页过程中内容列一个像素都不动。
    <div data-view-loading data-view-skeleton aria-label='正在加载页面' className='flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 py-4'>
      <div className='skeleton shrink-0 rounded' style={{ height: 16, width: 144 }} />
      {SKELETON_BLOCKS.map((height, i) => (
        <div
          key={i}
          className='skeleton shrink-0 rounded-lg'
          style={{ height, width: i === SKELETON_BLOCKS.length - 1 ? '66%' : '100%' }}
        />
      ))}
    </div>
  )
}

/* ── 卸载页面的滚动位置记忆 ──
   四个页面只保留「当前 + 上一次」挂载，更早的整块卸载（省内存、也顺手停掉它们自己的
   定时器）。卸载前把滚动容器停在哪记下来，下次回来摆回原位。
   口径：按「页面内第 N 个可滚动元素（DOM 顺序）」记 —— 重挂之后顺序不变，所以对得上。
   它不是持久化：刷新就没了，和「轻量状态存 store、重活重算」是同一条取舍。 */
const paneScroll = new Map<string, number>()

interface PaneScrollState {
  slots: HTMLElement[]
  ordinals: WeakMap<Element, number>
}

/** 页面挂载壳：① 隐藏页停动效（CSS 认 data-view-state）② 卸载后恢复滚动位置
    ③ 「先播动画再挂内容」——live=false 时只挂骨架
    ④ 换页时内层拿一个方向 class（pane-enter-right/left、pane-exit-right/left），
       pane 本体只改角色与层叠。
    动画挂在**内层**而不是 pane 本体：pane 本体在「旧页仍是上一次那一页」时要一直留着 DOM
    （滚动位置、已渲染内容都在里面），内层的 class 换名即换动画，元素本身不重挂。 */
function ViewSlot({ name, active, live, anim, dir, children }: {
  name: ViewKey
  active: boolean
  live: boolean
  anim: PaneAnim | null
  dir: 'forward' | 'back'
  children: ReactNode
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    // 对话页不记：MessageList 自己的规矩是「切回一个会话就停在最新一条上」，
    // 摆回旧位置只会和它打架。其余三页卸载重挂后要回到用户离开时的那一屏。
    if (!host || name === 'chat') return
    const state: PaneScrollState = { slots: [], ordinals: new WeakMap() }
    const collect = (): void => {
      state.slots = []
      for (const el of host.querySelectorAll<HTMLElement>('*')) {
        if (el.scrollHeight - el.clientHeight > 1) {
          state.ordinals.set(el, state.slots.length)
          state.slots.push(el)
        }
      }
    }
    const onScroll = (event: Event): void => {
      const el = event.target
      if (!(el instanceof HTMLElement)) return
      if (!state.ordinals.has(el)) collect()
      paneScroll.set(name + '#' + (state.ordinals.get(el) ?? 0), el.scrollTop)
    }
    const restore = (): void => {
      collect()
      for (let at = 0; at < state.slots.length; at += 1) {
        const want = paneScroll.get(name + '#' + at)
        if (want) state.slots[at].scrollTop = want
      }
    }
    host.addEventListener('scroll', onScroll, { capture: true, passive: true })
    // 内容（懒加载 chunk、卡片）落定之前量不到真正的滚动高度：补两拍 + 两枪定时器。
    let inner = 0
    const outer = window.requestAnimationFrame(() => { inner = window.requestAnimationFrame(restore) })
    const late = [window.setTimeout(restore, 160), window.setTimeout(restore, 460)]
    return () => {
      window.cancelAnimationFrame(outer)
      if (inner) window.cancelAnimationFrame(inner)
      for (const t of late) window.clearTimeout(t)
      host.removeEventListener('scroll', onScroll, true)
    }
  }, [name])

  return (
    <div
      ref={hostRef}
      data-view-pane={name}
      data-view-state={active ? 'active' : 'inactive'}
      data-view-live={live ? 'true' : 'false'}
      data-pane-role={anim ?? (active ? 'active' : 'idle')}
      inert={!active}
      aria-hidden={!active}
      className='absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden'
    >
      {/* 隐藏页（「上一次」那一页）留着是为了滚动位置与已渲染内容，但它不该再干活：
          页面里读 usePaneActive() 的定时器/观测器会就地停掉，别躲在 opacity:0 后面空转。
          过渡期间它拿 pane-exit-*：这一层负责「淡出」，pane 本体的角色只管层叠与可点性
          （base.css 的 [data-pane-role] 一段，透明度不在这里重复管）。 */}
      <PaneActiveProvider active={active}>
        <div
          data-pane-anim={anim ?? undefined}
          className={cn('flex min-h-0 min-w-0 flex-1 flex-col', anim ? paneAnimClass(anim, dir) : null)}
        >
          <Suspense fallback={<ViewSkeleton />}>
            {live ? children : <ViewSkeleton />}
          </Suspense>
        </div>
      </PaneActiveProvider>
    </div>
  )
}

export default function App() {
  const view = useUi((s) => s.view)
  // 只订「就绪」这一个字段：原来 useEngine() 订的是整个引擎对象，而 usage 每来一个 token
  // 就会换一次引用——App（连同它下面挂着的整棵外壳）跟着每个 chunk 重渲染一次。
  const engineReady = useEngine((s) => s.ready)
  const loadSessions = useSession((s) => s.loadSessions)
  const sessionId = useSession((s) => s.sessionId)
  const openSession = useSession((s) => s.openSession)
  const streamTitle = useSession((s) => s.sessions.find((x) => x.id === sessionId)?.title)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  /* ── 「现在在哪一页」有四个口径，按「谁先动」排开 ──
     · view（store）：导航高亮与快捷键，点下去立刻跟手，不参与推迟；
     · shownView：**哪一页在最上层**（骨架也算）。过渡回调里同步翻的就是它 —— 新旧快照要分得开，
       但翻的只是一根指针：目标页正文还没挂，已挂页面又都在 memo 后面，这一拍几乎不干活；
     · liveViews：**哪些页面的正文真的挂着**（当前 + 上一次）。它晚一帧、且走 startTransition，
       于是「挂载 + 首屏布局」不再被算进过渡的第一帧 —— 掉帧就出在这一拍上；
     · chromeView：会话列表 / 右侧栏这些**参与布局**的外壳跟哪一页。它等过渡播完才变
       （没有过渡时瞬时变），过渡帧里因此不会出现面板宽度重排。 */
  const [shownView, setShownView] = useState<ViewKey>(view)
  const [chromeView, setChromeView] = useState<ViewKey>(view)

  // 会话列表只在对话页出现；窗口放不下「导航 + 列表 + 对话 + 侧栏」时以抽屉浮层出现，
  // 而不是整块不渲染——原来低于阈值就彻底消失，等于把「所有对话」这个入口藏了。
  // 收放只有两个开关：用户点「收起」（listCollapsed）与窄窗抽屉（listDrawerOpen）。
  const { narrow, showDrawer, close: closeList } = useListPaneLayout()
  /// 内嵌列表的「展开」判据再跟 chromeView 走一道：store 里的 view 在点击那一刻就变了，
  /// 直接拿它算，列表面板会在**过渡帧里**把宽度收成 0 —— 那正是「过渡期间只许 transform/opacity」
  /// 要避免的布局型动画。用户自己的开合状态（listCollapsed）与窄窗抽屉都不经 view，不受影响。
  /// （hook 自己那份 showInline 仍然按 store 的 view 立即算，给「用户点了展开列表」那一路用。）
  const listCollapsed = useUi((s) => s.listCollapsed)
  /// 内嵌会话列表是否展开：只听**用户自己的收起开关**与窗口宽度，不跟 chromeView 走。
  /// 原来挂着 `chromeView === 'chat'` —— 切走去设置再回来时它就变了，用户从没主动收过
  /// 却被收起 / 又弹出来。规矩：切页前什么样，回来还什么样。
  const listInlineOpen = !narrow && !listCollapsed
  /// 展开/收起：宽度走一段限时过渡（CSS 那边时长与这里同一个令牌）。
  /// 开合时挂上折叠冻结窗口，让消息块在过渡的 140ms 里不再逐帧量高 ——
  /// 这正是 base.css 那条「不要给面板加宽度过渡」所担心的开销的唯一解。
  /* ── 展开/收起：宽度瞬切，动画全交给内容层的 transform ──
     原来这里给面板挂一段 280ms 的 flex-grow 过渡，而那是一次**布局**动画：
     每帧主列都重排 → 对话页的消息虚拟列表被逐帧叫醒重测窗口（流式输出时最贵）。
     现在宽度一步到位（见 base.css「面板宽度：瞬切」），进出场由 [data-list-body] 的
     opacity / translate 承担 —— 合成器就能画完，主列零 reflow。

     但有个副作用要补：宽度瞬切的那一瞬面板就是 0 宽，里面那层淡出会被裁掉，
     收起方向会变成「啪」地消失（展开方向不受影响：面板已经有宽度，淡入看得见）。
     所以收起时把面板的宽度**多留一拍**，等淡出走完再瞬切到 0：
       · 留的这一拍里只有 opacity / translate 在动 —— 一次 reflow 都没有；
       · 拍完宽度一步到位 —— 主列只重排这一次。
     那一拍取 --motion-fast（与 [data-list-body][data-open=false] 的退场时长同一个变量，
     直接从 CSS 读，改主题时长不会走偏），读不到就退回 140ms 这个默认档。 */
  const [listWidthOpen, setListWidthOpen] = useState(listInlineOpen)
  useEffect(() => {
    // 开合的这一拍挂冻结窗口：消息块在过渡期间不再逐帧量高（见 base.css 同一段的说明）。
    markCollapseMotion()
    if (listInlineOpen) { setListWidthOpen(true); return }
    let ms = 140
    try {
      const parsed = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-fast'))
      if (Number.isFinite(parsed) && parsed > 0) ms = parsed
    } catch { /* 读不到变量就用上面的默认档 */ }
    const timer = window.setTimeout(() => setListWidthOpen(false), ms)
    return () => window.clearTimeout(timer)
  }, [listInlineOpen])
  /// 抽屉（窄窗口浮层）的进出场：先以 data-state='closed' 挂一帧，再切 'open'——
  /// CSS 过渡必须先有起点可播；关闭时不立刻卸载，等退场动画（--motion-fast）播完再摘掉，
  /// 否则退场根本来不及画，看起来还是「啪」地消失。
  const [drawerMounted, setDrawerMounted] = useState(false)
  const [drawerIn, setDrawerIn] = useState(false)
  useEffect(() => {
    if (!showDrawer) {
      // 已经关着了就别写 state：同值 setState 在 React 19 里仍会排一轮渲染，
      // 而这个 effect 会被同一次提交里的其它 state 变化重新触发（抽屉开关那一拍尤其明显）。
      setDrawerIn((was) => (was ? false : was))
      const timer = window.setTimeout(() => setDrawerMounted(false), 220)
      return () => window.clearTimeout(timer)
    }
    setDrawerMounted((was) => (was ? was : true))
    // 双 rAF：保证「关」的那一帧真的画过一次，过渡才有起点（单帧会偶发不播）。
    let inner = 0
    const outer = window.requestAnimationFrame(() => { inner = window.requestAnimationFrame(() => setDrawerIn((was) => (was ? was : true))) })
    return () => { window.cancelAnimationFrame(outer); if (inner) window.cancelAnimationFrame(inner) }
  }, [showDrawer])
  useComposerZoneHeight(showDrawer, shellRef)
  const closeDrawer = (): void => useUi.getState().setListDrawerOpen(false)

  /* ── 三栏布局：会话列表 / 主列 / 右侧栏交给 react-resizable-panels ──
     宽度约束从常量搬进面板：列表 240–420（LIST_MIN_W/LIST_MAX_W）、
     主列 minSize = MAIN_MIN_W（560，输入工具栏必须放得下）、侧栏 240–560 再叠视口上限。
     面板只在数据层算宽度，抽屉（窄窗口浮层）不在组里，仍旧走上面那套临时态。 */
  const viewport = useViewportWidth()
  const panelOpen = useUi((s) => s.panelOpen)
  const dockPanel = usePanelRef()
  const listPanel = usePanelRef()
  const listWidth = useListWidth('inline')
  const dockWidth = useDockWidth()
  // 外壳跟随 chromeView（过渡结束才变）：面板挂载/卸载是**布局**变化，不能落在过渡帧里。
  const dockShown = chromeView === 'chat' || chromeView === 'artifacts'
  // 内嵌会话列表「挂载」与否，和「是否展开」（listInlineOpen）拆开：
  // 收起时面板不卸载，只是被 min/max=0 夹成 0 宽——和右侧栏收成图标条是同一套写法。
  // 原来一收起就整块卸载 → 主列瞬间补宽、滚动位置与展开态全丢；
  // 现在留着它，展开就是面板自己回到记住的宽度（一次重排，不是逐帧动画）。
  const listInlineMounted = chromeView === 'chat' && !narrow
  // 侧栏上限也跟 listWidthOpen：收起时那「多留的一拍」里列表还占着布局宽度，
  // 上限要跟着它一起留到宽度瞬切那一帧，否则右栏会提前缩 240px、整个布局提前跳一下。
  const dockMax = DOCK_BAR_W + panelMaxWidth(viewport, listWidthOpen)
  /// 侧栏展开时的最小宽度：图标条 + 预览最小宽（PANEL_MIN_W）；收起态才允许缩到只剩图标条。
  const dockMin = DOCK_BAR_W + PANEL_MIN_W
  // 展开/收起侧栏时给 dock 面板一个 flex-grow 过渡；拖拽期间不加，否则拖起来跟手会发飘。
  // dockShown 故意不进依赖：它现在跟 chromeView 走、在**过渡结束之后**才变，
  // 跟着它再播一次宽度过渡就等于「过渡结束后又动了一下布局」，切页该是干净的一下。
  const [dockAnim, setDockAnim] = useState(false)
  useEffect(() => {
    setDockAnim(true)
    const timer = window.setTimeout(() => setDockAnim(false), 280)
    return () => window.clearTimeout(timer)
  }, [panelOpen])
  /// 落盘：只有「用户正在拖 / 按方向键」时面板尺寸变化才写回
  /// （coomi.list.w / coomi.dock.w 两个键不变，语义与改造前「拖到哪存到哪」一致）。
  /// 首屏自动夹取、窗口缩放导致的尺寸变化不写：那些不是用户的选择，
  /// 写进去就等于把用户拖过的宽度悄悄冲掉了。
  const interacting = useRef(false)
  /// 交互结束（松开/抬起方向键）后再读一次面板句柄把宽度落盘：
  /// 谁先谁后都不影响结果（拖拽途中的每帧写入由 onResize 负责，两边写的都是同一个值）。
  const persistTimer = useRef<number | null>(null)
  const persistSoon = (): void => {
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null
      const listPx = listPanel.current?.getSize().inPixels
      if (listPx) listWidth.setWidth(listPx)
      // 收起态的面板只有图标条那 40px：这时候写进去的是 0，会被夹成 PANEL_MIN_W，
      // 等于把用户拖过的宽度悄悄冲掉（下次展开就变成了最小宽度）。
      const dockPx = dockPanel.current?.getSize().inPixels
      if (dockPx && panelOpen) dockWidth.setWidth(dockPx - DOCK_BAR_W)
    }, 120)
  }
  useEffect(() => () => { if (persistTimer.current !== null) window.clearTimeout(persistTimer.current) }, [])
  const beginResize = (): void => {
    interacting.current = true
    // 拖拽中禁用右侧栏的宽度过渡：跟手优先，动画让位。
    // （会话列表已经不做宽度过渡了 —— 见下面那段注释，拖拽/展开都只有一次重排。）
    setDockAnim(false)
    persistSoon()
  }
  const endResize = (): void => { interacting.current = false; persistSoon() }
  const beginPointerResize = (): void => {
    beginResize()
    // 指针常常拖到面板外面才松开：兜一个全局 pointerup，别让「正在调整」的标记漏在那。
    const clear = (): void => { endResize(); window.removeEventListener('pointerup', clear); window.removeEventListener('pointercancel', clear) }
    window.addEventListener('pointerup', clear)
    window.addEventListener('pointercancel', clear)
  }
  /// 面板宽度对齐：组内是按比例分配的，任何一次布局变化（侧栏开合、窗口缩放）都会把
  /// 列表/侧栏的像素宽度带偏——实测侧栏一收，列表会从 240 被撑回上限 420，用户拖过的宽度白拖。
  /// 所以在这些变化之后把两个侧栏按记住的宽度摆回去，弹性空间永远留给主列。
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const list = listPanel.current
      if (list) {
        // 展开 → 记住的宽度；收起 → 0（面板不卸载，只是被 min/max=0 夹成 0 宽；
        // 宽度一步到位，没有逐帧过渡 —— 见 base.css「面板宽度：瞬切」）。
        // 跟 listWidthOpen 走而不是 listInlineOpen：收起时那「多留的一拍」里面板还得是有宽度的。
        const want = listWidthOpen ? listWidth.width : 0
        if (Math.abs(list.getSize().inPixels - want) > 1) list.resize(want)
      }
      const dock = dockPanel.current
      if (dockShown && dock) {
        const want = panelOpen ? DOCK_BAR_W + dockWidth.width : DOCK_BAR_W
        if (Math.abs(dock.getSize().inPixels - want) > 1) dock.resize(want)
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [panelOpen, listWidthOpen, listInlineMounted, dockShown, viewport])

  /* 环境检测（node / uv / git …）以前只在进技能中心时才跑 —— 用户要到主动打开那一页
     才知道本机缺什么。这里在首屏空闲时预热一次：不占启动关键路径，但切到技能中心 / 设置时
     数据已经在了。接口本身不便宜（逐个 fork 子进程探测运行时），所以放 requestIdleCallback，
     不用挂载即发。store 里有 TTL，重复调用会直接命中缓存。 */
  useEffect(() => {
    const run = (): void => { void useLibrary.getState().ensureRuntimes() }
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
    if (typeof idle === 'function') {
      const handle = idle(run)
      return () => (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle)
    }
    const timer = window.setTimeout(run, 1500)
    return () => window.clearTimeout(timer)
  }, [])

  /* 客户端插件（全信任、跑在宿主渲染进程）：启动时装一轮，之后 3s 轮询做热加载。
     引擎还没起来 / 老引擎没有这个端点时静默跳过，下一轮再试。 */
  /* 客户端插件：**等引擎就绪后再装**，之后 3s 轮询做热加载。
     以前在挂载时立刻启动 —— 引擎还没起来就反复打 API，和启动引导抢引擎连接，
     症状：卡在「正在准备一个新对话…」，要手动点「新建对话」才连上。
     现在由 engine.ready 驱动：没就绪什么都不做，就绪后装一次（幂等）。 */
  const pluginsEngineReady = useEngine((state) => state.ready)
  useEffect(() => {
    if (!pluginsEngineReady) return
    void startPluginClients()
  }, [pluginsEngineReady])

  /// 首屏空闲预热：切页那一刻三个页面 chunk 都已经在模块缓存里。
  useEffect(() => { warmViewChunks() }, [])

  /* ── 导航预取：pointerover → pointerdown → focusin，三条路都只做一件事：把目标页 chunk 取回来 ──
     为什么 pointerover（本次新增）排在最前：原来只有 pointerdown 一条路，而「按下」到「切换」
     只隔几毫秒 —— 那点时间只够发请求，不够下 chunk，于是**首次进入某个页面大概率没备好**，
     切页只能干等。指针移到图标上通常有几百毫秒（人从「移到」到「按下去」），
     这段时间足够把 40KB 级的小 chunk 拿完，切页那一刻它已经在模块缓存里。
     键盘用户走 focusin（Tab 到导航项）与原来一样，两条路都保留。
     为什么用捕获阶段挂在 document 上：Rail 上的按钮点下去到 store 变化之间没有别的地方能插进来；
     不用 pointerenter 是因为它不冒泡，事件委托接不到（pointerover 是它的可委托等价物）。
     重复触发不花钱：prefetchView 内部有 in-flight 去重，import() 本身也命中模块缓存。 */
  useEffect(() => {
    const onNavIntent = (e: Event): void => {
      const el = e.target instanceof Element ? e.target.closest('[data-nav-key]') : null
      const key = el instanceof HTMLElement ? el.dataset.navKey as ViewKey | undefined : undefined
      if (key) prefetchView(key)
    }
    document.addEventListener('pointerover', onNavIntent, true)
    document.addEventListener('pointerdown', onNavIntent, true)
    document.addEventListener('focusin', onNavIntent, true)
    return () => {
      document.removeEventListener('pointerover', onNavIntent, true)
      document.removeEventListener('pointerdown', onNavIntent, true)
      document.removeEventListener('focusin', onNavIntent, true)
    }
  }, [])

  const onListResize = (size: PanelSize): void => { if (interacting.current) listWidth.setWidth(size.inPixels) }
  const onDockResize = (size: PanelSize): void => { if (interacting.current && panelOpen) dockWidth.setWidth(size.inPixels - DOCK_BAR_W) }

  // 窗口变宽后抽屉这个形态就不存在了：把临时态清掉，
  // 否则用户下次把窗口拖窄时抽屉会自己弹出来。listCollapsed（用户态）不动。
  useEffect(() => {
    if (!narrow && useUi.getState().listDrawerOpen) useUi.getState().setListDrawerOpen(false)
  }, [narrow])

  /// 挂载集合：**最近 4 个**（当前 + 最近 3 个）。更早的页面整块卸载（省内存、停掉它们自己的定时器），
  /// 滚动位置由 ViewSlot 的滚动记忆恢复、数据都在 store 里（回来时重新订阅即可）。
  /// 原来只留「当前 + 上一次」：来回切两页以上时每次都是冷挂载（重挂组件树 + 各页自己的
  /// 首屏取数），在低配机上就是「切页卡一下」。现在保活 4 个，配合各页的 ensure* TTL，
  /// 常见路径（对话 ↔ 技能 ↔ 产物 ↔ 设置）都是热的；同时上限固定，不会无限堆积。
  const [liveViews, setLiveViews] = useState<ViewKey[]>(() => [view])
  /* 插件页面（v2.1）：注册表来自引擎 /api/plugins/views（壳在启用插件时写入）。
     它只影响「有哪些 key」与「key 渲染成什么」，核心四页那条路径一个字都没改。 */
  const pluginViews = usePluginViews((s) => s.views)
  const loadPluginViews = usePluginViews((s) => s.load)
  useEffect(() => { if (engineReady) void loadPluginViews() }, [engineReady, loadPluginViews])
  /* 客户端插件注册的页面也要进 viewOrder，否则它的 pane 根本不会被渲染。 */
  const clientViews = usePluginClientViews()
  const viewOrder = useMemo<ViewKey[]>(
    () => [...VIEW_ORDER, ...pluginViews.map((item) => item.key), ...clientViews.map((view) => view.key)],
    [pluginViews, clientViews],
  )
  // 正停在某个插件页上，而那个插件被停用 / 卸载了：退回对话页，别留一块空白主区。
  useEffect(() => {
    if (VIEW_ORDER.includes(view)) return
    if (pluginViews.some((item) => item.key === view)) return
    // 客户端插件页同样算「存在的页面」，否则一点进去就被这条守卫弹回对话页。
    if (findPluginClientView(String(view))) return
    if (!usePluginViews.getState().loaded) return
    useUi.getState().setView('chat')
  }, [view, pluginViews])
  /// 上一次真正渲染过的那一页：下一次切换时它是唯一被留下的旧页面。
  const previousView = useRef<ViewKey>(view)
  /// 这一拍换页的角色分配（谁进、谁退、往哪边）。**过渡结束后不收回**：
  /// 收回就等于把新页的 pane-enter-* 撤掉，内容错峰（CSS 认 [data-pane-anim='enter']）
  /// 会跟着一起没了；下一次换页把它整个换掉即可（class 换名 → 动画重播）。
  const [nav, setNav] = useState<NavState | null>(null)
  /// 换页序号：连点导航时旧的那一拍作废（定时器 / rAF 回来先对号）。
  const navSeq = useRef(0)
  /// 换页时间轴上的三个句柄：旧页卸载、动画结束、挂正文那一帧。
  const navTimers = useRef<{ exit: number; settle: number; frame: number }>({ exit: 0, settle: 0, frame: 0 })
  const clearNavTimers = (): void => {
    if (navTimers.current.exit) window.clearTimeout(navTimers.current.exit)
    if (navTimers.current.settle) window.clearTimeout(navTimers.current.settle)
    if (navTimers.current.frame) window.cancelAnimationFrame(navTimers.current.frame)
    navTimers.current = { exit: 0, settle: 0, frame: 0 }
  }
  /* ── 切页：一条动画路径 + 两条挂载档位 ──
     动画只有一条路（保持不变）：pane 自己按方向 class 播 CSS 动画
     （pane-enter-right/left + pane-exit-right/left，规则在 base.css）。
     为什么是动画不是过渡：过渡要有「起点已经被画过一帧」才播得出来，而换页那一拍内容列
     可能正是空帧/骨架——过渡抓到空帧就什么都不播，这就是上一版「切页没动画」的根因。
     @keyframes 不读前一帧的值，class 挂上就播，所以这里一律用动画。

     挂正文则分档（本次性能修复）：原来只有「动画播完再挂」一档，等于**每次切页都先空等
     满 240ms**——那 240ms 里什么都没加载，纯等定时器。
       毫秒（常量与 CSS 的 --pane-in/--pane-out 是同一个数，都在 navPause.tsx）：
         0             指针翻到新页 ＋ 开「让路」闸门；新旧两页各拿一个方向 class；
                       **快档（chunk 已就绪）正文就在这一拍走 startTransition 挂上**，
                       进场动画与挂载并行 —— 用户看到的是内容直接滑进来，不再先盯 240ms 骨架；
                       慢档（chunk 还在路上）这一拍仍是骨架，由 Suspense 顶着。
         PANE_EXIT_MS  旧页（淡出）卸载 —— 它的定时器/观测器随卸载一起停
         PANE_ENTER_MS 进场动画播完（慢档在这一拍之后再等一拍 rAF 挂正文）；
                       参与布局的外壳（会话列表 / 右侧栏）也在这一刻才跟着切，
                       闸门自动收、排队重算合并成一次 flush
     档位判据只有「chunk 到位没有」（chunkReady，见上面的 VIEW_CHUNK），
     与「用户是不是第一次进」无关：保活 4 页 + 预热已经让绝大多数切换命中快档。 */
  useEffect(() => {
    if (shownView === view) return
    const from = shownView
    const dir = navDirection(from, view)
    const seq = (navSeq.current += 1)
    previousView.current = from
    clearNavTimers()

    // 动效关 / 系统减动效：不播、不挂方向 class、也不开闸门（瞬时换页，不闪不滑）。
    if (!motionAllowed()) {
      setNav(null)
      setShownView(view)
      // 动效关掉时是瞬时切页：同样保留最近几个视图（理由见挂载那一支的注释）。
      setLiveViews((list) => (list.includes(view) ? list : [...list, view]).slice(-LIVE_VIEWS_KEEP))
      setChromeView(view)
      return
    }

    const root = document.documentElement
    root.dataset.navDir = dir
    // 换页那一拍让路：统计轮询、观测器、量尺寸都读 html[data-nav-busy] 跳过这一拍；
    // 这期间排队的重算会在收闸时合并成一次 flush（见 components/shell/navPause.tsx）。
    markNavPause(NAV_PAUSE_MS)

    /// 正文挂载（本身不需要任何等待）：真正做活的只有 setLiveViews，
    /// startTransition 让它按「可以晚一点」的优先级排 —— 时间轴长短由调用方决定。
    const mountContent = (): void => {
      if (navSeq.current !== seq) return
      startTransition(() => {
        setLiveViews((list) => {
          const next = list.includes(view) ? list : [...list, view]
          // 最近 4 个保活（当前 + 最近 3 个）：切回去是**热挂载** —— 不重挂组件树、
          // 也不重新打网络（数据新鲜度由各页的 ensure* TTL 兜底，见 stores/library）。
          // 更早的从挂载集合里筛掉：React 立刻卸载它们（定时器/观察器/轮询随卸载一起停）。
          const keep = new Set<ViewKey>(next.slice(-LIVE_VIEWS_KEEP))
          keep.add(view)
          keep.add(previousView.current)
          return next.filter((key) => keep.has(key))
        })
      })
    }

    /// 外壳收尾（两条分支共用）：参与布局的外壳（会话列表 / 右侧栏）等动画播完再切 ——
    /// 面板挂载/卸载会改宽度，落在动画帧里就是一次布局抖动。两条路径都在动画收尾处走它，
    /// 所以**外壳跟随动画结束**这件事与正文早挂晚挂彻底解耦了。
    const settleChrome = (): void => {
      if (navSeq.current !== seq) return
      setChromeView(view)
      delete root.dataset.navDir
    }

    /// 外壳收尾也补一拍 rAF：面板改宽度要落在「动画最后一帧已经画过」之后，
    /// 否则宽度变化正好压在动画的收尾帧上，看着就是内容抖一下。
    /// 这条与「正文早挂还是晚挂」无关 —— 两条档位的外壳切换时刻完全一致，视觉不因分档而变。
    const settleChromeAfterAnim = (): void => {
      if (navSeq.current !== seq) return
      navTimers.current.frame = window.requestAnimationFrame(() => {
        if (navSeq.current !== seq) return
        settleChrome()
      })
    }

    /* 慢路径专用：正文等动画播完再挂。多等这一拍 rAF 是为了保证「动画最后一帧已经画过」，
       免得正文在半路顶上来把动画截断（@keyframes 不读前一帧，半路换内容看着就是跳一下）。
       只有 chunk 还没到、必须先让骨架顶着的那一支才走这里。 */
    const mountContentAfterAnim = (): void => {
      if (navSeq.current !== seq) return
      navTimers.current.frame = window.requestAnimationFrame(() => {
        if (navSeq.current !== seq) return
        mountContent()
        settleChrome()
      })
    }

    // ① 实验分支（默认关，见 vtExperimentOn）：壳支持 + 显式打开才走快照那条路。
    //    这条路上 pane 不挂方向 class，动画由 CSS（html[data-vt-exp='on']）关掉，
    //    位移与淡出交给快照自己按 html[data-nav-dir] 播。
    if (vtExperimentOn()) {
      const start = viewTransitionStarter()
      if (start) {
        // flushSync 是必须的：快照要在回调返回前落定，否则浏览器抓到的还是旧 DOM。
        const vt = start((): void => { flushSync((): void => setShownView(view)) })
        // 正文挂在「这次换页的 DOM 已落定」之后，不把挂载算进过渡的第一帧。
        void vt.updateCallbackDone.then(mountContent).catch(mountContent)
        void vt.finished.catch(() => {}).finally(() => {
          if (navSeq.current !== seq) return
          delete root.dataset.navDir
          setChromeView(view)
        })
        return
      }
    }

    // ② 默认路径：两个 pane 各拿一个方向 class，动画由 base.css 播。
    setNav({ seq, from, to: view, dir })
    setShownView(view)
    /// 旧页淡出（PANE_EXIT_MS）后退场：只摘它一个。
    navTimers.current.exit = window.setTimeout(() => {
      if (navSeq.current !== seq) return
      setLiveViews((list) => list.filter((key) => key !== from))
    }, PANE_EXIT_MS)

    /* ③ 分档：**内容就绪就不再等动画**（这次性能修复的核心）。
       原来的时间轴只有一条路：不管内容在不在内存里，一律空等完进场动画（240ms）才挂正文。
       那 240ms 里系统一个字节都没加载，纯等定时器 —— 而三个顶级页面都是 lazy，
       预热又只在 idle / pointerdown 两条路上（按下到切换只有几毫秒，首次进入大概率没备好），
       于是用户看到的就是「切页像卡死 1~2 秒」。
       现在按「chunk 到位没有」分两档：
         · 已就绪（预热过 / 之前进过一次，chat 永远算就绪）：**这一拍就挂正文**，
           进场动画与挂载并行 —— 动画照播、方向照旧，只是骨架不再霸屏 240ms；
         · 未就绪：先让骨架顶着 Suspense 的加载，动画播完再挂（与原来一致）。
       档位只由 chunkReady 决定，不由「用户是不是第一次进」决定 —— 保活 4 页的机制
       已经让绝大多数切换命中快档，这条慢档只在冷启动首次进入某个页面时出现。
       外壳（setChromeView）仍然等动画收尾：面板宽度变化不该落在动画帧里。 */
    if (viewContentReady(view)) {
      mountContent()
      navTimers.current.settle = window.setTimeout(settleChromeAfterAnim, PANE_ENTER_MS)
    } else {
      /// 进场动画播完 → 挂正文。
      navTimers.current.settle = window.setTimeout(mountContentAfterAnim, PANE_ENTER_MS)
    }
  }, [view, shownView])

  /// 卸载时把「让路」闸门与换页时间轴一起收干净（收闸顺带把排队的东西放出来）。
  useEffect(() => () => { clearNavTimers(); endNavPause() }, [])

  /// 全局快捷键：Ctrl/Cmd+K 命令面板、Ctrl/Cmd+N 新对话、Esc 关闭面板/抽屉。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((v) => !v); return }
      if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); void useSession.getState().newSession(); return }
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); useUi.getState().togglePanel(); return }
      if (e.key === 'Escape') {
        setPaletteOpen(false)
        // 抽屉开着时 Esc 收掉抽屉；Rail 上的「展开会话列表」随时能再打开。
        const ui = useUi.getState()
        if (ui.listDrawerOpen) ui.setListDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /// 托盘菜单「新建对话」：壳里点了托盘菜单会发这个事件过来。
  /// 监听不可用（浏览器里跑）时静默跳过，不影响其它功能。
  useEffect(() => {
    type Listen = (name: string, cb: () => void) => Promise<() => void>
    const listen = (window as unknown as { __TAURI__?: { event?: { listen?: Listen } } }).__TAURI__?.event?.listen
    if (!listen) return
    let off: (() => void) | undefined
    let disposed = false
    void listen('tray:new-chat', () => { void useSession.getState().newSession() })
      .then((unlisten) => { if (disposed) unlisten(); else off = unlisten })
      .catch(() => {})
    return () => { disposed = true; off?.() }
  }, [])

  /// 接上渲染风暴探针的出口：某一页 1 秒内提交超过 20 次 → 切安全模式 + 提示一次。
  /// 回调只在真的成灾时才被调用（见 lib/stormProbe.ts），所以这里不带来任何常驻开销。
  useEffect(() => {
    setStormListener(onStorm)
    return () => setStormListener(null)
  }, [])

  /// 启动时连引擎：壳已经把进程拉起来了，这里只负责探活 + 拿端口令牌。
  useEffect(() => {
    void useEngine.getState().init()
    // 只在挂载时跑一次：engine.init 内部自带 60s 轮询重试。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /// 启动时拉一次插件清单并应用「已选且已启用」的插件主题（根部只刷这一回；
  /// 进设置「插件」分组时 PluginsView 会再刷一次）。壳命令缺失 / 壳没起来时
  /// store 内部降级为可读提示，不会影响启动。
  useEffect(() => {
    void usePluginStore.getState().refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /// 壳重启引擎后会发 engine:restarted（带新的 port / token）：
  /// 前端据此换掉端口令牌并重新 init；会话侧会在 ready 时重新连上并回读当前会话。
  useEffect(() => {
    type Payload = { port?: number; token?: string } | undefined
    type Listen = (name: string, cb: (e: { payload?: Payload }) => void) => Promise<() => void>
    const listen = (window as unknown as { __TAURI__?: { event?: { listen?: Listen } } }).__TAURI__?.event?.listen
    if (!listen) return
    let off: (() => void) | undefined
    let disposed = false
    void listen('engine:restarted', (e) => {
      const payload = e?.payload ?? {}
      // 壳没带端口时传 0：applyRestart 会走 init 自己回读 engine_info。
      void useEngine.getState().applyRestart(Number(payload.port ?? 0), typeof payload.token === 'string' ? payload.token : '')
    })
      .then((unlisten) => { if (disposed) unlisten(); else off = unlisten })
      .catch(() => {})
    return () => { disposed = true; off?.() }
  }, [])

  /// 启动静默检查更新：壳启动后自动查一次，发现新版本会发 update:available。
  /// 这里只弹一条不打扰的 toast（同一会话只提示一次），点「查看更新」进设置页；
  /// 不自动下载、不自动装 —— 更新始终由用户在设置页确认后发起。
  useEffect(() => {
    type Payload = { latest?: string; current?: string; hasUpdate?: boolean } | undefined
    type Listen = (name: string, cb: (e: { payload?: Payload }) => void) => Promise<() => void>
    const listen = (window as unknown as { __TAURI__?: { event?: { listen?: Listen } } }).__TAURI__?.event?.listen
    if (!listen) return
    let off: (() => void) | undefined
    let disposed = false
    let shown = false
    void listen('update:available', (e) => {
      if (shown) return
      const payload = e?.payload
      if (!payload || !payload.hasUpdate) return
      shown = true
      toast('发现新版本：' + (payload.latest ?? '未知'), {
        description: '当前版本 ' + (payload.current ?? '未知') + '，可在设置页「检查更新」处下载安装。',
        duration: 12_000,
        action: { label: '查看更新', onClick: () => { useUi.getState().setView('settings') } },
      })
    })
      .then((unlisten) => { if (disposed) unlisten(); else off = unlisten })
      .catch(() => {})
    return () => { disposed = true; off?.() }
  }, [])

  /// 探活看门狗：引擎「就绪」后每 15s 打一次 /api/runtime/health。
  /// 连续两次探活失败＝进程已经死了（WS 也不会自己回来），自动让壳重启引擎，
  /// 而不是把「请手动重连」丢给用户。
  useEffect(() => {
    if (!engineReady) return
    let fails = 0
    const timer = window.setInterval(() => {
      // 切页过渡那一拍不探活：让路给过渡（与 MessageNav 的 navBusy() 同一个判据）。
      if (navPauseBusy()) return
      void useEngine.getState().api('/api/runtime/health')
        .then(() => { fails = 0 })
        .catch(() => {
          fails += 1
          if (fails < 2) return
          fails = 0
          // 探活失败不再自动重启：忙≠死，交给壳守护；前端等重连。
        })
    }, 15000)
    return () => window.clearInterval(timer)
  }, [engineReady])

  /// 引擎就绪后拉一次会话列表；用户没主动选过会话时恢复上次那个，再不行才回落最近一条。
  useEffect(() => {
    if (!engineReady) return
    let disposed = false
    let retry: number | undefined
    const bootstrap = async (): Promise<void> => {
      try {
      await loadSessions()
      if (disposed || !useEngine.getState().ready) return
      if (useEngine.getState().lastError.startsWith('初始化会话失败，正在重试：')) {
        useEngine.setState({ lastError: '' })
      }
      const state = useSession.getState()
      const action = pickStartupSession({
        sessionId: state.sessionId,
        sessions: state.sessions,
        remembered: readLastSession(),
        // 上次停在「新建但还没落库」的会话上：它还不在列表里，但草稿是按它的 id 存的——
        // 按原 id 恢复（引擎接受客户端指定的会话 id），否则用户重启后就找不回没发出去的内容。
        hasDraft: (id) => !!readDraft(id),
      })
      if (action.kind === 'keep') return
      if (action.kind === 'open') { await openSession(action.id); return }
      if (action.kind === 'resume') { await useSession.getState().newSession(action.id); return }
      // **全新机器**（没有任何可见会话）：建一个空会话。少了这一步，sessionId 永远是空串，
      // connect() 直接返回，界面就会一直显示「与引擎的连接已断开」——而引擎其实好得很。
      await useSession.getState().newSession()
      } catch (error) {
        if (disposed) return
        useEngine.setState({ lastError: '初始化会话失败，正在重试：' + (error instanceof Error ? error.message : String(error)) })
        retry = window.setTimeout(() => { void bootstrap() }, 1500)
      }
    }
    void bootstrap()
    return () => { disposed = true; if (retry !== undefined) window.clearTimeout(retry) }
  }, [engineReady, loadSessions, openSession])

  return (
    <LazyMotion features={domAnimation} strict>
    <TooltipProvider>
        <div className='flex h-full flex-col bg-canvas'>
          <TitleBar title={streamTitle} />
          {/* 弹性布局：固定栏（导航/图标条）shrink-0，主内容列 flex-1 min-w-0，
              右侧栏是主列的兄弟节点而不是浮层，宽度不够时把会话列表降级成抽屉，绝不覆盖输入框。 */}
          <div ref={shellRef} data-shell-frozen data-app-shell className='relative flex min-h-0 min-w-0 flex-1 overflow-hidden'>
            {/* 三栏（会话列表 / 主列 / 右侧栏）由面板组布局：宽度约束是面板的 min/max，
                主列最小 560 由 Panel 亲自守住，拖动/键盘/双击复位都归面板库。
                抽屉仍是应用层浮层，留在 Group 外面（它不该参与布局宽度）。 */}
            <Group
              orientation='horizontal'
              className={cn(
                'flex min-h-0 min-w-0 flex-1',
                // 只有展开/收起侧栏那一小段时间给面板宽度加过渡；拖拽期间不加，否则跟手会发飘。
                dockAnim && '[&>[data-panel]:last-child]:transition-[flex-grow] [&>[data-panel]:last-child]:duration-[var(--motion-base)] [&>[data-panel]:last-child]:ease-[var(--ease-enter)]',
              )}
            >
              {/* 一级导航：固定 60px（min=max），不参与拖拽 */}
              {/* 一级导航：**不在面板组里**，就是一个固定 60px 的 flex 项。
                  放进组里时它的像素宽是按「组内占比」换算出来的：切页会让会话列表 / 右侧栏
                  挂载或卸载，占比跟着重新归一化，导航条实测宽度会先抖一下再回来
                  （CDP 实测 60 → 46 → 62 → 61 → 60）。外壳条款本来就不该参与这套换算，
                  移出组之后它的 rect 恒为 x=0、w=60，切页期间零位移。 */}
              <div
                data-shell-frozen
                className='flex min-h-0 shrink-0 flex-col overflow-hidden'
                style={{ ...PANEL_CLIP, width: RAIL_W, minWidth: RAIL_W }}
              >
                <Rail />
              </div>
              {/* 会话列表：宽度可拖（240–420，存 coomi.list.w）；收起时面板留在原地被夹成 0 宽，主列自然补上 */}
              {listInlineMounted ? (
                <>
                  <Panel
                    id='coomi-list-panel'
                    panelRef={listPanel}
                    // 收起态：min = max = 0，面板留在 DOM 里被约束成 0 宽——和右侧栏收成图标条
                    // 是同一套写法。宽度由 flex-grow 驱动（react-resizable-panels 写在面板外层 div 上）。
                    // ⚠ 这里**没有**宽度过渡，而且是刻意的：过渡 = 每一帧主列重排一次 =
                    // 消息虚拟列表被逐帧叫醒重测窗口（见 base.css「面板宽度：瞬切」）。
                    // 展开/收起的动画由下面 [data-list-body] 的 opacity / translate 承担。
                    // 约束跟的是 listWidthOpen（收起时多留一拍给淡出），不是 listInlineOpen。
                    minSize={listWidthOpen ? LIST_MIN_W : 0}
                    maxSize={listWidthOpen ? LIST_MAX_W : 0}
                    defaultSize={listWidthOpen ? listWidth.width : 0}
                    groupResizeBehavior='preserve-pixel-size'
                    onResize={onListResize}
                    // 'on' 标记「这一下是展开/收起，不是拖拽」；base.css 用它保证面板上永远没有过渡。
                    data-pane-anim='on'
                    className={PANEL_BOX}
                    style={PANEL_CLIP}
                  >
                    {/* 展开/收起的动画全在这一层：宽度瞬切之后，列表内容靠 opacity / translate
                        自己淡入淡出（transform + opacity = 合成器的事，主列一帧都不重排）。
                        规则在 base.css 的 [data-list-body]。 */}
                    <div
                      data-list-body
                      data-open={listInlineOpen ? 'true' : 'false'}
                      className='flex h-full min-h-0 w-full min-w-0 flex-col'
                    >
                      <ListPane variant='inline' onClose={closeList} />
                    </div>
                  </Panel>
                  {listInlineOpen ? (
                    <PanelSeparator
                      separatorId='coomi-list-sep'
                      label='调整会话列表宽度'
                      onInteractStart={beginPointerResize}
                      onInteractEnd={endResize}
                      onReset={() => { listWidth.setWidth(LIST_W); listPanel.current?.resize(LIST_W) }}
                    />
                  ) : null}
                </>
              ) : null}
              {/* 主内容列：四个页面各自绝对定位叠在一起，只切透明度与位移。
                  原来 key={view} 会整页重挂载——滚动位置、已加载的数据、展开状态全丢。 */}
              <Panel id='coomi-main' minSize={MAIN_MIN_W} className={PANEL_BOX} style={PANEL_CLIP}>
                {/* data-content-layer：内容层的显式标记（外壳是 [data-shell-part]）。
                    换页时**只有这一层在动**：下面的 pane 挂方向 class 播动画，
                    外壳（标题栏 / 导航 / 列表 / 右栏）一帧都不位移。 */}
                <div data-main-col data-content-layer data-view={shownView} className='relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
              {/* 只挂「当前 + 上一次」：更早的页面整块卸载 —— 它们的状态本来就在 store 里，
                  滚动位置由 ViewSlot 恢复，隐藏页的 CSS 动效由 data-view-state 暂停
                  （base.css 那一段），页面自己的定时器/轮询读 usePaneActive() 停
                  （ViewSlot 把「前台」注进去），卸载掉的那些则连代码都不在跑。
                  active（在最上层）与 live（正文已挂）是两件事：动画那 240ms 里目标页
                  是「active 但还没 live」——屏幕上是它的骨架（固定高度），
                  正文等动画播完 + 一拍 rAF 才挂（见上面切页 effect 的时间轴）。
                  挂载顺序仍然按 VIEW_ORDER：DOM 顺序恒定，动画与滚动位置才稳定。 */}
              {viewOrder.filter((key: ViewKey) => key === shownView || liveViews.includes(key)).map((key: ViewKey) => {
                const Page = pageFor(key)
                // 角色由这一拍换页的分配决定：to＝进、from＝退、其余（比如初始挂载）不挂动画。
                const anim: PaneAnim | null = nav ? (key === nav.to ? 'enter' : key === nav.from ? 'exit' : null) : null
                return (
                  <ViewSlot
                    key={key}
                    name={key}
                    active={key === shownView}
                    live={liveViews.includes(key)}
                    anim={anim}
                    dir={nav?.dir ?? 'forward'}
                  >
                    <Page />
                  </ViewSlot>
                )
              })}
                </div>
              </Panel>
              {/* 右栏跟随**渲染中**的页面，而不是 store：否则点击那一刻它就卸载了，
                  过渡的旧快照里会凭空少一块。
                  宽度 = 图标条 40 + 预览宽（存 coomi.dock.w）；收起时面板缩到只剩图标条，
                  所以它永远不会盖在主列上（和改造前「宽度归零」是同一个语义）。 */}
              {dockShown ? (
                <>
                  <PanelSeparator
                    separatorId='coomi-dock-sep'
                    label='调整侧栏宽度'
                    disabled={!panelOpen}
                    onInteractStart={beginPointerResize}
                    onInteractEnd={endResize}
                    onReset={() => { dockWidth.setWidth(PANEL_DEFAULT_W); dockPanel.current?.resize(DOCK_BAR_W + PANEL_DEFAULT_W) }}
                  />
                  <Panel
                    id='coomi-dock-panel'
                    panelRef={dockPanel}
                    // 收起态：min=max=图标条宽度，面板被约束死了就一定是 40px。
                    // 只给 min 是不够的——面板宽度是组内按比例算的，窗口变宽时它会跟着长
                    // （实测 900 → 1400 时从 40 变成 61，图标条右边会多出一截空白）。
                    minSize={panelOpen ? dockMin : DOCK_BAR_W}
                    maxSize={panelOpen ? dockMax : DOCK_BAR_W}
                    defaultSize={panelOpen ? DOCK_BAR_W + dockWidth.width : DOCK_BAR_W}
                    groupResizeBehavior='preserve-pixel-size'
                    onResize={onDockResize}
                    className={PANEL_BOX}
                    style={PANEL_CLIP}
                  >
                    <RightDock panelRef={dockPanel} />
                  </Panel>
                </>
              ) : null}
            </Group>

            {/* 抽屉态：会话列表以浮层出现（left 60px = 导航栏右侧），带半透明遮罩。
                容器底边让开 Composer 输入区，点遮罩 / Esc 关闭。 */}
            {drawerMounted ? (
              <div
                data-list-drawer
                data-state={drawerIn ? 'open' : 'closed'}
                className='absolute bottom-0 left-[60px] right-0 top-0 z-30'
              >
                <button
                  type='button'
                  data-drawer-scrim
                  aria-label='关闭会话列表'
                  // 退场期间只是淡出，不该再吃点击：否则会点到半透明的遮罩上。
                  tabIndex={drawerIn ? 0 : -1}
                  onClick={closeDrawer}
                  className='absolute inset-0 cursor-default bg-black/25'
                />
                <div data-drawer-panel className='relative h-full w-fit shadow-elev-3'>
                  <ListPane variant='drawer' onClose={closeList} />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      <Suspense fallback={null}>
        <ApprovalDialog />
        <QuestionDialog />
        {paletteOpen ? <CommandPalette open onOpenChange={setPaletteOpen} /> : null}
      </Suspense>
      {/* 首次启动的三步引导：挂在浮层这一层（与对话框同源），它自己是懒加载的。 */}
      <OnboardingGate />
      <DialogHost />
      <ContextMenuHost />
      <AppToaster />
    </TooltipProvider>
    </LazyMotion>
  )
}
