import { create } from 'zustand'
import { ipc } from '../lib/ipc'
// 安全模式 / 精简模式：判定只有 lib/guard.ts 一份，这里只负责把它落到设置与 DOM 上。
import { isLean, setSafeMode, setSafeOverride, subscribeLean } from '../lib/guard'

export type ThemeMode = 'light' | 'dark' | 'system'
/** 四个核心页 + 插件注册的页面（插件页 key 形如 `plugin:<pluginId>:<viewId>`）。
    `(string & {})` 这个写法保留四个核心值的自动补全，同时允许插件页那种动态 key。 */
export type ViewKey = 'chat' | 'skills' | 'artifacts' | 'settings' | (string & {})
export type Density = 'compact' | 'cozy'
export type FontChoice = 'harmony' | 'system'
/** 引擎崩溃后的恢复方式：一键继续＝恢复完先提示、用户点一下再重发；自动继续＝恢复完直接接着跑。 */
export type CrashRecoveryMode = 'manual' | 'auto'
/** 消息栏宽度：固定档位 / 自适应（跟随窗口放宽，到上限为止）。 */
export type MessageWidthMode = 'fixed' | 'fluid'
/** 性能模式：high＝默认观感（毛玻璃 + 点阵动效 + 普通虚拟化阈值）；
    low＝低配机器/远端的省电档（关毛玻璃、停点阵循环、更早虚拟化）。 */
export type PerfMode = 'high' | 'low'
/** 生成中继续发送（插话）时的处理方式：
    queue＝排队（默认）——本轮跑完立刻按顺序执行，已生成内容一个字不丢；
    interrupt＝打断——取消当前轮并立刻发起新一轮，已生成内容保留为一条助手消息。 */
export type InsertMode = 'queue' | 'interrupt'

export interface Prefs {
  fontFamily: FontChoice
  defaultView: ViewKey
  density: Density
  messageWidth: number
  messageWidthMode: MessageWidthMode
  motion: boolean
  confirmDanger: boolean
  /** 引擎崩溃后的恢复方式，默认「一键继续」。 */
  crashRecovery: CrashRecoveryMode
  /** 性能模式：关毛玻璃与点阵动效、提前虚拟化长列表。默认 high（观感优先）。 */
  perf: PerfMode
  /** 运行中插话的处理方式，默认「排队」（不打断当前轮、不丢已生成内容）。 */
  insertMode: InsertMode
  /** 安全模式（自救开关，默认关）：界面卡住时打开，动效、富预览、语法高亮、长列表虚拟化
      与刻度轨重算全部让路，只画纯文本。它同时是 guard 的「精简模式」的人肉入口 ——
      除了这里，URL 上的 ?safe=1 与 localStorage 也能强制打开（见 lib/guard.forcedSafeMode）。 */
  safeMode: boolean
}

const THEME_KEY = 'coomi.theme'
const SCALE_KEY = 'coomi.fontScale'
const PREFS_KEY = 'coomi.prefs.v2'
/** 会话列表是否被用户收起（用户态，持久化）。 */
const LIST_COLLAPSED_KEY = 'coomi.list.collapsed'
/** 老版本的三态键：只读一次做迁移，不再写。 */
const LEGACY_LIST_MODE_KEY = 'coomi.list.mode'

const DEFAULT_PREFS: Prefs = {
  fontFamily: 'harmony',
  defaultView: 'chat',
  density: 'compact',
  messageWidth: 768,
  // 默认自适应：固定 768 在 2560 全屏下两侧各空 800+ px，白扔掉半个窗口。
  messageWidthMode: 'fluid',
  motion: true,
  confirmDanger: true,
  // 默认「一键继续」：崩溃恢复后先让用户看清发生了什么，再决定要不要接着跑。
  crashRecovery: 'manual',
  // 默认保持观感（毛玻璃 + 点阵）；低配机器在设置页开性能模式即可退到省电档。
  perf: 'high',
  // 默认「排队」：插话不打断当前轮、不丢已生成内容，本轮结束后按顺序执行。
  insertMode: 'queue',
  // 默认关：安全模式是出事时的手动降级，不是常态观感。
  safeMode: false,
}

