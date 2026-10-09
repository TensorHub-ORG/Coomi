/** 技能中心三处长列表共用的窗口化（virtualization）：只渲染「可视区 ± overscan 行」。
 *
 *  为什么自己写、不引依赖也不复用 react-virtuoso：
 *   · react-virtuoso 还在 dependencies 里，但它已从对话列表里移除（见 components/chat/MessageList.tsx），
 *     再拉回来要重新踩「测量节点 contain:layout 量出 0」「流式期间逐帧重量」「跳位」那几个坑；
 *   · 这里要的只是「不等高 + 锚点校正 + 网格分组」两百行以内的实现，自己写反而可控、可注释。
 *  所以本文件零新依赖，只用 react。
 *
 *  ── 为什么行高必须「测量 + 缓存」而不是固定行高 ──
 *  三处列表的条目高度天然不一样：任务卡片带不带错误行、日志面板展不展开（能差 400px），
 *  市场卡片描述 1~3 行、有没有「缺少运行时」警告行。固定行高要么留白要么裁切；
 *  只按估算排又会越滚越偏（滚动条和实际内容对不上）。于是：
 *    ① 首帧按 estimate 占位；
 *    ② 每次提交后用 getBoundingClientRect 量**这一帧渲染出来的那些行**，按「行 key」写进缓存；
 *    ③ 高度变了就重算前缀和并重渲。
 *  光有 ①②③ 还不够 —— 一旦「视口上方」的行被量高了，整段内容会往下平移，
 *  用户会看到自己明明没滚、内容却跳了一格。所以提交测量结果时同时记下
 *  「视口顶端那一行 + 它在视口里的偏移」，重排后在**浏览器绘制之前**把 scrollTop
 *  补上同样的差（见 pendingAnchor / ①号布局副作用）：用户眼里第一行始终钉在原地。
 *  这就是「不用会跳动的方案」的落点。
 *
 *  ── 为什么以「行」为单位，而不是「条目」──
 *  市场页的卡片是 CSS 网格（grid-cols-1 md:grid-cols-2 2xl:grid-cols-3），一行里可能有 2~3 张卡。
 *  列数**不写死在 JS 里**：那样一旦和 Tailwind 断点不同步，就会把卡片排错行。
 *  改为从已经渲染出来的那层网格上读 getComputedStyle().gridTemplateColumns 的真实轨道数
 *  —— 组件的 class 是唯一事实来源。容器的宽度变化由 ResizeObserver 重新读一次。
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, RefCallback, UIEvent } from 'react'

/** 一行（网格里的一排卡片 / 普通列表里的一项）。 */
export interface VirtualRow {
  /** 行序号（0 起）。 */
  index: number
  /** 行内条目区间，右开：[from, to)。非网格列表恒为 index .. index + 1。 */
  from: number
  to: number
  /** 行高缓存的键（含列数：换列数后同一批条目的行高不再成立，必须重新量）。 */
  key: string
  /** 行在内容坐标系里的起始 y。 */
  start: number
  /** 行高：实测值，没量过时是估算值。 */
  size: number
}

export interface UseVirtualListOptions {
  /** 全部条目的稳定 key（长度 = 条目数）。必须由调用方 useMemo 稳定住，否则每帧都重排。 */
  keys: readonly string[]
  /** 没量过时的估算行高（px）。网格列表按「一张卡」估即可（行高取行内最高的那张）。 */
  estimate: number | ((index: number) => number)
  /** 行间距（对应 grid 的 gap / flex 的 gap）。 */
  gap?: number
  /** 可视区上下各多渲染几行。 */
  overscan?: number
  /** 行数少于它就不窗口化（短列表窗口化反而更贵，还会丢掉 Ctrl+F 划选）。 */
  minCount?: number
  /** 首帧还没量到 clientHeight 时的视口高度估算（只影响第一帧渲染几行）。 */
  fallbackViewport?: number
}

