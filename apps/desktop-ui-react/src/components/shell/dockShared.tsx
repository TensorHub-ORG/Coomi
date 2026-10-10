/**
 * 右侧侧边栏（RightDock）的共享基建：
 * - 页签模型（产物 / 文件 / 统计 / 上下文 / 任务）
 * - 弹性布局度量：主内容列最小宽度、侧栏可用上限、列表栏保留阈值
 * - 面板宽度持久化 + 拖拽夹取
 * - 预览状态（/api/fs/raw）、在文件夹中打开、复制路径
 * - 各页签共用的卡片 / 进度条 / 状态块
 *
 * 这里只放「多个页签都要用」的东西，具体页签各自成文件，避免单文件继续膨胀。
 */
import { useCallback, useEffect, useState } from 'react'
import { navPauseBusy, queueDuringNavPause } from './navPause'
import { Eye, Files, Layers, ListChecks, Package, ChartNoAxesCombined } from 'lucide-react'
import { create } from 'zustand'
import { toast } from 'sonner'
import { cn } from '../../lib/cn'
import { ipc } from '../../lib/ipc'
import { useEngine } from '../../stores/engine'
import { useUi, type PanelTab } from '../../stores/ui'
import { Empty } from '../ui/Card'
import type { EmptyArtKind } from '../ui/EmptyArt'
import { Progress, SkeletonRows } from '../ui/Controls'

/* ── 页签模型 ──
   stores/ui.ts 的 PanelTab 目前只声明了三个页签，这里按同一字段扩展到六个；
   写入时用一次断言，等 store 的类型补齐后可以直接删掉那处断言。
   preview 是「富内容预览」页签：跟随对话里最新的富块，可固定在某一块上。 */
export type DockTab = 'artifacts' | 'preview' | 'files' | 'stats' | 'context' | 'tasks'

export interface DockTabMeta {
  key: DockTab
  label: string
  desc: string
  icon: React.ReactNode
}

/** 五个页签的唯一登记处：右侧图标条与面板标题都读它，避免两处各写一份。 */
export const DOCK_TABS: DockTabMeta[] = [
  { key: 'artifacts', label: '产物', desc: '本次会话产出的文件与图片', icon: <Package size={16} /> },
  { key: 'preview', label: '预览', desc: '跟随会话里最新的富内容块，可固定', icon: <Eye size={16} /> },
  { key: 'files', label: '文件', desc: '当前工作目录的文件树', icon: <Files size={16} /> },
  { key: 'stats', label: '统计', desc: 'token 用量、速度与缓存命中', icon: <ChartNoAxesCombined size={16} /> },
  { key: 'context', label: '上下文', desc: '上下文占用与压缩情况', icon: <Layers size={16} /> },
  { key: 'tasks', label: '任务', desc: '运行中任务、引擎健康与日志', icon: <ListChecks size={16} /> },
]

export function useDockTab(): DockTab {
  // stores/ui.ts 的 PanelTab 已经扩成 5 个值，这里的断言只是「子集 → 联合」的安全收窄。
  const tab = useUi((s) => s.panelTab)
  return DOCK_TABS.some((t) => t.key === tab) ? (tab as DockTab) : 'artifacts'
}

/** 打开侧栏并切到指定页签。
    stores/ui.ts 的 PanelTab 联合还没带上 'preview'（那个文件不归本模块改），
    这里用一次断言把它写进同一个字段：运行时本来就是同一个字符串，读的时候由 useDockTab 收窄回来。 */
export function openDockTab(tab: DockTab): void {
  useUi.setState({ panelOpen: true, panelTab: tab as unknown as PanelTab })
}

/* ── 弹性布局度量 ──
   右侧栏绝不覆盖主内容：它是 flex 兄弟节点，宽度由这几个常量与视口宽度共同决定。 */