/* ── 性能模式 ──
   一个开关带三件事：关毛玻璃、停点阵循环动效、提前虚拟化长列表。
   落点统一走 html[data-perf=low]（theme.css / base.css 里那两段规则），
   组件不用各自判断，也不要各自存一份。 */
/** 性能模式开关 → html 上的档位属性。 */
export const PERF_ATTR = 'perf'
/** 普通档的长列表虚拟化阈值：低于它保留完整 DOM（划选、Ctrl+F 高亮都不打折）。
    ⚠ 2026-10 起这两个阈值与下面的 virtualizeThreshold() 已经**没有任何调用方**：
    对话主列表不再走虚拟化（移除理由见 components/chat/MessageList.tsx 顶部），
    这里只剩一份历史策略的残根。先留着不删（它们仍是对话列表「为什么不虚拟化」的文档），
    但**不要再把它们当成生效中的开关**去调 —— 调了不会有任何效果。 */
export const VIRTUALIZE_AT = 300
/** 省电档阈值：更早交给虚拟化。 */
export const VIRTUALIZE_AT_LOW = 120

/** 把性能档位写到 <html data-perf>：低档才写，高档删掉属性（CSS 只认 [data-perf=low]）。 */
export function applyPerfAttr(prefs: Prefs): void {
  const root = document.documentElement
  if (prefs.perf === 'low') root.dataset[PERF_ATTR] = 'low'
  else delete root.dataset[PERF_ATTR]
}

/** 长列表虚拟化阈值：按当前性能档位取。
    ⚠ 2026-10 起这个入口**没有任何调用方**（对话主列表已不再走虚拟化，
    移除理由见 components/chat/MessageList.tsx 顶部）。留着只为记录当初的策略，
    不要以为调它就能改变渲染路径。 */
export function virtualizeThreshold(): number {
  // 安全模式 / 精简模式：**不用虚拟化**（返回无穷大＝永远走普通路径）。
  // 全量 DOM 更好排查「卡在哪一条消息」，也少掉虚拟化的测量与回收 —— 它自己也是主线程上的活。
  if (isLean()) return Number.POSITIVE_INFINITY
  return appliedPrefs.perf === 'low' ? VIRTUALIZE_AT_LOW : VIRTUALIZE_AT
}

/** 动效开关写进 <html data-motion>。
    精简模式下**一律 off**：base.css 的 CSS 动画与 lib/motionPref.ts 的 motionOn()（JS 动画）
    读的是同一个属性，所以这一处写完，两边的动效一起停 —— 组件不必各自判断精简模式。 */
function applyMotionAttr(prefs: Prefs): void {
  // 动效只跟用户开关（默认 true＝全开），绝不因消息过多/精简模式自动关闭（用户明确需求）。
  document.documentElement.dataset.motion = prefs.motion ? 'on' : 'off'
}

/* 精简模式是随时可能自动进的（心跳卡顿 / 提交风暴），所以这里订阅一次：
   guard 那边状态一变，动效属性立刻跟着走，不用等下一次设置变更。 */
subscribeLean(() => { applyMotionAttr(appliedPrefs) })