export interface UseVirtualListResult {
  /** 这一帧要渲染的行（未窗口化时是全部行）。 */
  rows: VirtualRow[]
  /** 内容总高：挂在撑高元素的 height 上。 */
  totalSize: number
  /** 当前有没有真的走窗口化。 */
  virtualized: boolean
  /** 挂到滚动容器（overflow-y-auto 那一层）。 */
  attachRef: RefCallback<HTMLElement>
  /** 挂到滚动容器的 onScroll（要和其他 onScroll 合成时自己串一下）。 */
  handleScroll: (event: UIEvent<HTMLElement>) => void
  /** 行 wrapper 的内联样式（绝对定位 + translateY）。只给窗口化分支用。 */
  rowStyle: (row: VirtualRow) => CSSProperties
  /** 未窗口化分支挂在每条上的兜底样式（当前恒为空对象，见 CV_MIN_ROWS）。 */
  fallbackStyle: CSSProperties
  /** 换源 / 换关键词后把滚动位置拉回顶部（同时把窗口重置回首屏）。 */
  scrollToTop: () => void
}

/** 可视区上下各多渲染几行：给「滚得快」和「刚量完高度」留缓冲，避免白屏。 */
const DEFAULT_OVERSCAN = 6
/** 少于这么多行就整列渲染。 */
const DEFAULT_MIN_COUNT = 40
/** 首帧视口高度兜底：约一屏卡片。 */
const DEFAULT_VIEWPORT = 480

const EMPTY_STYLE: CSSProperties = {}

/** 未窗口化时的长列表兜底：给条目挂 content-visibility:auto（离屏条目不布局不绘制）。
 *
 *  ⚠ 这里恒为「不挂」，不是漏写。本项目两次真机取证都证明这个属性会把
 *  **就在视口里**的条目判成「与用户无关」而跳过绘制（DOM 在、高度也对，屏幕上却是空白）：
 *    · styles/base.css 802-826 行、views/ArtifactsView.tsx 29-35 行（那里同样用
 *      Number.POSITIVE_INFINITY 把同一个开关关掉）；
 *    · tests/check-msg-visibility.mjs 直接从源码层面断言「全仓 TSX 不许出现 contentVisibility」。
 *  而窗口化已经把 DOM 限制在可视区 ± overscan 行，这点布局开销不值得拿「卡片可能不显示」去换。
 *  要打开：把 CV_MIN_ROWS 改成 60，并把下面 EMPTY_STYLE 换成
 *  { contentVisibility: 'auto', containIntrinsicSize: 'auto 160px' }，
 *  同时删掉 tests/check-msg-visibility.mjs 里那条全仓断言。
 *  另：绝不能挂到 [data-vi] 的测量节点上 —— 那是被 getBoundingClientRect 量的元素。 */
const CV_MIN_ROWS = Number.POSITIVE_INFINITY
const CV_ROW: CSSProperties = {}

/** 把「只为最新一次渲染存在」的值塞进 ref。
 *  用途：传给 memo 卡片的回调要用 useCallback([]) 稳定住引用（否则 memo 白做），
 *  但回调内部又必须读到最新的 props —— onNotice / onChanged 这类由上层随手传，
 *  每次父组件渲染都可能是新函数。走 ref 读最新值，回调引用就不会变。 */