export const RAIL_W = 60
export const DOCK_BAR_W = 40
export const LIST_W = 264
export const PANEL_DEFAULT_W = 340
export const PANEL_MIN_W = 240
export const PANEL_MAX_W = 1600
/** 主内容列最小宽度：Composer 整行（工具按钮 + 发送按钮）必须放得下。 */
export const MAIN_MIN_W = 320
/** 左侧会话列表的保留阈值：低于它就不再内嵌占位，改降级成抽屉浮层。 */
export const LIST_MIN_VIEWPORT = RAIL_W + LIST_W + 560 + PANEL_MIN_W + DOCK_BAR_W
/** 会话列表宽度：内嵌 240–420，抽屉 264–360（抽屉是浮层，别一开就压掉半屏内容）。 */
export const LIST_MIN_W = 240
export const LIST_MAX_W = 420
export const LIST_DRAWER_MIN_W = 264
export const LIST_DRAWER_MAX_W = 360
/** 抽屉浮层底部让给 Composer 输入区的高度：抽屉绝不盖在输入框上。 */
export const COMPOSER_ZONE_H = 116

export function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  useEffect(() => {
    // 拖窗口时 resize 一秒能来几十次：宽度没真的变就**一个 setState 都不发**
    // （值相同的 setState 虽然会被 React 挡掉，但那仍是一次「渲染调度」的入口）。
    const onResize = (): void => {
      const next = window.innerWidth
      setWidth((prev) => (prev === next ? prev : next))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

export function listPaneVisible(viewport: number): boolean {
  return viewport >= LIST_MIN_VIEWPORT
}

/** 窄窗口＝内嵌放不下，列表只能以抽屉浮层出现。
    这是宽度自适应触发的**布局态**，不是用户偏好，所以不落盘。 */
export function listPaneNarrow(viewport: number): boolean {
  return viewport < LIST_MIN_VIEWPORT
}

/** 会话列表的收放：只有两个开关，没有「内嵌→抽屉→隐藏」的循环。
    - listCollapsed：用户自己点「收起」收掉的（持久化，Rail 上的图标能叫回来）；
    - listDrawerOpen：窄窗口下抽屉是否展开（临时态）。
    open() 按当前窗口宽度决定「叫回来」的是什么形态：窄窗是抽屉，宽窗是内嵌栏。 */
export function useListPaneLayout(): {
  narrow: boolean
  showInline: boolean
  showDrawer: boolean
  open: () => void
  close: () => void
} {
  const viewport = useViewportWidth()
  const view = useUi((s) => s.view)
  const collapsed = useUi((s) => s.listCollapsed)
  const drawerOpen = useUi((s) => s.listDrawerOpen)
  const narrow = listPaneNarrow(viewport)
  const onChat = view === 'chat'

  const open = useCallback((): void => {
    const ui = useUi.getState()
    // 列表只在对话页出现：在别的页面点「展开会话列表」时先回对话页，
    // 否则点了半天看不到任何变化。
    if (ui.view !== 'chat') ui.setView('chat')
    if (listPaneNarrow(viewport)) ui.setListDrawerOpen(true)
    else ui.setListCollapsed(false)
  }, [viewport])

  const close = useCallback((): void => {
    const ui = useUi.getState()
    if (listPaneNarrow(viewport)) ui.setListDrawerOpen(false)
    else ui.setListCollapsed(true)
  }, [viewport])

  return {
    narrow,
    showInline: onChat && !narrow && !collapsed,
    showDrawer: onChat && narrow && drawerOpen,
    open,
    close,
  }
}

/** 侧栏面板在当前视口下的宽度上限：先扣掉固定栏与主列最小宽度，剩余空间才归侧栏。
    列表在抽屉/隐藏形态下不占布局宽度，此时不预留它的 264px。 */
export function panelMaxWidth(viewport: number, listInline = listPaneVisible(viewport)): number {
  const reserved = RAIL_W + DOCK_BAR_W + MAIN_MIN_W + (listInline ? LIST_W : 0)
  return Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, Math.floor((viewport - RAIL_W - DOCK_BAR_W - (listInline ? LIST_W : 0)) / 2), viewport - reserved))
}

/* ── 会话列表宽度 ──
   内嵌 240–420、抽屉 264–360，都存同一个 key：拖过的宽度换到另一种形态仍然沿用（按形态夹取）。 */
const LIST_W_KEY = 'coomi.list.w'

export function readListWidth(): number {
  try {
    const raw = Number(localStorage.getItem(LIST_W_KEY))
    if (Number.isFinite(raw) && raw > 0) return Math.round(raw)
  } catch { /* 隐私模式忽略 */ }
  return LIST_W
}

export function useListWidth(variant: 'inline' | 'drawer'): {
  width: number
  setWidth: (next: number) => void
  min: number
  max: number
} {
  const [stored, setStored] = useState<number>(() => readListWidth())
  const min = variant === 'drawer' ? LIST_DRAWER_MIN_W : LIST_MIN_W
  const max = variant === 'drawer' ? LIST_DRAWER_MAX_W : LIST_MAX_W
  const setWidth = (next: number): void => {
    if (!Number.isFinite(next)) return
    const clamped = Math.min(max, Math.max(min, Math.round(next)))
    setStored(clamped)
    try { localStorage.setItem(LIST_W_KEY, String(clamped)) } catch { /* 忽略 */ }
  }
  return { width: Math.min(max, Math.max(min, stored)), setWidth, min, max }
}

const DOCK_W_KEY = 'coomi.dock.w'

export function readDockWidth(): number {
  try {
    const raw = Number(localStorage.getItem(DOCK_W_KEY))
    if (Number.isFinite(raw) && raw > 0) return Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, Math.round(raw)))
  } catch { /* 隐私模式忽略 */ }
  return PANEL_DEFAULT_W
}