/** 设置页的固定档位（自适应单独一档）。 */
export const MESSAGE_WIDTHS = [680, 768, 960] as const
/** 自适应模式：列宽上限与正文阅读上限。视口 ≥1920 时列宽再放宽一档。 */
export const FLUID_COL_W = 1180
export const FLUID_COL_W_WIDE = 1320
export const FLUID_COL_GUTTER = 128
export const FLUID_COL_GUTTER_WIDE = 160
/** 正文阅读上限：列再宽，一行字也别超过这个宽度。 */
export const READING_MAX_W = 1100
const WIDE_VIEWPORT = 1920

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? (systemDark() ? 'dark' : 'light') : mode
}

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    const prefs: Prefs = { ...DEFAULT_PREFS, ...raw }
    if (!Number.isFinite(prefs.messageWidth) || prefs.messageWidth <= 0) prefs.messageWidth = DEFAULT_PREFS.messageWidth
    // 崩溃恢复方式：只认 'auto'，其余（含老版本没存过）一律回到默认的「一键继续」。
    prefs.crashRecovery = raw.crashRecovery === 'auto' ? 'auto' : 'manual'
    // 性能模式只认 'low'，其余（含老版本没存过）一律回到默认的高观感档。
    prefs.perf = raw.perf === 'low' ? 'low' : 'high'
    // 插话模式只认 'interrupt'，其余（含老版本没存过）一律回到默认的「排队」。
    prefs.insertMode = raw.insertMode === 'interrupt' ? 'interrupt' : 'queue'
    // 安全模式只认真正的 true（宁可不降级，也别因为一个脏值把界面变成纯文本）。
    prefs.safeMode = raw.safeMode === true
    if (raw.messageWidthMode === 'fluid' || raw.messageWidthMode === 'fixed') {
      prefs.messageWidthMode = raw.messageWidthMode
    } else if (typeof raw.messageWidth === 'number' && Number.isFinite(raw.messageWidth)) {
      // 老版本没有 messageWidthMode：存过具体档位说明用户显式选过宽度，
      // 保持固定，不把老用户的列宽悄悄换成自适应。
      prefs.messageWidthMode = 'fixed'
    }
    return prefs
  } catch { return DEFAULT_PREFS }
}

/** 读取「用户是否收起会话列表」。
    老版本存的是三态（inline/drawer/hidden）：hidden 迁移成「已收起」，其余算展开，
    这样老用户升级后看到的形态与他们上次退出时一致。 */
function readListCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(LIST_COLLAPSED_KEY)
    if (raw === '1') return true
    if (raw === '0') return false
    if (localStorage.getItem(LEGACY_LIST_MODE_KEY) === 'hidden') return true
  } catch { /* 隐私模式忽略 */ }
  return false
}

/* ── 内容宽度变量 ──
   --content-w      消息栏 / 正文列宽（对话、搜索条、输入框共用）
   --content-wide-w 代码块、表格这类「宽内容」的上限，可以比正文列更宽
   --reading-w      正文阅读上限，列宽自适应时一行字不至于长到读不下去 */
export function contentWidthVars(prefs: Prefs, viewport: number): Record<string, string> {
  if (prefs.messageWidthMode === 'fixed') {
    const px = prefs.messageWidth + 'px'
    return { '--content-w': px, '--content-wide-w': px, '--reading-w': px }
  }
  const wide = viewport >= WIDE_VIEWPORT
  return {
    '--content-w': wide ? `min(${FLUID_COL_W_WIDE}px, 100% - ${FLUID_COL_GUTTER_WIDE}px)` : `min(${FLUID_COL_W}px, 100% - ${FLUID_COL_GUTTER}px)`,
    '--content-wide-w': wide ? 'min(1440px, 100% - 96px)' : 'min(1320px, 100% - 96px)',
    '--reading-w': `min(${READING_MAX_W}px, 100%)`,
  }
}

/** 自适应模式下，容器宽 x 的正文列实际会占多少 px（设置页显示「当前像素值」用）。 */
export function fluidContentPx(containerWidth: number, viewport: number): number {
  const wide = viewport >= WIDE_VIEWPORT
  const cap = wide ? FLUID_COL_W_WIDE : FLUID_COL_W
  const gutter = wide ? FLUID_COL_GUTTER_WIDE : FLUID_COL_GUTTER
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return cap
  return Math.max(0, Math.min(cap, Math.round(containerWidth - gutter)))
}