export function useLatestRef<T>(value: T): { current: T } {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/** 从已经渲染出来的那层网格上读真实列数。
 *  为什么这么读：组件的 Tailwind 断点（grid-cols-1 md:grid-cols-2 2xl:grid-cols-3）是唯一事实来源，
 *  JS 里再写一份阈值迟早会不同步，卡片就会排错行。
 *  返回 0 表示「这次读不可信」（元素没上屏时 getComputedStyle 会把 repeat(...) 原样吐出来，
 *  按空格切会数出 6 个假轨道）—— 调用方保持上一次的列数。 */
function gridTracks(grid: HTMLElement | null): number {
  if (!grid) return 0
  const tpl = getComputedStyle(grid).gridTemplateColumns
  if (!tpl || tpl.includes('repeat(')) return 0
  const tracks = tpl.trim().split(/\s+/).length
  return tracks > 0 && tracks <= 24 ? tracks : 0
}

export function useVirtualList(options: UseVirtualListOptions): UseVirtualListResult {
  const {
    keys, estimate, gap = 0, overscan = DEFAULT_OVERSCAN,
    minCount = DEFAULT_MIN_COUNT, fallbackViewport = DEFAULT_VIEWPORT,
  } = options

  const count = keys.length
  const virtualized = count > minCount

  /** 滚动容器用 state 存而不是 ref：市场页的容器要等清单拉回来才渲染，
   *  ref 回调那一刻 effect 已经跑过了，ResizeObserver 会永远挂不上。 */
  const [node, setNode] = useState<HTMLElement | null>(null)
  const attachRef = useCallback<RefCallback<HTMLElement>>((el) => setNode(el), [])

  /** 实测行高：按行 key 存。列表增删 / 排序时不会把别行的高借过来。 */
  const heights = useRef(new Map<string, number>())
  const [version, setVersion] = useState(0)
  const [viewport, setViewport] = useState(fallbackViewport)
  /** 网格列数：从渲染出来的网格上读，见文件头。 */
  const [columns, setColumns] = useState(1)
  const [range, setRange] = useState(() => ({ start: 0, end: overscan * 2 + 12 }))
  /** 测量引起重排时要补的滚动位移（文件头「不跳动」那段）。 */
  const pendingAnchor = useRef<{ index: number; delta: number } | null>(null)
  const frame = useRef(0)

  const estimateAt = useCallback(
    (index: number): number => (typeof estimate === 'function' ? estimate(index) : estimate),
    [estimate],
  )

  /** 前缀和：把「行 key → 实测高」摊平成每一行的 start / size。 */
  const rows = useMemo<VirtualRow[]>(() => {
    const per = virtualized ? Math.max(1, columns) : 1
    const rowCount = Math.ceil(count / per)
    const out: VirtualRow[] = []
    let y = 0
    for (let r = 0; r < rowCount; r += 1) {
      const from = r * per
      const to = Math.min(count, from + per)
      // 列数进 key：换列数后「同一批条目组成的一行」高度不一样了，旧缓存必须作废。
      const key = per + '|' + (keys[from] ?? '') + '|' + (to - from)
      const size = heights.current.get(key) ?? estimateAt(r)
      out.push({ index: r, from, to, key, start: y, size })
      y += size + (r < rowCount - 1 ? gap : 0)
    }
    return out
  }, [count, keys, columns, gap, virtualized, estimateAt, version])

  const last = rows.length ? rows[rows.length - 1] : null
  const totalSize = last ? last.start + last.size : 0

  // 事件回调里读最新值：这些回调要稳定（滚动监听不想每帧重挂）。
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const gapRef = useRef(gap)
  gapRef.current = gap
  const overscanRef = useRef(overscan)
  overscanRef.current = overscan
  const virtualizedRef = useRef(virtualized)
  virtualizedRef.current = virtualized
  const nodeRef = useRef<HTMLElement | null>(null)
  nodeRef.current = node

  /** 视口该渲染哪几行：二分找第一行，再往后走到视口底部。 */
  const rangeFor = useCallback((top: number, height: number): { start: number; end: number } => {
    const list = rowsRef.current
    if (!list.length) return { start: 0, end: 0 }
    const g = gapRef.current
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].start + list[mid].size + g <= top) lo = mid + 1
      else hi = mid
    }
    const first = Math.min(lo, list.length - 1)
    let end = first
    const bottom = top + height
    while (end < list.length && list[end].start < bottom) end += 1
    const over = overscanRef.current
    return { start: Math.max(0, first - over), end: Math.min(list.length, end + over) }
  }, [])

  /* ① 补位移：上一轮测量把「视口上方」的行改高了，这里在绘制前把 scrollTop 平移回去。
        必须排在 ②③ 之前 —— 否则 ② 会拿一个还没校正的 scrollTop 去算窗口，白算一帧。 */
  useLayoutEffect(() => {
    const pending = pendingAnchor.current
    if (!pending) return
    pendingAnchor.current = null
    const el = nodeRef.current
    const row = rowsRef.current[pending.index]
    if (!el || !row) return
    const next = row.start + pending.delta
    if (Math.abs(el.scrollTop - next) > 0.5) el.scrollTop = next
  }, [version])

  /* ② 重算窗口：offsets / 视口 / 是否窗口化 任何一样变了都要重算。
        只在窗口边界真的变了才 setState：滚动过程中大部分帧落在同一窗口里，不该重渲。 */
  useLayoutEffect(() => {
    const el = nodeRef.current
    if (!el) return
    const next = virtualized ? rangeFor(el.scrollTop, el.clientHeight) : { start: 0, end: rows.length }
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [node, rows, virtualized, rangeFor, viewport])

  /* ③ 测量 + 读列数：每次提交都过一遍（行内容变了高度也会变，只认 rows 变化会漏）。
        量的是 [data-vi] 这层 wrapper（不是里面的卡片）：内容以后加什么隔离都不影响测量。 */
  useLayoutEffect(() => {
    const el = nodeRef.current
    if (!el || !virtualized) return

    const tracks = gridTracks(el.querySelector<HTMLElement>('[data-vi-grid]'))
    if (tracks > 0 && tracks !== columns) setColumns(tracks)

    let changed = false
    for (const item of el.querySelectorAll<HTMLElement>('[data-vi]')) {
      const index = Number(item.dataset.vi)
      const row = rowsRef.current[index]
      if (!row || Number.isNaN(index)) continue
      // 四舍五入到 0.01px：亚像素抖动不该触发重排，否则会在「量 → 重排 → 再量」里自激。
      const height = Math.round(item.getBoundingClientRect().height * 100) / 100
      if (!(height > 0)) continue
      const prev = heights.current.get(row.key)
      if (prev !== undefined && Math.abs(prev - height) <= 0.5) continue
      heights.current.set(row.key, height)
      changed = true
    }
    if (!changed) return

    // 锚点＝视口顶端那一行 + 它在视口里的偏移。重排后 ① 号副作用照它补 scrollTop。
    const list = rowsRef.current
    if (!list.length) return
    const top = el.scrollTop
    const g = gapRef.current
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].start + list[mid].size + g <= top) lo = mid + 1
      else hi = mid
    }
    const anchor = Math.min(lo, list.length - 1)
    pendingAnchor.current = { index: anchor, delta: top - list[anchor].start }
    setVersion((v) => v + 1)
  })

  /* ④ 视口尺寸 / 列数跟着容器走：窗口宽度跨过断点时列数会变，行高缓存必须重来一遍。 */
  useLayoutEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setViewport(node.clientHeight)
      const tracks = gridTracks(node.querySelector<HTMLElement>('[data-vi-grid]'))
      if (tracks > 0) setColumns(tracks)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  // 卸载时清掉在途的那一帧。
  useLayoutEffect(() => () => {
    if (frame.current) window.cancelAnimationFrame(frame.current)
  }, [])

  const handleScroll = useCallback((event: UIEvent<HTMLElement>): void => {
    if (!virtualizedRef.current) return
    // rAF 合帧：滚动事件一帧能来好几次，每次都算一遍窗口是白烧主线程。
    if (frame.current) return
    const el = event.currentTarget
    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0
      const next = rangeFor(el.scrollTop, el.clientHeight)
      setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
    })
  }, [rangeFor])

  const rowStyle = useCallback((row: VirtualRow): CSSProperties => ({
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    transform: 'translateY(' + row.start + 'px)',
  }), [])

  const scrollToTop = useCallback((): void => {
    if (node) node.scrollTop = 0
    setRange({ start: 0, end: overscan * 2 + 12 })
  }, [node, overscan])

  // 未窗口化（短列表）时的兜底：见 CV_MIN_ROWS 的说明。
  const fallbackStyle = !virtualized && count >= CV_MIN_ROWS ? CV_ROW : EMPTY_STYLE

  /** 真正交给渲染的是「可视窗口」这一小段；不入窗的行一个 DOM 都不建。
   *  注意 rowsRef 里存的仍是全量行 —— 窗口计算与测量都必须按全量下标来。 */
  const windowRows = useMemo<VirtualRow[]>(() => {
    if (!virtualized || !rows.length) return rows
    const start = Math.max(0, Math.min(range.start, rows.length - 1))
    const end = Math.max(start + 1, Math.min(range.end, rows.length))
    return rows.slice(start, end)
  }, [rows, range, virtualized])

  return { rows: windowRows, totalSize, virtualized, attachRef, handleScroll, rowStyle, fallbackStyle, scrollToTop }
}