/** 侧栏宽度：拖过的宽度记在 localStorage，展示时再按视口夹取一次。 */
export function useDockWidth(): { width: number; setWidth: (next: number) => void; max: number } {
  const viewport = useViewportWidth()
  // 列表收起（或窄窗口下未展开）时不占布局宽度，侧栏因此可以更宽：上限得跟着列表形态走。
  const listCollapsed = useUi((s) => s.listCollapsed)
  const listInline = !listCollapsed && listPaneVisible(viewport)
  const max = panelMaxWidth(viewport, listInline)
  const [width, setWidthState] = useState<number>(() => readDockWidth())
  const setWidth = (next: number): void => {
    if (!Number.isFinite(next)) return
    // 存的就是用户当场看到的宽度：不让「存了 560、显示 516」这种不一致出现，
    // 换到更宽的窗口时也仍然是用户拖过的那个宽度。
    const clamped = Math.min(max, Math.max(PANEL_MIN_W, Math.round(next)))
    setWidthState(clamped)
    try { localStorage.setItem(DOCK_W_KEY, String(clamped)) } catch { /* 忽略 */ }
  }
  return { width: Math.min(width, max), setWidth, max }
}

/* ── 文件系统 ── */
export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modified: number
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

export function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

/** 读取目录：引擎的 /api/fs/list 只回名字，这里补全绝对路径（子节点要用它继续列目录）。 */
export async function listDirectory(dir: string): Promise<{ dir: string; entries: FsEntry[] }> {
  const data = await useEngine.getState().api<{ path?: string; entries?: Array<Record<string, unknown>> }>(
    '/api/fs/list?path=' + encodeURIComponent(dir || ''),
  )
  const resolved = data.path ?? dir
  const entries: FsEntry[] = (data.entries ?? []).map((raw) => {
    const name = String(raw.name ?? '')
    return {
      name,
      path: joinPath(resolved, name),
      isDir: raw.is_dir === true || raw.type === 'dir',
      size: Number(raw.size ?? 0),
      // 引擎返回的是秒级时间戳，统一成毫秒给 fmtTime 用。
      modified: Number(raw.modified ?? 0) * 1000,
    }
  })
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  return { dir: resolved, entries }
}

export interface PathStat { exists: boolean; isDir: boolean; size: number; modified: number }