/** 当前偏好下，给定容器宽度里正文列的实际像素值。 */
export function resolveContentPx(prefs: Prefs, containerWidth: number, viewport: number): number {
  return prefs.messageWidthMode === 'fixed' ? prefs.messageWidth : fluidContentPx(containerWidth, viewport)
}

let appliedPrefs: Prefs = DEFAULT_PREFS
let wideWatcher: MediaQueryList | null = null

/** 把内容宽度写进 :root。自适应模式下 1920 断点靠监听器重算，不依赖额外 CSS 文件。 */
export function applyContentWidth(prefs: Prefs): void {
  appliedPrefs = prefs
  const root = document.documentElement
  const vars = contentWidthVars(prefs, typeof window === 'undefined' ? 1440 : window.innerWidth)
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value)
}

/** 只注册一次：重复调用不会叠加监听器。 */
function watchFluidBreakpoint(): void {
  if (wideWatcher || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  wideWatcher = window.matchMedia('(min-width: ' + WIDE_VIEWPORT + 'px)')
  wideWatcher.addEventListener('change', () => {
    if (appliedPrefs.messageWidthMode === 'fluid') applyContentWidth(appliedPrefs)
  })
}

/// 在 React 挂载前调用：把持久化的主题/字号/偏好写进 DOM，
/// 否则重启后会先按默认深色绘一帧，进设置页才跳成浅色。
export function applyStoredAppearance(): void {
  const mode = (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? 'system'
  // 默认 1.15（不是 1）：内联样式会覆盖 theme.css 的同名默认值，所以"新装用户的默认字号"
  // 只能在这里决定 —— 用户明确要求"字体再大一点"（1.15 比上一版的 1.08 再大约 6.5%）。
  // 注意 1.15 **不是**设置页里的档位（档位见 components/settings/uiFontScale.ts）：
  // 设置页把它归到最近的 1.18 显示，用户点了档位才会被改写成档位值。
  const scale = Number(localStorage.getItem(SCALE_KEY) ?? '1.18')
  const prefs = readPrefs()
  const root = document.documentElement
  const resolved = resolveTheme(mode)
  root.dataset.theme = resolved
  // 同步给壳：下次启动时窗口首帧就用这个底色，不再闪一下再跳。
  void ipc('save_theme', { theme: resolved }).catch(() => {})
  if (mode === 'system') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      const next = e.matches ? 'dark' : 'light'
      document.documentElement.dataset.theme = next
      void ipc('save_theme', { theme: next }).catch(() => {})
    })
  }
  // 安全模式要赶在动效落地之前生效：否则 ?safe=1 启动的第一帧还是会把动效与富渲染全开一遍。
  // 这里**只开不关** —— 关的那一下是用户在设置里显式操作（setPrefs），别把启动时的强制开关撤了。
  if (prefs.safeMode) setSafeMode(true)
  root.dataset.density = prefs.density
  applyMotionAttr(prefs)
  root.dataset.font = prefs.fontFamily
  applyPerfAttr(prefs)
  root.style.setProperty('--ui-font-scale', String(scale))
  applyContentWidth(prefs)
  watchFluidBreakpoint()
}

/** 右侧栏页签。'preview' 是「富内容预览」页签（跟随对话里最新的富块，可固定）。
    壳那边的 DockTab（components/shell/dockShared.tsx）与它一一对应，
    两处必须同集：少了 preview，壳只能靠一次断言把值写进来。 */
export type PanelTab = 'artifacts' | 'preview' | 'files' | 'stats' | 'context' | 'tasks'

interface UiState {
  view: ViewKey
  themeMode: ThemeMode
  fontScale: number
  panelOpen: boolean
  panelTab: PanelTab
  /** 会话列表是否被用户收起；收起后由 Rail 上的「展开会话列表」叫回来。 */
  listCollapsed: boolean
  /** 窄窗口下的抽屉是否展开：宽度自适应触发，属于临时态，不持久化。 */
  listDrawerOpen: boolean
  prefs: Prefs
  setView: (v: ViewKey) => void
  setThemeMode: (m: ThemeMode) => void
  setFontScale: (n: number) => void
  togglePanel: (open?: boolean) => void
  openPanel: (tab: PanelTab) => void
  setPanelTab: (tab: PanelTab) => void
  setListCollapsed: (v: boolean) => void
  toggleListCollapsed: () => boolean
  setListDrawerOpen: (v: boolean) => void
  setPrefs: (p: Partial<Prefs>) => void
  /** 输入框聚焦信号：自增序号，变一次就 focus 一次（0 = 从没请求过）。
      划选浮条挂在消息列表里、输入框在 Composer 里，两者不在同一棵子树，
      用序号当信号比往两边塞 ref 干净，也顺手覆盖了「加完引用把光标交给输入框」。 */
  composerFocusAt: number
  focusComposer: () => void
}

export const useUi = create<UiState>((set, get) => ({
  view: (readPrefs().defaultView ?? 'chat') as ViewKey,
  themeMode: ((typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null) as ThemeMode | null) ?? 'system',
  // 与 applyStoredAppearance 的回落值必须同值（两处都决定"没存过时是多少"）。
  fontScale: Number((typeof localStorage !== 'undefined' ? localStorage.getItem(SCALE_KEY) : null) ?? '1.18'),
  panelOpen: false,
  panelTab: 'artifacts' as PanelTab,
  listCollapsed: readListCollapsed(),
  listDrawerOpen: false,
  prefs: readPrefs(),

  setView: (view) => set({ view }),

  setThemeMode: (mode) => {
    try { localStorage.setItem(THEME_KEY, mode) } catch { /* 忽略 */ }
    const resolved = resolveTheme(mode)
    document.documentElement.dataset.theme = resolved
    void ipc('save_theme', { theme: resolved }).catch(() => {})
    set({ themeMode: mode })
  },

  setFontScale: (n) => {
    try { localStorage.setItem(SCALE_KEY, String(n)) } catch { /* 忽略 */ }
    document.documentElement.style.setProperty('--ui-font-scale', String(n))
    set({ fontScale: n })
  },

  togglePanel: (open) => set((s) => ({ panelOpen: open ?? !s.panelOpen })),

  openPanel: (tab) => set({ panelOpen: true, panelTab: tab }),
  setPanelTab: (tab) => set({ panelTab: tab }),

  setListCollapsed: (v) => {
    try { localStorage.setItem(LIST_COLLAPSED_KEY, v ? '1' : '0') } catch { /* 忽略 */ }
    set({ listCollapsed: v })
  },

  toggleListCollapsed: () => {
    const next = !get().listCollapsed
    get().setListCollapsed(next)
    return next
  },

  setListDrawerOpen: (v) => set({ listDrawerOpen: v }),

  composerFocusAt: 0,
  focusComposer: () => set((s) => ({ composerFocusAt: s.composerFocusAt + 1 })),

  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p }
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* 忽略 */ }
    const root = document.documentElement
    root.dataset.density = prefs.density
    root.dataset.font = prefs.fontFamily
    applyPerfAttr(prefs)
    applyContentWidth(prefs)
    // 安全模式开关：这里落盘之后立刻生效（进 / 出精简模式）。
    // 注意先落 prefs 再同步 guard：applyMotionAttr 读的是 appliedPrefs（applyContentWidth 刚更新过）。
    setSafeMode(prefs.safeMode)
    // 顺手同步**启动强制开关**（coomi.safe.v1）：错误边界上的「进入安全模式并重载」会把它置上，
    // 这里不跟着清的话，用户关掉开关、重启又会被那个键拉回安全模式 —— 成了一个关不掉的开关。
    setSafeOverride(prefs.safeMode)
    applyMotionAttr(prefs)
    set({ prefs })
  },
}))