/** /api/fs/stat：产物列表要知道大小与修改时间；文件不存在时回 exists:false 而不是抛错。 */
export async function statPath(path: string): Promise<PathStat> {
  try {
    const data = await useEngine.getState().api<{ is_dir?: boolean; size?: number; modified?: number }>(
      '/api/fs/stat?path=' + encodeURIComponent(path),
    )
    return {
      exists: true,
      isDir: data.is_dir === true,
      size: Number(data.size ?? 0),
      modified: Number(data.modified ?? 0) * 1000,
    }
  } catch {
    return { exists: false, isDir: false, size: 0, modified: 0 }
  }
}

/* ── 预览：图片直接渲染，文本走 /api/fs/raw ── */
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i
export const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|toml|ini|cfg|conf|env|js|mjs|cjs|ts|tsx|jsx|css|scss|less|html|htm|xml|py|rs|go|java|kt|swift|rb|php|sh|bash|zsh|ps1|bat|cmd|c|h|cc|cpp|hpp|cs|sql|log|csv|tsv|patch|diff|gitignore)$/i

export function rawUrl(path: string): string {
  const port = useEngine.getState().port
  return 'http://127.0.0.1:' + port + '/api/fs/raw?path=' + encodeURIComponent(path)
}

export async function readRawText(path: string): Promise<string> {
  const engine = useEngine.getState()
  const res = await fetch('http://127.0.0.1:' + engine.port + '/api/fs/raw?path=' + encodeURIComponent(path), {
    headers: engine.authHeaders(),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const text = await res.text()
  // 预览不设上限会把几 MB 的日志直接塞进 DOM：截断后明确告诉用户。
  return text.length > 400_000 ? text.slice(0, 400_000) + '\n\n…（内容过长，已截断）' : text
}

/** 取日志尾部：只渲染最后 n 行，避免大日志拖慢侧栏。 */
export function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

interface DockPreviewState {
  path: string
  name: string
  text: string
  loading: boolean
  error: string
  open: (path: string) => Promise<void>
  close: () => void
}

export const useDockPreview = create<DockPreviewState>((set) => ({
  path: '',
  name: '',
  text: '',
  loading: false,
  error: '',
  open: async (path) => {
    set({ path, name: basename(path), text: '', loading: !IMAGE_EXT.test(path), error: '' })
    if (IMAGE_EXT.test(path)) return
    if (!TEXT_EXT.test(path)) {
      set({ loading: false, error: '这类文件不做内联预览，可用「在文件夹中打开」查看。' })
      return
    }
    try {
      const text = await readRawText(path)
      set({ text, loading: false, error: '' })
    } catch (e) {
      set({ text: '', loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  },
  close: () => set({ path: '', name: '', text: '', loading: false, error: '' }),
}))

export async function revealPath(path: string): Promise<void> {
  if (!path) return
  try {
    await ipc('open_path', { path })
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '无法打开文件夹')
  }
}

export async function copyPath(path: string): Promise<void> {
  if (!path) return
  try {
    await navigator.clipboard.writeText(path)
    toast.success('已复制路径')
    return
  } catch { /* 剪贴板不可用时走下面的兜底 */ }
  try {
    const el = document.createElement('textarea')
    el.value = path
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    if (ok) toast.success('已复制路径')
    else toast.error('复制失败，请手动复制')
  } catch {
    toast.error('复制失败，请手动复制')
  }
}

/* ── 运行中任务数：右侧图标条上的小红点用得上 ──
   走引擎的轻量接口 /api/sessions/running（引擎注释里写明是给前端轮询用的），
   不用 /api/tasks —— 后者会逐个会话读盘。 */
export function useRunningTaskCount(enabled: boolean): number {
  const ready = useEngine((s) => s.ready)
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled || !ready) { setCount(0); return }
    let alive = true
    const tick = async (): Promise<void> => {
      if (!alive) return
      // 切页过渡那 250ms 不发起新请求：主线程与网络都让给过渡，
      // 收闸时按 key 合并补一次（连点两下导航也只补一次，不是每次都补）。
      if (navPauseBusy()) { queueDuringNavPause('dock-running-count', () => { void tick() }); return }
      try {
        const data = await useEngine.getState().api<{ sessions?: unknown[] }>('/api/sessions/running')
        if (alive) setCount(Array.isArray(data.sessions) ? data.sessions.length : 0)
      } catch { if (alive) setCount(0) }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 10000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [enabled, ready])
  return count
}

/* ── 通用小组件 ── */
/** 分组卡片：统一 14px 圆角 + elev 阴影，页签里的内容都装在它里面。 */
export function DockCard({ title, hint, actions, children, className }: {
  title?: string
  hint?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('card-lift rounded-lg border border-line bg-surface elev-1', className)}>
      {title ? (
        <div className='flex items-start gap-2 px-3 pt-2.5 pb-1'>
          <div className='min-w-0 flex-1'>
            <h3 className='truncate text-12 font-semibold text-ink'>{title}</h3>
            {hint ? <p className='mt-0.5 text-11 leading-[1.5] text-ink-4'>{hint}</p> : null}
          </div>
          {actions ? <div className='flex shrink-0 items-center gap-0.5'>{actions}</div> : null}
        </div>
      ) : null}
      <div className='px-3 pb-3 pt-1'>{children}</div>
    </section>
  )
}

/** 一行「标签 — 值」，值用等宽字体，扫一眼就能对齐比较。 */
export function MetricRow({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className='flex items-baseline gap-2 py-1'>
      <div className='min-w-0 flex-1 truncate'>
        <span className='text-12 text-ink-2'>{label}</span>
        {hint ? <span className='ml-1.5 text-11 text-ink-4'>{hint}</span> : null}
      </div>
      <span className='shrink-0 font-mono text-12 text-ink'>{value}</span>
    </div>
  )
}

/** 进度条一行：复用 ui/Controls 的 Progress，色调仍走主题变量。 */
export function MeterRow({ label, ratio, value, hint, tone = 'primary' }: {
  label: string
  ratio: number
  value: string
  hint?: string
  tone?: 'primary' | 'ok' | 'warn' | 'danger'
}) {
  const toneClass = tone === 'ok' ? '[&>div]:bg-ok' : tone === 'warn' ? '[&>div]:bg-warn' : tone === 'danger' ? '[&>div]:bg-danger' : ''
  return (
    <div className='py-1.5'>
      <div className='flex items-baseline gap-2'>
        <span className='min-w-0 flex-1 truncate text-12 text-ink-2'>{label}</span>
        <span className='shrink-0 font-mono text-12 text-ink'>{value}</span>
      </div>
      <Progress value={ratio} className={cn('mt-1.5 h-1.5', toneClass)} />
      {hint ? <p className='mt-1 text-11 text-ink-4'>{hint}</p> : null}
    </div>
  )
}

/** 加载 / 错误 / 空 三态统一走这里，避免每个页签各写一套。 */
export function StateBlock({ loading, error, empty, emptyTitle, emptyDesc, emptyIcon, emptyArt, onRetry, children }: {
  loading?: boolean
  error?: string
  empty?: boolean
  emptyTitle?: string
  emptyDesc?: string
  emptyIcon?: React.ReactNode
  /** 自绘空态插画（优先于 emptyIcon）：无会话 / 无产物 / 无任务 / 无搜索 / 引擎未就绪。 */
  emptyArt?: EmptyArtKind
  onRetry?: () => void
  children?: React.ReactNode
}) {
  if (loading) {
    // 加载态统一用骨架屏：比转圈更能说明「这里马上会出现一个列表」，也免去各页签各写一句「加载中…」。
    return <SkeletonRows rows={3} className='px-1' />
  }
  if (error) {
    return (
      <div className='rounded-md border border-danger/30 bg-danger-soft px-2.5 py-2 text-12 text-danger'>
        <p className='break-words'>{error}</p>
        {onRetry ? <button type='button' className='mt-1 text-11 underline underline-offset-2' onClick={onRetry}>重试</button> : null}
      </div>
    )
  }
  if (empty) {
    return <Empty compact art={emptyArt} icon={emptyIcon} title={emptyTitle ?? '暂无数据'} description={emptyDesc} />
  }
  return <>{children}</>
}
