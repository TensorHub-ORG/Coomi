/**
 * 对话区左侧的消息导航条（消息小地图 · tick rail 刻度轨）。
 *
 * 存在的理由：长会话里「回到某一轮」只有滚动条一条路，而滚动条没有刻度。
 * 这里按「轮」取刻度，给出一列可点、可悬停预览、可键盘跳转的坐标。
 *
 * 版面（这一版：**tick rail 刻度轨** —— VS Code 概览标尺 / GitHub diff minimap / 对话 tick rail 那一类做法）
 *   · 轨道 **40px 宽、透明、无边框**：左缘 6px 指示留白 + 22px 左侧刻度车道 + 2px 缝 + 10px 右侧刻度车道。
 *     整体贴内容列左缘外侧、垂直居中（top:50% + translateY(-50%)）。没有任何卡片感：轨道本身看不见，
 *     刻度线就是全部内容。
 *   · 每轮**两条线**，形状只有一种：2px 高、1px 圆角（高 2px 时 rounded-full 就是 1px 半径）的细横线。
 *   · **左＝AI 回复**：细线**左对齐**、往右长，长度按这一轮的体量**对数映射**
 *     （最短 4px / 基线 10px / 最长 22px，见 aiLength）；轮里有工具调用，线的**末段换一段更淡的**
 *     （opacity .5，宽度按工具占这一轮体量的比例给 2~5px）；轮里有错误，线的**最右端加 2px 红点**。
 *   · **右＝用户消息**：细线**右对齐**、往左长，长度按这条消息的字数对数映射
 *     （最短 4px / 最长 10px，见 userLength），颜色是 60% 的主色 —— 一问一答分列两端，秩序感来自这条对齐。
 *   · 两条车道各自从本侧基准往中间长，最长的一轮中间也留得住 2px 缝：任何一档都不会叠在一起，
 *     所以不再需要「向左多留一截」那套位移，自滚档的 overflow 也不会把线裁掉。
 *   · 长度自适应：
 *     高度 = 刻度数 × 行距，下限 48px，上限 min(70vh, 520px)；超上限依次
 *     压行距（空隙 10 → 8 → 6 → 5 → 4，即行距 12 → 10 → 8 → 7 → 6）→ 降聚合预算（按窗口能放下多少行算）
 *     → 最后才让轨道自己滚。左缘留 6px 给位置指示条，刻度线因此不被指示条压住。
 *
 * 悬停（**0ms 展开** / 140ms 收回，曲线 --ease-spring）
 *   · 该行两条线一起变主色并各自伸展到本侧最长（22px / 10px），**其余行统一降到 opacity .25**（聚光灯），
 *     右侧弹出预览卡：**上段＝用户问题（大号）/ 细分割线 / 下段＝AI 回复摘要**，上下按可视区夹取。
 *   · 展开**不等待**（HOVER_IN_MS = 0）：导航条是一列 12px 高的细线，误触成本极低，
 *     120ms 的防抖换来的只是「放上去卡一下」的观感。移出方向仍留 140ms（划过一行不算选中）。
 *   · 悬停左线 / 右线**不再切换内容**：问与答一次讲全，半边只决定「高亮哪一段」（data-nav-focus）。
 *   · 事件一律 pointerenter / pointerleave（不用 mousemove）：进出一行各一次，不做逐点命中测试。
 *   · 几何只算一次：进入一行时量「该行 + 导航条」各一个 rect；预览浮层**宽度定死 340**，
 *     高度先按 estimatePreviewHeight() 估、再由 useLayoutEffect 在**绘制之前**同步量正 ——
 *     首帧即终位，不会「先小后大」跳一下。
 *   · **展开只动刻度线自己的 width**（从 var(--ai-w) / var(--user-w) 变到本侧上限，+2px 那一档用 calc 写在
 *     class 里）：外层一格布局都不动，所以悬停不引起任何重排；淡化只写 opacity。
 *   · 状态本身只是给行**翻一个 data 属性**（data-hot / data-dim），视觉全部交给 CSS
 *     （长度、颜色、淡化的过渡都写在 class 里），JS 一行样式都不写。
 *   · 尾部渐隐**条件挂载**：某一段真的超出行数上限（scrollHeight > clientHeight）才挂（82% → 100%），
 *     不超限的那一段 style 里连 mask 字段都没有 —— 短文本的下沿不会被切掉。
 *
 * 刻度长度：**轮结束时全量重算，流式期间按 400ms 做廉价增量**（这一版修掉「生成时导航条不动」）
 *   · 结构签名在流式期间只有一个会话 id：不含条数、不含任何随 token 变化的东西 ——
 *     正文一个 token 一个 token 地长，这条导航条一次都不重渲染。
 *   · 流式期间的增量走一个 **400ms 的心跳**：只读一个廉价指纹（**刻度数量** + 这一轮有没有开始回），
 *     指纹变了才重算整表；这一份只改 DOM 属性 / 数量（data-nav-*、轨道高度、刻度数），
 *     **不量任何 rect、不碰预览摘要**，所以不会强制同步布局、不引起掉帧。
 *   · 轮结束时 streaming 翻回 false（签名变成 done:<轮数>:<历史条数>），这时才回读这一轮的体量、
 *     整表重算一次刻度长度（这一份是权威的）。正在跑的那一轮固定按**基线 10px** 画。
 *   · 追加的点长度一律取基线、带 data-nav-live（主色脉冲）；追加的路上不动高亮 ——
 *     用户正上翻时新点不抢焦点（高亮仍由可见区间说了算，流式期间整条让路，
 *     翻回 false 时 useLayoutEffect([plan]) 与滚动停稳那一次各补一次）。
 *   · 滚动只在 rAF 里合并，并且**只在可见区间变化时**才量 rect（那一步只改高亮）；
 *     刻度不参与滚动期的任何重算。
 *
 * 一键到底（**已经不在这条轨道里**）
 *   · 底部那一格删掉了：按钮改成浮在输入框右上方的小浮标（views/ChatView.tsx 的 ScrollToLatest）。
 *     这条导航条因此就是一条轨道，高度＝轨道高度，下面不再有任何占位（自适应逻辑一个字没动）。
 *   · 落地还是这里导出的两条东西：scrollChatToBottom()（点击 / End 键同效：**强制贴底** ——
 *     只广播 SCROLL_CHAT_BOTTOM_EVENT，由 MessageList 的 useStickToBottom 执行）与
 *     useChatAtBottom()（到没到底 / 上翻期间又来了新消息 —— 按钮按它出现、脉冲）。
 *   · **底部判定不在这条轨道里做**：列表从内部上报（useStickToBottom 的滚动监听），
 *     这里只存、只读一个布尔值，一个 rect 都不量 ——
 *     生成期间按钮因此照常可用（能不能点与「有没有在流式」无关）。
 *
 * 点击目标
 *   · 右线（用户刻度）→ 这一轮的用户消息；左线（AI 刻度）→ 这一轮的 AI 回复；行内空白 → 同上
 *     （这一轮还没有回复就退回用户消息）。跳转统一走 lib/msgScroll 的 scrollToMessage。
 *   · 命中区是**整行 12px 高**（视觉线仍然只有 2px）：细线本身不好点，但看上去还是一根细线。
 *
 * 当前项高亮
 *   · 中段 40%（IntersectionObserver rootMargin 上下各收 30%）里再取**跨过中心线**的那一条，
 *     所以任何时刻只有一条是亮的。
 *   · 高亮同样是**命令式**的，但只写一笔：给该行翻一个 data-active 属性（该行两条线各长 2px、
 *     色提到 --ink-2，全在 CSS）；位置指示条只改 transform 与 opacity —— 不重挂 React 树，也不读 rect。
 *
 * 性能
 *   · 所有重算都节流到 rAF（滚动 / 窗口尺寸 / DOM 变化各一路），并且**有变化才调度**：
 *     滚动一帧只读一次位置、预览没挂着就不写状态；DOM 变化只在「换根 / 新条目长在根外面」时才排帧，
 *     其余时候只把新增的条目挂给 IO（流式期间整表不重扫）。量完不再排下一帧，没有任何自续的帧循环。
 *   · 只在可见区间变化时（或滚动停稳那一次）才量 rect。
 *   · 流式输出期间刻度列只在 400ms 心跳的指纹真的变了时才重建一次（且只重建增量），
 *     整条导航条用 memo 包住，父组件每个 token 的重渲染不会传导进来。
 *   · 切页过渡期间（html[data-nav-busy]）一次都不量：那一拍的主线程留给过渡。
 *   · 缓动统一取 token（--ease-spring）。
 *
 * 其它交互
 *   · 点击后 / 滚动期间 200ms 内不跟随改高亮（FOLLOW_LOCK_MS）。
 *   · Ctrl+↑ / Ctrl+↓ 上一个 / 下一个刻度，Esc 关预览。
 *   · 窄窗口（< 820px）整条隐藏。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { MousePointerClick } from 'lucide-react'
import { type ChatItem } from '../../lib/chat'
import { cn } from '../../lib/cn'
import { fmtTime } from '../../lib/format'
import { motionOn } from '../../lib/motionPref'
import { scrollToMessage } from '../../lib/msgScroll'
import { SCROLL_CHAT_BOTTOM_EVENT } from '../../lib/notify'
import { useSession } from '../../stores/session'
import { useUi } from '../../stores/ui'
import { useViewportWidth } from '../shell/dockShared'

/* ── 常量 ── */
/** 刻度总数上限（一轮一个刻度）。超过就聚合成「一个刻度代表 N 轮」。 */
export const NAV_MAX_POINTS = 60
/** 低于这个窗口宽度整条隐藏。 */
const NAV_MIN_VIEWPORT = 820
/** 轨道本体宽：6px 指示留白 + 22px 左侧刻度车道 + 2px 缝 + 10px 右侧刻度车道。
    一整条 40px 的透明轨道（无底色、无边框）—— 刻度线自己就是全部内容，没有卡片感。 */
const NAV_W = 40
/** 左缘给位置指示条留的宽（指示条不压在左侧的刻度线上）。 */
const NAV_GUTTER = 6
/** 刻度线只有一种形状：**2px 高**、1px 圆角（高 2px 时 rounded-full 就是 1px 半径）。 */
const TICK_H = 2
/** 刻度的命中高度：视觉线只有 2px，但整行 **12px** 都好点；行距不足 12px 时退到行距，绝不串到邻行。 */
const TICK_HIT = 12
/** 左侧（AI 回复）刻度：最短 / 基线 / 最长（px）。长度丈量的是这一轮的体量。 */
const AI_MIN = 4
const AI_BASE = 10
const AI_MAX = 22
/** 右侧（用户消息）刻度：最短 / 最长（px）。长度丈量的是这条消息的字数。 */
const USER_MIN = 4
const USER_MAX = 10
/** 有工具调用的轮：线的**末段**换成更淡的一段（opacity .5），这一段的宽度区间（px）。 */
const TAIL_MIN = 2
const TAIL_MAX = 5
/** 出错的轮：线的**最右端**那个红点的边长（px）。 */
const ERROR_DOT = 2
/** 刻度线共用的那一串 class（形状 + 颜色过渡）：两条车道只在这里统一，长度与颜色各写在行上。 */
const TICK_SHAPE = 'h-[2px] shrink-0 rounded-full transition-[background-color,opacity] duration-[var(--motion-fast)] ease-[var(--ease-spring)]'
/** 体量 → 长度的三个定标点（字符量）。中间那个是「一般的一轮」，落在基线上。 */
const VOL_LO = 80
const VOL_MID = 900
const VOL_HI = 40000
/** 一次工具调用折算成多少字符的体量（工具结果动辄上万字符，按固定权重折更稳）。 */
const TOOL_WEIGHT = 400
/** 导航条与内容列左缘之间的空隙。 */
const NAV_AWAY = 6
/** 轨道高度下限 / 上限（上限再与 70vh 取小）。 */
const NAV_MIN_H = 48
const NAV_MAX_H = 520
const NAV_VH = 0.7
/** 滚动档（放不下时）轨道内上下各留的空白。 */
const NAV_PAD = 4
/** 行间空隙档：超限时按 10 → 8 → 6 → 5 → 4 依次压（行距 ＝ 2px 的线 + 空隙，最小 6px）。 */
const SPACINGS = [10, 8, 6, 5, 4]
/** 最小行距（＝最后一档）：聚合预算的分母与自滚档的行距都用它。 */
const MIN_PITCH = TICK_H + SPACINGS[SPACINGS.length - 1]
/** 悬停多久展开并弹出预览：**0 ＝ 悬停即弹**。
    这一档原本是 120ms 的「防误触」防抖，观感却是「放上去卡一下才出来」（用户反馈的「不实时」）。
    导航条是一列 12px 高的细线、误触成本极低，不值得拿延迟换稳定。
    移出方向的 HOVER_OUT_MS 保留：划过一行、光标从线缝里扫出去都不该被当成「选中」。 */
const HOVER_IN_MS = 0
/** 移开多久收回（展开与预览共用同一个时长）。 */
const HOVER_OUT_MS = 140
/** 跳转后 / 滚动期间，多少毫秒内不跟随改高亮。 */
const FOLLOW_LOCK_MS = 200
/** 预览摘要的字符上限（两段共用一份口径）。 */
const PREVIEW_CHARS = 240
/** 预览浮层：**宽度定死 340**（给长问题多留 40px 的排版空间）。
    高度不写死 —— 首次摆放用 estimatePreviewHeight() 估一个（高度只影响它上下夹取的位置），
    真实高度由 useLayoutEffect 在浏览器**绘制之前**同步量正，见 previewBoxRef 那一段。 */
const PREVIEW_W = 340
const PREVIEW_GAP = 10
/** 两段各自的行数上限：**只有真的超出上限才挂尾部渐隐**（判定见 previewOverflow）。
    用户问题（大号）压 3 行，AI 摘要（正文号）给 5 行 —— 卡片再高就该点进去看了。 */
const PREVIEW_USER_LINES = 3
const PREVIEW_AI_LINES = 5
/** 两段的行高倍数：与下面两个 <p> 的 leading-[1.54] / leading-[1.55] 是同一份数，
    行数上限换算成 maxHeight 就靠它（em 是相对各自字号，所以两段可以各写各的）。 */
const PREVIEW_USER_LH = 1.54
const PREVIEW_AI_LH = 1.55
/** 尾部渐隐：**条件挂载**，而且渐变从 82% 才开始（旧版无条件挂、62% 就开始淡，
    短文本的下沿也被抹掉一行 —— 用户说的「AI 回复虚化」主因就在这里）。 */
const PREVIEW_FADE = 'linear-gradient(to bottom, rgba(0,0,0,1) 82%, rgba(0,0,0,0) 100%)'
/** 流式期间增量心跳的间隔（毫秒）：只重算「刻度数量 + 高度比例」这一个廉价指纹。 */
const STREAM_TICK_MS = 400
/** 可见判定用的中段：上下各收 30% ＝中间 40%。 */
const BAND_MARGIN = '-30% 0px -30% 0px'
/** 位置指示条：宽 2px，高度按行距夹（最小 4px，最大 ＝ 命中高度 12px）。 */
const MARKER_W = 2
const MARKER_MIN_H = 4

/* ── 数据结构 ── */
/** 一轮：从一条用户消息开始，到下一轮开始之前（含提示条）。 */
interface Turn {
  from: number
  to: number
}

/** 一个刻度行：一轮（或聚合后的连续若干轮）＝ 两条刻度线（左＝AI 回复 / 右＝用户消息）。 */
interface NavPoint {
  key: string
  /** **右线**（用户消息）的跳转目标：这一段的第一条条目。 */
  itemIndex: number
  /** **左线**（AI 回复）的跳转目标：这一轮的第一条助手消息，-1 = 还没有回复。 */
  aiIndex: number
  /** 段内首条（右侧刻度的长度与 aria-label 用它；预览两段由 pickPreview 在 from..to 里自己挑）。 */
  head: ChatItem
  /** 这一轮的**第一条**助手消息（没有回复时为 undefined）：左线画不画、跳哪一条都由它定。 */
  aiHead?: ChatItem
  /** 这一段覆盖的条目下标闭区间（可见区间 → 刻度 的映射靠它）。 */
  from: number
  to: number
  /** 段内轮次范围（1-based，闭区间）。 */
  turnFrom: number
  turnTo: number
  /** **左线**（AI 回合）的长度（px）：**只在轮结束时算**，映射见 aiLength。 */
  bar: number
  /** **右线**（用户消息）的长度（px）：按这条消息的字数映射，见 userLength。 */
  user: number
  /** 工具调用占这一轮体量的比例 0..1（0 ＝ 没有工具调用，末段不换淡色）。 */
  tool: number
  /** 末段那段更淡的延长段的宽度（px，含在 bar 里）：0 ＝ 这一轮没有工具调用。 */
  tail: number
  /** 这一轮里有错误（工具失败 / 错误提示条）：线的右端加红点。 */
  error: boolean
  /** 还在生成中（刻度按基线画、主色脉冲、行上标 data-nav-live）：
      只有「正在跑的那一轮」与生成中增量追加出来的点会是 true。 */
  live: boolean
}

/** 刻度列 + 排布参数：高度、行距、刻度厚度全在这里定死，渲染与命令式更新共用同一份数。 */
interface NavPlan {
  points: NavPoint[]
  pointOfIndex: number[]
  /** 刻度厚度 ＝ TICK_H（2px）。data-nav-dot 读它。 */
  dot: number
  /** 行距 = 刻度厚度 + 空隙（6 ~ 12px）。高度 = 刻度数 × 行距。 */
  pitch: number
  /** 这一档选中的空隙（10 / 8 / 6 / 5 / 4）：增量追加按它与刻度厚度重算高度与行距，
      与 fitPlan 共用同一套算式（自滚档固定给最小那一档）。 */
  gap: number
  /** 轨道高度（下限 48，上限 min(70vh,520)，或放不下时的上限 + 自滚）。 */
  height: number
  padTop: number
  padBottom: number
  /** 放不下＝轨道自己滚。 */
  scroll: boolean
  /** 这一档用的聚合预算（60 / 按窗口高度算出来的那一档）。 */
  threshold: number
}

/** 预览里的一段：问与答各占一段，段内只有「取自哪条 / 讲什么 / 什么时候」。 */
interface PreviewSegment {
  /** 来源条目下标（用户段＝这一轮的 user 条目；AI 段＝这一轮最后一条 assistant 条目）。 */
  index: number
  text: string
  at?: number
}

/** 预览要讲的两段：上＝用户问题（大号），下＝AI 回复摘要。
    某一段取不到就是 undefined —— 那一段**不渲染、不留空行**（见 pickPreview）。 */
interface PreviewPick {
  user?: PreviewSegment
  ai?: PreviewSegment
}

interface PreviewState extends PreviewPick {
  /** 归属的行下标：同一行内换半边时几何一次都不重量。 */
  point: number
  /** 悬停的是哪半边：上段（用户）还是下段（AI）被高亮。
      两段的内容不再跟着半边切换，半边只剩这一个作用 —— 悬停哪一侧的信息因此不丢。 */
  focus: 'user' | 'ai'
  left: number
  top: number
  /** 真实高度量过并摆正了吗（量之前先以 opacity 0 挂着，摆正后才淡入）。 */
  ready: boolean
  /** 在场 / 收回中：收回走 opacity 淡出，140ms 后才卸载。 */
  open: boolean
}

/** 正在悬停的那一行 + 悬停的是哪一半（左线＝AI 回复 / 右线＝用户消息）。 */
interface Hot {
  row: number
  part: 'user' | 'ai'
}

/* ── 纯函数 ── */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 摘要：折叠空白再截断（预览浮层与 aria-label 共用一份口径）。 */
function summarize(text: string, limit = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

/** 预览卡上的角色徽标：与两列一一对应。 */
function pickLabel(role: 'user' | 'ai'): string {
  return role === 'user' ? '你' : 'AI'
}

function timeOf(item: ChatItem): number | undefined {
  return item.kind === 'user' || item.kind === 'assistant' ? item.at : undefined
}

/** 条目正文：提问卡没有 text，取它的问题正文（导航预览与刻度标签共用同一条口径）。 */
function itemText(item: ChatItem | undefined): string {
  if (!item) return ''
  return item.kind === 'ask' ? item.prompt : item.text
}

function turnRangeLabel(from: number, to: number): string {
  return from === to ? '第 ' + from + ' 轮' : '第 ' + from + '-' + to + ' 轮'
}

/** 条目序列 → 轮。第一条消息之前的提示条自成一段（没有用户消息可挂）。 */
function buildTurns(items: ChatItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  items.forEach((item, index) => {
    if (item.kind === 'user' || !current) {
      current = { from: index, to: index }
      turns.push(current)
      return
    }
    current.to = index
  })
  return turns
}

/** 这一段的体量：正文长度 + 工具调用按固定权重折算；顺带看一遍有没有错误。
    刻度长度与工具末段的宽度都由它算出来 —— 只有「轮结束了」才会被调到（见 makePoint 的 frozen）。 */
function turnShape(items: ChatItem[], from: number, to: number): { vol: number; tool: number; error: boolean } {
  let text = 0
  let toolVol = 0
  let error = false
  for (let index = from; index <= to; index += 1) {
    const item = items[index]
    if (!item) continue
    if (item.kind === 'user') {
      text += item.text.length
      continue
    }
    if (item.kind === 'assistant') {
      text += item.text.length
      for (const call of item.tools) {
        if (call.status === 'error' || call.status === 'denied') error = true
        toolVol += TOOL_WEIGHT
      }
      continue
    }
    // 提问卡与引擎注入的提醒都不计入回合体量（既不是正文也不是错误）：
    // 刻度该讲「这轮说了多少」。
    if (item.kind === 'ask' || item.kind === 'reminder') continue
    if (item.tone === 'error') error = true
  }
  const vol = text + toolVol
  return { vol, tool: vol > 0 ? clamp(toolVol / vol, 0, 1) : 0, error }
}

/** 体量 → **左线**（AI 回合）的长度：**对数映射**，三点定标（≤80 字符 4px、900 字符 10px、
    ≥40000 字符 22px）。对数是为了让「一千字」和「一万字」在一根 22px 的线上仍然分得开。 */
function aiLength(vol: number): number {
  if (vol <= VOL_LO) return AI_MIN
  if (vol >= VOL_HI) return AI_MAX
  const span = Math.log(VOL_HI / VOL_LO)
  const at = Math.log(vol / VOL_LO) / span
  const mid = Math.log(VOL_MID / VOL_LO) / span
  const px = at <= mid
    ? AI_MIN + (AI_BASE - AI_MIN) * (at / mid)
    : AI_BASE + (AI_MAX - AI_BASE) * ((at - mid) / (1 - mid))
  return Math.round(px)
}

/** 字数 → **右线**（用户消息）的长度：同一套对数口径，压进 4 ~ 10px。
    右列要的是「一问一答分列两端」的秩序感（不是体量对比），所以两端直接定标、不设基线。 */
function userLength(chars: number): number {
  if (chars <= VOL_LO) return USER_MIN
  if (chars >= VOL_HI) return USER_MAX
  const at = Math.log(chars / VOL_LO) / Math.log(VOL_HI / VOL_LO)
  return Math.round(USER_MIN + (USER_MAX - USER_MIN) * at)
}

/** 有工具调用的轮：末段换色那一段的宽度 2 ~ 5px。
    **它含在映射长度里**（末段换淡色，而不是另接一截长出去）—— 两条车道因此永远留得住中间那道缝，
    长度口径也仍然只是「4 / 10 / 22」这三个数。左线至少要留 1px 给主段。 */
function tailLength(bar: number, tool: number): number {
  if (tool <= 0) return 0
  return clamp(Math.round(bar * tool), TAIL_MIN, Math.min(TAIL_MAX, bar - 2))
}

/** 一段轮次 → 一个刻度行。frozen ＝ 这一段还没跑完（体量不算，左线按基线画）。 */
function makePoint(items: ChatItem[], turn: Turn, turnFrom: number, turnTo: number, frozen: boolean): NavPoint {
  const from = clamp(turn.from, 0, items.length - 1)
  const to = clamp(turn.to, from, items.length - 1)
  // 左车道（AI 回复）的目标：这一段里第一条助手消息。还没有回复就是 -1，这条线不画。
  let aiIndex = -1
  for (let at = from; at <= to; at += 1) {
    if (items[at] && items[at].kind === 'assistant') { aiIndex = at; break }
  }
  const shape = frozen ? null : turnShape(items, from, to)
  const head = items[from]
  const bar = shape ? aiLength(shape.vol) : AI_BASE
  const tool = shape ? shape.tool : 0
  return {
    key: 'p' + from + '-' + to,
    itemIndex: from,
    aiIndex,
    aiHead: aiIndex >= 0 ? items[aiIndex] : undefined,
    head,
    from,
    to,
    turnFrom,
    turnTo,
    bar,
    // 右线只看这条用户消息的字数（聚合段就取段内那条首条用户消息）：轮结束时与左线一起定，之后不再变。
    user: userLength(head && head.kind === 'user' ? head.text.length : 0),
    tool,
    tail: tailLength(bar, tool),
    error: shape ? shape.error : false,
    // 「还在跑」这件事只有这一个来源：整表重算时是最后那一轮（frozen），增量追加时是追加出来的那几点。
    live: frozen,
  }
}

/** 条目 → 刻度。返回的 pointOfIndex 把每个条目下标映射到它所属的刻度（可见区间靠它定高亮）。
    budget 就是「最多几行」：60 是常规档，按窗口高度算出来的那一档是压缩后的第二档。
    frozenLast ＝ 最后一轮还在跑：它的左线固定按基线画，半截正文绝不参与算长度。 */
function buildPoints(items: ChatItem[], budget: number, frozenLast: boolean): {
  points: NavPoint[]
  pointOfIndex: number[]
} {
  const turns = buildTurns(items)
  const pointOfIndex = new Array<number>(Math.max(0, items.length)).fill(-1)
  const points: NavPoint[] = []
  if (!turns.length) return { points, pointOfIndex }

  if (turns.length <= budget) {
    turns.forEach((turn, index) => {
      const frozen = frozenLast && index === turns.length - 1
      points.push(makePoint(items, turn, index + 1, index + 1, frozen))
    })
  } else {
    // 聚合：一段代表连续若干轮，范围与首条摘要由预览浮层交代。
    const bucket = Math.ceil(turns.length / budget)
    for (let start = 0; start < turns.length; start += bucket) {
      const group = turns.slice(start, start + bucket)
      const turn: Turn = { from: group[0].from, to: group[group.length - 1].to }
      const frozen = frozenLast && start + bucket >= turns.length
      points.push(makePoint(items, turn, start + 1, start + group.length, frozen))
    }
  }

  points.forEach((point, index) => {
    for (let at = point.from; at <= point.to; at += 1) {
      if (at >= 0 && at < pointOfIndex.length && pointOfIndex[at] < 0) pointOfIndex[at] = index
    }
  })
  return { points, pointOfIndex }
}

/** 一份刻度列 + 一条空隙档 → 排布参数。放不下（超过上限）返回 null，交给下一档。 */
function fitPlan(
  built: { points: NavPoint[]; pointOfIndex: number[] },
  threshold: number,
  cap: number,
): NavPlan | null {
  const count = built.points.length
  if (!count) return null
  for (const gap of SPACINGS) {
    if (count * (TICK_H + gap) > cap) continue
    // 行距 = 高度 / 刻度数：恒等式「高度 = 刻度数 × 行距」在任何一档都成立。
    const height = Math.max(NAV_MIN_H, count * (TICK_H + gap))
    return { ...built, dot: TICK_H, pitch: height / count, gap, height, padTop: 0, padBottom: 0, scroll: false, threshold }
  }
  return null
}

/** 压缩档的聚合预算：窗口这面轨道**按最紧的那档行距最多放得下几行**。 */
function tightBudget(cap: number): number {
  return clamp(Math.floor(cap / MIN_PITCH), 4, NAV_MAX_POINTS)
}

/** 刻度列 + 窗口能给的轨道上限 → 最终排布。顺序：压行距 → 降聚合预算 → 才滚动。 */
function planNav(items: ChatItem[], cap: number, live: boolean): NavPlan {
  const full = buildPoints(items, NAV_MAX_POINTS, live)
  const fit = fitPlan(full, NAV_MAX_POINTS, cap)
  if (fit) return fit

  // 第二档：聚合到「这面轨道放得下多少行就是多少行」。用之前先看一眼「瘦下来之后还填不填得满」——
  // 聚合掉一大半的轮、轨道却只画到六成，等于白丢信息；那种情况留给最后的滚动档。
  const budget = tightBudget(cap)
  const tight = buildPoints(items, budget, live)
  const tightCount = tight.points.length
  const tightFloor = tightCount * MIN_PITCH
  if (tightFloor >= cap * 0.9) {
    const tightFit = fitPlan(tight, budget, cap)
    if (tightFit) return tightFit
  }

  // 最后才滚动：保留 60 个刻度的细分，用最小的那条行距铺到上限，多出来的部分轨道自己滚。
  const count = full.points.length
  return {
    ...full,
    dot: TICK_H,
    pitch: MIN_PITCH,
    gap: MIN_PITCH - TICK_H,
    height: cap,
    padTop: NAV_PAD,
    padBottom: NAV_PAD,
    scroll: count * MIN_PITCH + NAV_PAD * 2 > cap,
    threshold: NAV_MAX_POINTS,
  }
}

/** 结构签名：会话 +（**流式期间一个数都不带**）。
    流式期间正文一个 token 一个 token 地长、工具段一条一条地加，消息条数每秒能跳好几次；
    把它写进签名等于流式期间反复重算整表（每次都要 buildPoints + 重渲染整列刻度）。
    所以流式期间这里只认会话 id：**刻度数量与高度比例的增量由 400ms 的心跳补**
    （见 liveShapeSignature 与组件里的那个 useEffect），轮结束才回读体量做权威的整表重算。
    轮结束时 streaming 翻回 false，签名变成 done:<轮数>:<消息条数>，这时全量补齐一次。
    循环跑在 s.messages 上（条目级），代价可以忽略。 */
function structureSignature(state: {
  sessionId: string
  messages: ChatItem[]
  streaming: boolean
}): string {
  if (state.streaming) return state.sessionId + '|live'
  let turns = 0
  for (const item of state.messages) if (item.kind === 'user' && !item.queued) turns += 1
  return state.sessionId + '|done:' + turns + ':' + state.messages.length
}

/** 流式期间的**廉价指纹**：只看两件事 ——
    ① 刻度数量（＝轮数，与 buildTurns 同一口径：第一条消息之前的提示条自成一段）；
    ② 最后那一轮里有没有出现助手条目（左线要不要画出来）。
    为什么只看得下这两样：流式期间刻度长度一律按基线画（体量不算），轨道的**高度比例**
    只由刻度数量决定（height = 数量 × 行距），预览摘要不在这里碰 —— 所以指纹相同就真的无事可做，
    一个 state 都不用写、一个 rect 都不用量。 */
function liveShapeSignature(messages: ChatItem[]): string {
  let turns = 0
  let open = false
  let lastTurnStart = 0
  messages.forEach((item, index) => {
    if (item.kind === 'user' || !open) { turns += 1; open = true; lastTurnStart = index }
  })
  let answered = false
  for (let at = lastTurnStart; at < messages.length; at += 1) {
    if (messages[at] && messages[at].kind === 'assistant') { answered = true; break }
  }
  return turns + ':' + (answered ? '1' : '0')
}

/** 可见区间（刻度下标集合的升序串）：集合没变就不重量 —— 高亮的「只在区间变化时重算」。 */
function bandSignature(band: Set<number>): string {
  if (!band.size) return ''
  return [...band].sort((a, b) => a - b).join(',')
}

/** 消息滚动容器：MessageList 不给 ref，这里按 DOM 关系找——从任意一条消息往上走，
    第一个 overflow-y 是 auto/scroll 的祖先就是它（普通列表与 Virtuoso 共用同一个元素）。 */
function findScroller(host: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = host.querySelector<HTMLElement>('[data-msg-index]')
  while (node && node !== document.body) {
    const overflowY = window.getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return null
}

/** 瞬时定位（不带动画）：把目标条目摆到容器中间。动效关闭时的跳转路径用它。 */
function instantScrollTo(scroller: HTMLElement | null, index: number): void {
  const target = scroller?.querySelector<HTMLElement>('[data-msg-index="' + index + '"]')
  if (!scroller || !target) return
  const box = scroller.getBoundingClientRect()
  const rect = target.getBoundingClientRect()
  const next = scroller.scrollTop + (rect.top - box.top) - (scroller.clientHeight - rect.height) / 2
  scroller.scrollTop = Math.max(0, next)
}

/** 跳转用的标识：优先引擎的消息 id——lib/msgScroll 的实现按它定位（虚拟列表里目标还没挂载时
    由列表自己去 scrollToIndex）。还没落库的乐观用户消息只有本地条目 id，也一并交出去。 */
function messageKeyOf(item: ChatItem | undefined): string {
  if (!item) return ''
  if ((item.kind === 'user' || item.kind === 'assistant') && item.msgId) return item.msgId
  return item.id
}

/** 兜底定位：按条目下标把元素摆进视口中间（scrollToMessage 没接住时用）。 */
function revealByIndex(scroller: HTMLElement | null, index: number, smooth: boolean): void {
  const target = scroller?.querySelector<HTMLElement>('[data-msg-index="' + index + '"]')
  if (!target) return
  target.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
}

/** 轨道上限：min(70vh, 520)，再夹进消息区（别顶到工具栏和输入框上）。
    夹的这一刀按中线偏移算：轨道中心对齐窗口中线后最多下移 nudge 像素，所以
    「下沿不出消息区」等价于 height ≤ 消息区高度 − 2 × nudge。窗口够高时这一刀不生效，
    上限就是 min(70vh, 520)。 */
function navCap(host: HTMLElement | null, nudge: number): number {
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight || 800
  const max = Math.min(vh * NAV_VH, NAV_MAX_H)
  const box = host && host.isConnected ? host.clientHeight : 0
  if (box <= 0) return Math.max(NAV_MIN_H, max)
  return Math.max(NAV_MIN_H, Math.min(max, box - 2 * Math.abs(nudge) - 8))
}

/** 位置指示条的高度：跟着行距走（上限 ＝ 12px 的命中高度；行距小时上下各留 1px，不压到邻行）。 */
function markerHeight(plan: NavPlan): number {
  return Math.max(MARKER_MIN_H, Math.min(TICK_HIT, Math.round(plan.pitch) - 2))
}

/** 预览浮层摆位：导航条在内容列左边，所以预览一律**翻到右侧**（贴着导航条右缘起算）。
    上下按可视区夹取。**一次悬停只调它一次**：这里量的是「该行」与「导航条」各一个 rect。
    height 是**调用方估出来的**高度（estimatePreviewHeight）：宽度定死，所以高度只影响上下夹取，
    估偏了也不会看到跳动 —— 渲染后的 useLayoutEffect 会在绘制之前按真实高度再摆正一次。 */
function placePreview(
  anchor: HTMLElement,
  nav: HTMLElement,
  box: { width: number; height: number },
  height: number,
): { left: number; top: number } {
  const navRect = nav.getBoundingClientRect()
  const rect = anchor.getBoundingClientRect()
  const maxLeft = Math.max(4, box.width - PREVIEW_W - 8)
  const left = clamp(navRect.right - navRect.left + PREVIEW_GAP, 4, maxLeft)
  const top = clamp(
    rect.top - navRect.top + rect.height / 2 - height / 2,
    4,
    Math.max(4, box.height - height - 4),
  )
  return { left, top }
}

/** **流式冻结开关**：正文还在一个 token 一个 token 地长的时候，两件重活让路 ——
    ① 高亮要量 rect（每次可见区间变一次，流式期间区间还在被新内容推着走）；
    ② 预览摘要取自还在变的条目（取到的只是半截）。
    但**刻度不再跟着一起冻**：刻度数量与高度比例由 400ms 的心跳做廉价增量
    （见 liveShapeSignature + 组件里那段 useEffect），所以这一版不会出现「生成时导航条不动」。
    轮结束那一帧会自动补齐：streaming 翻回 false 使结构签名与 plan 一起换新，
    useLayoutEffect([plan]) 与滚动停稳那一次重算各补一次，高亮 / 刻度不会停在旧位置上。
    做法与 navBusy 完全一致：判据只此一处，读 store 的权威值（不订阅 —— 订阅会跟着每个 chunk 重渲染）。 */
function navFrozen(): boolean {
  return useSession.getState().streaming === true
}

/** 交给过渡的那一拍别来量（App 在切页时写 html[data-nav-busy]）：主线程要留给过渡本身。
    **这个窗口现在偏保守**：App 侧 markNavPause() 开的是固定 320ms（PANE_ENTER_MS + 80ms 余量，
    见 shell/navPause.tsx），而真正需要让路的只有「进场动画 + 正文挂载」那一拍。
    App 什么时候把它收窄到实测时长，这里不用改一个字就自动受益 —— 所以此处**不改逻辑**，
    只留这条注释，免得后来的人以为 320 是这条导航条自己选的数。 */
function navBusy(): boolean {
  return document.documentElement.dataset.navBusy === '1'
}

/** 悬停的是哪一半：右线（用户消息）还是左线 / 行空白（AI 回复）。
    按 target 往上找那条带 data-nav-dot 的刻度线 —— 线里的小段（淡色延长段 / 红点）也得算在线上。 */
function hoverPart(target: EventTarget | null): 'user' | 'ai' {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-nav-dot]') : null
  return el && el.dataset.navDot === 'user' ? 'user' : 'ai'
}

/** 悬停哪一行 → 预览内容（**两段一次取齐**）。
    不再按「悬停的是哪半边」切内容：半边只决定高亮哪一段（PreviewState.focus），
    问与答始终成对出现 —— 用户想知道的就是「这一轮我问了什么、它答了什么」。
    用户段取这一轮第一条 user 条目；AI 段取这一轮**最后一条** assistant 条目
    （一轮里可能有好几条助手条目，最后那条才是结论）。取不到的那一段就是 undefined。 */
function pickPreview(point: NavPoint, items: ChatItem[]): PreviewPick {
  const from = clamp(point.from, 0, items.length - 1)
  const to = clamp(point.to, from, items.length - 1)
  let user: PreviewSegment | undefined
  let ai: PreviewSegment | undefined
  for (let at = from; at <= to; at += 1) {
    const item = items[at]
    if (!item) continue
    if (item.kind === 'user') {
      if (!user) user = { index: at, text: itemText(item), at: timeOf(item) }
      continue
    }
    // 助手条目一路覆盖：循环走完留下的就是最后那一条。
    if (item.kind === 'assistant') ai = { index: at, text: itemText(item), at: timeOf(item) }
  }
  return { user, ai }
}

/** 首次摆放用的高度估值（px）：宽度定死 340 之后，行数只由字数决定。
    口径故意偏保守（按汉字宽度算行），估高一点只会让卡片先靠上放，随后的同步量测会摆正。
    真实高度由 useLayoutEffect 在绘制之前量，所以这里估偏一两行也看不出来。 */
function estimatePreviewHeight(userText: string, aiText: string): number {
  const inner = PREVIEW_W - 28
  const userLines = userText ? clamp(Math.ceil(userText.length / Math.max(6, Math.floor(inner / 13))), 1, PREVIEW_USER_LINES) : 0
  const aiLines = aiText ? clamp(Math.ceil(aiText.length / Math.max(6, Math.floor(inner / 12))), 1, PREVIEW_AI_LINES) : 0
  // 固定开销：卡片上下 padding + 两段表头 + 分割线 + 底部「点击跳转」那一行。
  const chrome = 24 + 14 + (aiText ? 14 + 9 : 0) + 18
  return Math.round(chrome + userLines * 13 * PREVIEW_USER_LH + aiLines * 12 * PREVIEW_AI_LH)
}

/** 超限时才挂的尾部渐隐：不超限返回空对象 —— 短文本一个像素都不淡。 */
function fadeStyle(on: boolean): CSSProperties {
  return on ? { maskImage: PREVIEW_FADE, WebkitMaskImage: PREVIEW_FADE } : {}
}

/* ── 一键到底 ──
   输入框右上方那个「最新」浮标（views/ChatView.tsx 的 ScrollToLatest）与 End 键共用这一条路径：
   滚动只有一个入口：useStickToBottom（见 MessageList）。 */
/** 一键到底（输入框右上方的「最新」浮标 / End 键）：**强制贴底**。
    滚动只有一个入口：这里只广播 SCROLL_CHAT_BOTTOM_EVENT，由 MessageList 的 useStickToBottom
    监听并执行 scrollToBottom()（先恢复吸底再贴）。本文件不再直接写任何 scrollTop。 */
function handToStickyBottom(): void {
  try { window.dispatchEvent(new CustomEvent(SCROLL_CHAT_BOTTOM_EVENT)) } catch { /* 忽略 */ }
}

/** 一键到底（输入框右上方的「最新」浮标 / End 键）：**强制贴底** —— 广播给 useStickToBottom，
    它负责解除冻结、恢复吸底、贴底。生成期间照常可用。 */
export function scrollChatToBottom(): void {
  handToStickyBottom()
}

/* ── 「到底了没有」的对外读数 ──
   按钮（浮在输入框右上角的 ScrollToLatest）属于对话页，不属于这条随时会整条隐藏的导航条，
   而**判定属于列表**：只有它知道自己是不是贴在底部（普通列表与虚拟列表量的根本不是同一件事）。

   所以这里只是一个「存 + 读」的小仓库，一次 rect 都不量、一个滚动监听都不挂：
     · 写入：MessageList 从**内部**上报 —— 虚拟化走 Virtuoso 的 atBottomStateChange，
       非虚拟化走它自己的滚动事件（见 reportChatAtBottom）；
     · 读出：按钮只读这一个布尔值。生成期间照常可用 —— 能不能点与「有没有在流式」无关。

   写入端只在**翻转**时通知（同一个值重复上报是零成本的空操作），所以滚动不会把调用方带着重渲染。 */
let chatAtBottom = true
const chatAtBottomListeners = new Set<() => void>()

/** 列表上报「我是不是在底部」（翻转才通知）。 */
export function reportChatAtBottom(next: boolean): void {
  if (next === chatAtBottom) return
  chatAtBottom = next
  for (const listener of chatAtBottomListeners) listener()
}

function subscribeChatAtBottom(listener: () => void): () => void {
  chatAtBottomListeners.add(listener)
  return () => { chatAtBottomListeners.delete(listener) }
}

function chatAtBottomSnapshot(): boolean {
  return chatAtBottom
}

/** 按钮的读数：atBottom 来自列表的上报；pulse 是「上翻期间又来了新消息」的序号 ——
    每来一条自增一次，按钮按它轻轻脉冲一次。 */
export function useChatAtBottom(): { atBottom: boolean; pulse: number } {
  const sessionId = useSession((s) => s.sessionId)
  const messageLen = useSession((s) => s.messages.length)
  const atBottom = useSyncExternalStore(subscribeChatAtBottom, chatAtBottomSnapshot, chatAtBottomSnapshot)
  const [pulse, setPulse] = useState(0)
  const lastLenRef = useRef(messageLen)
  const lastSessionRef = useRef(sessionId)

  /** 新消息信号：上翻着的时候消息条数长了，就脉冲一次（回到最底部时自然不再脉冲）。
      换会话时只对齐本地进度 —— 那一边的读数由列表复位（它同时会把 stick 复位并上报）。 */
  useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      lastSessionRef.current = sessionId
      lastLenRef.current = messageLen
      return
    }
    const previous = lastLenRef.current
    lastLenRef.current = messageLen
    if (messageLen > previous && !chatAtBottom) setPulse((count) => count + 1)
  }, [sessionId, messageLen])

  return { atBottom, pulse }
}

export const MessageNav = memo(function MessageNav() {
  const view = useUi((s) => s.view)
  const viewport = useViewportWidth()
  /** 结构签名订阅（选择器返回字符串）：非流式＝会话 + 轮数 + 条数；流式＝只有会话。
      正文一个 token 一个 token 地长时签名一个字符都不变，所以这条导航条不会跟着 token 重渲染；
      流式期间真正必要的两次重算由下面那个 400ms 心跳按廉价指纹给。
      会话 id 必须进签名：两个会话的轮数撞车时，不重建就等于把上一份刻度挂在新会话上。 */
  const signature = useSession((s) => structureSignature(s))
  /** 流式与否：只用来开关那 400ms 的增量心跳。
      **不订阅 messages** —— 每个 token 都改一次的那个数组才是这条导航条重渲染的源头。 */
  const streaming = useSession((s) => s.streaming)
  const visible = view === 'chat' && viewport >= NAV_MIN_VIEWPORT

  /** 轨道能用的上限：先按 70vh/520 估，挂载后再按消息区真实高度夹一次。 */
  const [cap, setCap] = useState(() => navCap(null, 0))
  /** 中线偏移：消息区上下的工具栏与输入区不等高，按消息区居中的话轨道中心会比窗口中心
      高十几像素（实测 14px 上下）。刻度是拿眼睛对位的，对窗口中线更稳，所以在这里补一次差。
      机制仍然是 top:50% + translateY(-50%)，只是基准从「消息区」挪到「窗口」。 */
  const [nudge, setNudge] = useState(0)
  /** **流式增量指纹**：流式期间由下面那 400ms 的心跳写入，非流式恒为 ''（那时整表重算交给 done 签名）。 */
  const [liveShape, setLiveShape] = useState('')

  /* ── 流式期间的**低频增量**（原来这里是「一个 token 都不动」）────────────────────────────
     每 STREAM_TICK_MS 只读一次那个廉价指纹：刻度数量 + 高度比例（＝这一轮之后的轮数）。
     为什么用定时器而不是订阅 messages：订阅会跟着每个 token / 每个工具段重渲染整条导航条，
     而流式期间真正会变的只有「多了一轮没有」「这一轮有没有开始回」这两件事。
     这一拍**只改 DOM 属性与数量**（plan 换新 → data-nav-count / data-nav-pitch / 轨道高度），
     不量任何 rect（高亮仍由 navFrozen 让路），也不碰预览摘要 —— 不会强制同步布局。 ── */
  useEffect(() => {
    if (!streaming) {
      // 流式结束：指纹清空（值本来就是 '' 时 React 直接 bail out，一次都不多渲染）。
      setLiveShape((prev) => (prev === '' ? prev : ''))
      return
    }
    const read = (): void => {
      const next = liveShapeSignature(useSession.getState().messages)
      // 指纹没变就一个 state 都不写：不重渲染、不重排、不重绘。
      setLiveShape((prev) => (prev === next ? prev : next))
    }
    read() // 第一拍立刻读一次：生成刚开始时就得把「这一轮开始回复了」反映出来，不等 400ms。
    const timer = window.setInterval(read, STREAM_TICK_MS)
    return () => window.clearInterval(timer)
  }, [streaming])

  /** **整表重算**的那一份：非流式由签名（会话 / 轮结束 / 条数变化）驱动，
      流式期间签名是常量，改由上面的增量指纹驱动。条目**直接读 messages**（单一事实来源），
      不走订阅 —— 订阅会在每个 token 上重渲染。
      streaming 交给 planNav：还在跑的最后一轮，左线固定按基线画。 */
  const liveDep = streaming ? liveShape : ''
  const { plan, items } = useMemo(() => {
    const state = useSession.getState()
    return { plan: planNav(state.messages, cap, state.streaming), items: state.messages }
  }, [signature, cap, liveDep])

  const [preview, setPreview] = useState<PreviewState | null>(null)
  /** 两段各自「真的超出行数上限了吗」：**只有 true 才挂尾部渐隐**，false 时 style 里一个 mask 字段都没有。 */
  const [previewOverflow, setPreviewOverflow] = useState({ user: false, ai: false })

  const navRef = useRef<HTMLElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const markerRef = useRef<HTMLSpanElement | null>(null)
  const previewBoxRef = useRef<HTMLDivElement | null>(null)
  /** 预览两段的 <p>：尾部渐隐的判定（scrollHeight > clientHeight）落在它们身上。
      用 ref 而不是 state：这两个元素只在这一处被读，读完就把结论写进 previewOverflow。 */
  const previewUserRef = useRef<HTMLParagraphElement | null>(null)
  const previewAiRef = useRef<HTMLParagraphElement | null>(null)
  /** 主内容列（[data-chat-col]）：条目与滚动容器都从它里面找，挂载后就不再变。 */
  const hostRef = useRef<HTMLElement | null>(null)
  /** 消息滚动容器。虚拟列表要等条目渲染出来才找得到，所以它是**懒解析**的（见 attach）。 */
  const scrollerRef = useRef<HTMLElement | null>(null)
  /** 可见区间：IntersectionObserver 报告的条目下标集合。 */
  const visibleRef = useRef<Set<number>>(new Set())
  const bandSigRef = useRef('')
  const itemsRef = useRef<ChatItem[]>(items)
  const planRef = useRef<NavPlan>(plan)
  const capRef = useRef(cap)
  const previewRef = useRef<PreviewState | null>(preview)
  /** 高亮的真值：命令式更新，不进 React 状态（每动一次不重挂整条刻度）。 */
  const activeRef = useRef(-1)
  /** 每一行的行元素与右线（用户刻度）：高亮 / 悬停都直接写它们。 */
  const rowRefs = useRef<(HTMLElement | null)[]>([])
  const userTickRefs = useRef<(HTMLElement | null)[]>([])
  /** 高亮锁：这个时刻之前不跟随滚动改高亮（跳转中 / 用户还在滑）。 */
  const lockUntilRef = useRef(0)
  /** 锁定期内钉住的那一点（点击跳转的目标）。 */
  const forcedRef = useRef(-1)
  const settleTimerRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)
  /** 下一帧要不要强制重算（rAF 合并时 force 不能被并掉，见 schedule）。 */
  const pendingForceRef = useRef(false)
  /** 悬停：进入 / 收回两个定时器 + 已展开 / 候选两行。 */
  const hoverInRef = useRef<number | null>(null)
  const hoverOutRef = useRef<number | null>(null)
  const hotRef = useRef<Hot | null>(null)
  const pendingRef = useRef<Hot | null>(null)
  /** 预览收回的卸载定时器（140ms 淡出后才摘掉）。 */
  const previewExitRef = useRef<number | null>(null)

  itemsRef.current = items
  planRef.current = plan
  capRef.current = cap
  previewRef.current = preview

  /** 高亮的唯一出口：给该行翻一个 data-active（该行长 2px、色提到 --ink-2 全在 CSS 里），
      右线顺手维护 aria-current，位置条只改 transform / opacity。
      整条路径一次 rect 都不读，所以滚动时不会有强制同步布局。 */
  const paint = useCallback((index: number, on: boolean) => {
    const row = rowRefs.current[index]
    if (row) row.setAttribute('data-active', on ? 'true' : 'false')
    const square = userTickRefs.current[index]
    if (square) {
      if (on) square.setAttribute('aria-current', 'true')
      else square.removeAttribute('aria-current')
    }
  }, [])

  /** 位置指示条：只改 transform / opacity，几何全部来自当前这一份 plan（一个 rect 都不读）。
      单独抽出来是因为**增量追加**也要用它：行距跟着长的时候位置条得重摆，
      但「哪一条是当前项」不许因为追加而改变。 */
  const placeMarker = useCallback((index: number) => {
    const marker = markerRef.current
    if (!marker) return
    const current = planRef.current
    const size = markerHeight(current)
    const y = current.padTop + (index < 0 ? 0 : index * current.pitch + current.pitch / 2 - size / 2)
    marker.style.transform = 'translate3d(0,' + y + 'px,0)'
    marker.style.opacity = index >= 0 ? '1' : '0'
  }, [])

  const applyActive = useCallback((index: number) => {
    if (index === activeRef.current) return
    const previous = activeRef.current
    if (previous >= 0) paint(previous, false)
    activeRef.current = index
    if (index >= 0) paint(index, true)
    const nav = navRef.current
    if (nav) nav.setAttribute('data-nav-active', String(index))
    placeMarker(index)
  }, [paint, placeMarker])

  /** 定高亮：可见区间（IO 报的条目下标）∩ 中段中心线 → 唯一一个刻度。
      量 rect 只在这一步做，而且只量区间里那几条；区间没变就直接返回。 */
  const recompute = useCallback((force: boolean) => {
    if (frameRef.current !== null) { window.cancelAnimationFrame(frameRef.current); frameRef.current = null }
    if (navBusy() || navFrozen()) return
    if (performance.now() < lockUntilRef.current) {
      if (forcedRef.current >= 0) applyActive(forcedRef.current)
      return
    }
    forcedRef.current = -1
    const host = hostRef.current
    if (!host) return
    const sig = bandSignature(visibleRef.current)
    if (!force && sig === bandSigRef.current) return
    bandSigRef.current = sig
    const box = scrollerRef.current?.getBoundingClientRect()
    const center = box ? box.top + box.height / 2 : window.innerHeight / 2
    // IO 还没报到（刚换根 / 刚挂载的那一帧）：退回「已渲染的条目」自己量一次，别让高亮空着。
    let candidates: number[] = [...visibleRef.current]
    if (!candidates.length) {
      candidates = [...host.querySelectorAll<HTMLElement>('[data-msg-index]')]
        .map((el) => Number(el.dataset.msgIndex))
        .filter((index) => Number.isFinite(index))
    }
    let spanning = -1
    let nearest = -1
    let nearestGap = Number.POSITIVE_INFINITY
    for (const index of candidates) {
      const el = host.querySelector<HTMLElement>('[data-msg-index="' + index + '"]')
      if (!el) continue
      const rect = el.getBoundingClientRect()
      if (rect.top <= center && rect.bottom >= center) {
        if (spanning < 0 || index < spanning) spanning = index
        continue
      }
      const gap = rect.top > center ? rect.top - center : center - rect.bottom
      if (gap < nearestGap) { nearestGap = gap; nearest = index }
    }
    const hit = spanning >= 0 ? spanning : nearest
    if (hit < 0) return
    const point = planRef.current.pointOfIndex[hit]
    if (typeof point === 'number' && point >= 0) applyActive(point)
  }, [applyActive])

  /** 重算一律走 rAF：IO / 滚动 / DOM 变化可能一帧来十几次，合并成一次。
      force 用 ref 记着：这一帧已经被「区间变化」排上队时，随后滚动停稳的强制重算
      不能被并掉（并掉就等于停稳之后不补判定，高亮停在滚动中途那一条上）。 */
  const schedule = useCallback((force: boolean) => {
    if (force) pendingForceRef.current = true
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      const forced = pendingForceRef.current
      pendingForceRef.current = false
      recompute(forced)
    })
  }, [recompute])

  /** 跳转：锁 200ms 并把高亮钉在目标刻度上，等滚动停下来再交还给可见区间。 */
  const jump = useCallback((pointIndex: number, itemIndex?: number) => {
    const point = planRef.current.points[pointIndex]
    if (!point) return
    const target = itemIndex ?? point.itemIndex
    forcedRef.current = pointIndex
    applyActive(pointIndex)
    lockUntilRef.current = performance.now() + FOLLOW_LOCK_MS
    if (previewExitRef.current !== null) { window.clearTimeout(previewExitRef.current); previewExitRef.current = null }
    setPreview(null)

    // 动效关闭＝瞬时：先在「已经渲染出来的那一条」上瞬时摆正一次。
    const scroller = scrollerRef.current ?? (hostRef.current ? findScroller(hostRef.current) : null)
    if (!motionOn()) instantScrollTo(scroller, target)
    const key = messageKeyOf(itemsRef.current[target])
    const handed = key ? scrollToMessage(key) : false
    // 没接住（骨架阶段还没有列表 / 这条不在当前列表里）：按下标自己兜底。
    if (!handed) revealByIndex(scroller, target, motionOn())
  }, [applyActive])

  /* ── 悬停：120ms 展开 + 出预览，140ms 收回。
        整条路径只有两笔 DOM 写入：给行翻 data-hot / data-dim（视觉全交给 CSS），
        以及给预览卡摆位（那一次只量该行 + 导航条两个 rect）。一次 mousemove 都不听。 ── */

  /** 悬停态的唯一出口：一行亮起并伸展到本侧最长、其余行淡化（聚光灯）。
      **翻的是 data 属性，不是样式**：长度、颜色、淡化的过渡都写在 class 里，
      所以这里只是 N 次属性写（多数行的值没变，浏览器一个像素都不用重绘），
      一个 rect 都不读，也不会引起重排。 */
  const markHot = useCallback((row: number, on: boolean) => {
    const rows = rowRefs.current
    for (let index = 0; index < rows.length; index += 1) {
      const el = rows[index]
      if (!el) continue
      const hot = on && index === row
      el.setAttribute('data-hot', hot ? 'true' : 'false')
      el.setAttribute('data-dim', on && !hot ? 'true' : 'false')
    }
  }, [])

  /** 预览内容的淡出与卸载：先撤 opacity（140ms 过渡），到点才摘掉节点。 */
  const closePreview = useCallback(() => {
    if (previewExitRef.current !== null) window.clearTimeout(previewExitRef.current)
    setPreview((prev) => (prev && prev.open ? { ...prev, open: false } : prev))
    previewExitRef.current = window.setTimeout(() => {
      previewExitRef.current = null
      setPreview((prev) => (prev && !prev.open ? null : prev))
    }, HOVER_OUT_MS)
  }, [])

  /** 出预览：内容一次取齐（**上下两段：问 + 答**），几何同样只算一次（该行一个 rect + 导航条一个 rect）。
      高度先用估值（estimatePreviewHeight）—— 真实高度由渲染后的 useLayoutEffect 在绘制之前同步量正，
      所以用户看到的第一帧就落在最终位置上，不会「先小后大」跳一下。 */
  const openPreview = useCallback((hot: Hot) => {
    const nav = navRef.current
    const row = rowRefs.current[hot.row]
    const point = planRef.current.points[hot.row]
    if (!nav || !row || !point) return
    const pick = pickPreview(point, itemsRef.current)
    // 两段都取不到（这一段里既没有用户消息也没有回复，例如只有提示条的一段）：没有内容可讲，宁可不弹。
    if (!pick.user && !pick.ai) return
    if (previewExitRef.current !== null) { window.clearTimeout(previewExitRef.current); previewExitRef.current = null }
    const host = nav.parentElement
    const box = host
      ? { width: host.clientWidth, height: host.clientHeight }
      : { width: window.innerWidth, height: window.innerHeight }
    const estimate = estimatePreviewHeight(
      pick.user ? summarize(pick.user.text) : '',
      pick.ai ? summarize(pick.ai.text) : '',
    )
    const spot = placePreview(row, nav, box, estimate)
    setPreview({
      ...pick,
      point: hot.row,
      focus: hot.part,
      left: spot.left,
      top: spot.top,
      ready: false,
      open: true,
    })
  }, [])

  /** 同一行内换半边（左线 ↔ 右线）：**内容不再切**（问与答一次讲全），只换「哪一段被高亮」。
      几何（left / top）与内容一个字都不动，所以一次 rect 都不重量、一次摘要都不重算。 */
  const swapPreview = useCallback((hot: Hot) => {
    setPreview((prev) => (
      prev && prev.point === hot.row && prev.focus !== hot.part ? { ...prev, focus: hot.part } : prev
    ))
  }, [])

  /** 展开这一行：该行两条线变主色并各自伸展到本侧最长、其余行淡化到 0.25 —— 全是 CSS。 */
  const enterHot = useCallback((hot: Hot) => {
    // **流式期间也允许展开**（原来这里直接 return）。
    // 用户正是在生成过程中回头确认「我刚问了什么」—— 那一刻导航条没反应，就是"不实时"。
    // 代价只有两次 rect 读取（用户触发，不是每帧）；真正昂贵的整表重算（recompute）
    // 在流式期间仍然让路，见上面 navFrozen 的说明 —— 两者不要混为一谈。
    const previous = hotRef.current
    if (previous && previous.row === hot.row) {
      // 同一行里换半边：**只换高亮的那一段**（预览被滚动收掉过就整个重开一次，几何仍是那两个 rect）。
      if (previewRef.current && previewRef.current.point === hot.row) swapPreview(hot)
      else openPreview(hot)
    } else {
      markHot(hot.row, true)
      openPreview(hot)
    }
    hotRef.current = hot
  }, [markHot, openPreview, swapPreview])

  /** 光标进到某一行 / 某半边（同一行内换半边不再走这一条；换到新行才走一次进入路径）。
      HOVER_IN_MS = 0 时这一步就是**同步展开**，连定时器都不排。 */
  const scheduleHot = useCallback((row: number, part: 'user' | 'ai') => {
    const pending = pendingRef.current
    const sameRow = !!pending && pending.row === row
    pendingRef.current = { row, part }
    if (hoverOutRef.current !== null) { window.clearTimeout(hoverOutRef.current); hoverOutRef.current = null }
    if (hotRef.current && hotRef.current.row === row) { enterHot({ row, part }); return }
    if (sameRow && hoverInRef.current !== null) return
    if (hoverInRef.current !== null) window.clearTimeout(hoverInRef.current)
    // HOVER_IN_MS = 0 时**不绕定时器**：指针落下就在当前这一拍展开并弹预览。
    // （setTimeout(…, 0) 虽然也是「本帧内」，但主线程被流式内容占着时会顺延到下一拍，
    //   而这一档的全部意义就是「没有等待」—— 见常量处的说明。）
    if (HOVER_IN_MS <= 0) {
      hoverInRef.current = null
      enterHot({ row, part })
      return
    }
    hoverInRef.current = window.setTimeout(() => {
      hoverInRef.current = null
      const next = pendingRef.current
      if (next) enterHot(next)
    }, HOVER_IN_MS)
  }, [enterHot])

  /** 光标离开某一行：140ms 内没有落到别的行上就收回（展开与预览一起）。 */
  const releaseHot = useCallback(() => {
    if (hoverInRef.current !== null) { window.clearTimeout(hoverInRef.current); hoverInRef.current = null }
    const row = hotRef.current ? hotRef.current.row : (pendingRef.current ? pendingRef.current.row : -1)
    pendingRef.current = null
    if (hoverOutRef.current !== null) window.clearTimeout(hoverOutRef.current)
    hoverOutRef.current = window.setTimeout(() => {
      hoverOutRef.current = null
      const current = hotRef.current
      if (!current || current.row !== row) return
      hotRef.current = null
      markHot(-1, false)
      closePreview()
    }, HOVER_OUT_MS)
  }, [markHot, closePreview])

  /** 刻度列换了（点数 / 尺寸 / 行距变了）：悬停态与预览全部作废，别挂在旧行上。 */
  useLayoutEffect(() => {
    if (hoverInRef.current !== null) { window.clearTimeout(hoverInRef.current); hoverInRef.current = null }
    if (hoverOutRef.current !== null) { window.clearTimeout(hoverOutRef.current); hoverOutRef.current = null }
    hotRef.current = null
    pendingRef.current = null
    markHot(-1, false)
    // 没有预览就没必要写一次 null：这条 effect 跟着 plan 走，白写一次就是白排一次渲染。
    if (previewRef.current) setPreview(null)
  }, [plan, markHot])

  /* ── 轨道上限与中线偏移：跟着消息区高度、位置与窗口高度走 ── */
  useEffect(() => {
    if (!visible) return
    const sync = (): void => {
      const host = navRef.current?.parentElement ?? null
      const box = host?.getBoundingClientRect()
      // 先算中线偏移，再按它夹轨道高度：两者都只看消息区在窗口里的位置，不互相依赖。
      const nextNudge = box && box.height > 0 ? Math.round(window.innerHeight / 2 - (box.top + box.height / 2)) : 0
      const nextCap = navCap(host, nextNudge)
      // 两个都只在「真的变了」时才写（nudge 差 1px 以上、cap 差 2px 以上）：量出来一样就不重渲染。
      setNudge((previous) => (Math.abs(nextNudge - previous) >= 1 ? nextNudge : previous))
      setCap((previous) => (Math.abs(nextCap - previous) >= 2 ? nextCap : previous))
    }
    /** 拖动窗口边缘时 resize 一帧能来十几次，每次都要读两个 rect：合并成一帧一次。
        量完不再排下一帧 —— 没有变化就没有下一次（ResizeObserver 只在真的变形时才回调）。 */
    let frame: number | null = null
    const scheduleSync = (): void => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => { frame = null; sync() })
    }
    sync()
    window.addEventListener('resize', scheduleSync)
    const host = navRef.current?.parentElement
    const observer = host && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleSync) : null
    if (host && observer) observer.observe(host)
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', scheduleSync)
      observer?.disconnect()
    }
  }, [visible])

  /* ── 可见区间：IO + 节点增删重挂 + 滚动锁 + 到底判定 ── */
  useEffect(() => {
    if (!visible) return
    const nav = navRef.current
    const host = nav?.closest('[data-chat-col]')
    if (!nav || !(host instanceof HTMLElement)) return

    hostRef.current = host
    visibleRef.current = new Set()
    bandSigRef.current = ''
    recompute(true)

    let observer: IntersectionObserver | null = null
    let root: HTMLElement | null = null
    let scrollHost: HTMLElement | Window = window
    let frame: number | null = null
    let scrollFrame: number | null = null
    /** 已经交给 IO 的元素：DOM 变化时只挂「新来的那几个」，不再每次整表重扫。 */
    const watched = new Set<Element>()

    const onEntries: IntersectionObserverCallback = (entries) => {
      let changed = false
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.msgIndex)
        if (!Number.isFinite(index)) continue
        const had = visibleRef.current.has(index)
        if (entry.isIntersecting) { if (!had) { visibleRef.current.add(index); changed = true } }
        else if (had) { visibleRef.current.delete(index); changed = true }
      }
      // 只在可见区间真的变了（或还在锁定期里）才排重算：区间没动的那些回调一次 rect 都不量。
      if (changed || performance.now() < lockUntilRef.current) schedule(false)
    }

    /** 滚动这一拍的全部动作：推后锁、收回预览、重排停稳判定。
        ① 滚动事件一帧来十几次，合并成一次（rAF）；
        ② 预览只在这一帧**真的挂着**时才写状态 —— 绝大多数帧根本没有预览，一次 setState 都不该发生；
        ③ 写完这一拍就结束：不排下一帧，停稳由那一个定时器收口。 */
    const flushScroll = (): void => {
      scrollFrame = null
      lockUntilRef.current = performance.now() + FOLLOW_LOCK_MS
      if (previewRef.current) setPreview(null)
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null
        forcedRef.current = -1
        schedule(true)
      }, FOLLOW_LOCK_MS + 24)
    }
    const onScroll = (): void => { if (scrollFrame === null) scrollFrame = window.requestAnimationFrame(flushScroll) }

    /** 挂节点 + 「必要时」重定根。
        虚拟列表的滚动容器要等条目真的渲染出来才找得到（首帧它还是个空壳），
        所以这里每次 DOM 变化都重解析一次：根换了就重建 Observer 并把滚动监听挪过去。 */
    /** 新条目只挂给 IO 一次：同一个元素 observe 两次没有意义，整表重扫在长会话里是白费。 */
    const watch = (el: Element): void => {
      if (!observer || watched.has(el)) return
      watched.add(el)
      observer.observe(el)
    }
    /** 只看这一批**新增**的节点里有没有条目（含它的子树）：没有就什么都不做。 */
    const watchAdded = (nodes: Iterable<Node>): void => {
      if (!observer) return
      for (const node of nodes) {
        if (!(node instanceof Element)) continue
        if (node.matches('[data-msg-index]')) watch(node)
        for (const el of node.querySelectorAll('[data-msg-index]')) watch(el)
      }
    }

    const attach = (): void => {
      frame = null
      // 找到过的容器只要还在文档里就一直用它（每帧重走一遍样式链在流式输出时太浪费）。
      const found = root && root.isConnected ? root : findScroller(host)
      if (found === root) return
      observer?.disconnect()
      root = found
      scrollerRef.current = found
      visibleRef.current = new Set()
      watched.clear()
      observer = new IntersectionObserver(onEntries, { root: found, rootMargin: BAND_MARGIN, threshold: 0 })
      scrollHost.removeEventListener('scroll', onScroll)
      scrollHost = found ?? window
      scrollHost.addEventListener('scroll', onScroll, { passive: true })
      // 换根＝整条列表都换了，只有这一拍才整表重挂一次。
      for (const el of host.querySelectorAll<HTMLElement>('[data-msg-index]')) watch(el)
    }
    const scheduleAttach = (): void => { if (frame === null) frame = window.requestAnimationFrame(attach) }

    /** DOM 变化：只有「根没了 / 新节点长在根外面」才值得排一帧重解析，其余时候只把新增条目挂给 IO。
        流式输出期间每个 token 都会来一批 mutation，但那批里一个 [data-msg-index] 都没有 ——
        既不排帧、也不重扫全表，这就是「有变化才调度、连续无变化即停」。 */
    const onMutations = (records: MutationRecord[]): void => {
      if (!root || !root.isConnected) { scheduleAttach(); return }
      for (const record of records) {
        if (!record.addedNodes.length) continue
        if (!root.contains(record.target)) { scheduleAttach(); return }
        watchAdded(record.addedNodes)
      }
      // 卸载掉的元素会在 watched 里攒成断开的引用：攒大了清一次（不清就是长会话里的隐性泄漏）。
      if (watched.size > 512) for (const el of watched) if (!el.isConnected) watched.delete(el)
    }

    attach()
    const mutations = new MutationObserver(onMutations)
    mutations.observe(host, { childList: true, subtree: true })

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame)
      observer?.disconnect()
      mutations.disconnect()
      scrollHost.removeEventListener('scroll', onScroll)
      if (settleTimerRef.current !== null) { window.clearTimeout(settleTimerRef.current); settleTimerRef.current = null }
      visibleRef.current = new Set()
      watched.clear()
      scrollerRef.current = null
    }
    // 依赖里**没有点数**：增量追加只多一行，观察器、滚动监听、已挂节点全都照旧 ——
    // 只有聚合档位真的换了（结构重排）才值得整条重挂一次。
  }, [visible, plan.threshold, schedule, recompute])

  /* ── 键盘：Ctrl+↑ / Ctrl+↓ 跳刻度，Esc 关预览。
        End 键（一键到底）挂在页面层（views/ChatView.tsx）—— 那是「对话页」的动作，
        窄窗口下导航条整条不渲染时它也该照常生效。 ── */
  useEffect(() => {
    if (!visible) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (!preview) return
        event.stopPropagation()
        releaseHot()
        return
      }
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      const list = planRef.current.points
      if (!list.length) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const from = activeRef.current >= 0 ? activeRef.current : (step > 0 ? -1 : list.length)
      jump(clamp(from + step, 0, list.length - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, preview, jump, releaseHot])

  /* ── 切页过渡那一拍不量：过渡结束（App 收回标记）后补一次 ── */
  useEffect(() => {
    if (!visible) return
    const observer = new MutationObserver(() => {
      if (!navBusy()) schedule(true)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nav-busy'] })
    return () => observer.disconnect()
  }, [visible, schedule])

  useEffect(() => () => {
    if (hoverInRef.current !== null) window.clearTimeout(hoverInRef.current)
    if (hoverOutRef.current !== null) window.clearTimeout(hoverOutRef.current)
    if (previewExitRef.current !== null) window.clearTimeout(previewExitRef.current)
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
  }, [])

  /* 预览浮层的首帧定位 + 溢出判定，**全在浏览器绘制之前同步完成**：
     ① 宽度定死（PREVIEW_W），所以内容变化只影响高度；这里量一次真实高度（offsetHeight），
        按可视区夹一次 top —— 位置一次到位。
     ② ready 与这一次量测写在**同一拍**里：上一版把 ready 放到 rAF 里，于是第一帧用的是估值高度、
        第二帧才摆正，视觉上就是「先小后大」地跳一下（尤其两段式之后高度差得更远）。
     ③ 顺手量两段的溢出（scrollHeight > clientHeight）：**只有真的超出**才把 mask 挂上去。
        没有这一步，短文本的下沿也会被那层无条件渐隐抹掉一截 —— 就是用户说的「AI 回复虚化」。 */
  useLayoutEffect(() => {
    const box = previewBoxRef.current
    const nav = navRef.current
    if (!box || !nav || !preview) return
    const host = nav.parentElement
    const max = Math.max(4, (host?.clientHeight ?? window.innerHeight) - box.offsetHeight - 4)
    const top = clamp(preview.top, 4, max)
    // 溢出判定：+1 是给次像素行高留的余量（差不到一行就不算超）。
    const userEl = previewUserRef.current
    const aiEl = previewAiRef.current
    const userOver = !!userEl && userEl.scrollHeight > userEl.clientHeight + 1
    const aiOver = !!aiEl && aiEl.scrollHeight > aiEl.clientHeight + 1
    // 只在结论翻转时才写这个 state（写一次多一遍渲染；mask 不改变布局，所以不会再触发下一拍）。
    setPreviewOverflow((prev) => (prev.user === userOver && prev.ai === aiOver ? prev : { user: userOver, ai: aiOver }))
    // 已经在场（同一行内换了半边）：内容没变，量到的 top 也不会变，这里基本是空转一次。
    if (preview.ready) {
      if (top !== preview.top) setPreview((prev) => (prev ? { ...prev, top } : prev))
      return
    }
    // 同步翻 ready：React 会在绘制前把这一笔补上，用户看到的第一帧就已经在最终位置上，然后才淡入。
    setPreview((prev) => (prev && !prev.ready ? { ...prev, top, ready: true } : prev))
  }, [preview])

  /* 刻度列换了（点数 / 尺寸 / 行距变了）：高亮清空、位置条按新排布重摆一次。
     **但「只是追加」不算换**：新一份的前缀逐个还是上一份的那几个对象时，
    哪一条是当前项一个字都不改（用户正上翻，新点不该把视线拽走），只补位置条的几何。 */
  useLayoutEffect(() => {
    const count = plan.points.length
    if (!count) return
    rowRefs.current.length = count
    userTickRefs.current.length = count
    const marker = markerRef.current
    if (marker) marker.style.height = markerHeight(plan) + 'px'
    applyActive(-1)
    schedule(true)
  }, [plan, applyActive, placeMarker, schedule])

  if (!visible || !plan.points.length) return null

  const points = plan.points
  const markerH = markerHeight(plan)
  const activeIndex = activeRef.current
  const previewPoint = preview ? points[preview.point] : undefined
  const previewShown = !!preview && preview.open && preview.ready
  const previewTransition = 'opacity var(--motion-base) var(--ease-spring), transform var(--motion-base) var(--ease-spring)'
  /** 两段：上＝用户问题（大号），下＝AI 回复摘要。取不到的那一段是 undefined —— 不渲染、不留空行。 */
  const userSeg = preview ? preview.user : undefined
  const aiSeg = preview ? preview.ai : undefined
  /** 悬停的是哪半边 → 高亮哪一段（两段的内容不再跟着半边切换）。 */
  const focus = preview ? preview.focus : 'user'
  /** 两段的行数上限（em 是相对各自字号，所以两段各写各的）：超限才由 previewOverflow 挂渐隐。 */
  const userMaxH = PREVIEW_USER_LINES * PREVIEW_USER_LH + 'em'
  const aiMaxH = PREVIEW_AI_LINES * PREVIEW_AI_LH + 'em'
  /** 轮次范围：跟着第一段走（只有 AI 段时才落到下段），少一段也不丢这条信息。 */
  const rangeLabel = previewPoint ? turnRangeLabel(previewPoint.turnFrom, previewPoint.turnTo) : ''
  /** 轨道的宽 ＝ 导航条本体宽：两条车道都画在里面，不必再往外留余量。 */
  const trackWidth = NAV_W

  return (
    <nav
      ref={navRef}
      data-msg-nav
      data-nav-count={points.length}
      data-nav-dot={plan.dot}
      data-nav-pitch={Math.round(plan.pitch * 100) / 100}
      data-nav-gap={Math.round((plan.pitch - plan.dot) * 10) / 10}
      data-nav-max={Math.round(plan.height)}
      data-nav-scroll={plan.scroll ? 'true' : 'false'}
      data-nav-threshold={plan.threshold}
      /* 中线偏移（px）：自检脚本按它反推「轨道中心是不是窗口中心」 */
      data-nav-nudge={nudge}
      data-nav-active={activeIndex}
      aria-label='消息导航'
      aria-orientation='vertical'
      /* 贴内容列左缘外侧：留白由 --content-w 算出；空间不够（窄窗口）时退到本列左缘
         —— 本列左缘＝窗口左缘 + Rail，所以永远不会画到一级导航上面。 */
      style={{
        top: 'calc(50% + ' + nudge + 'px)',
        left: 'max(0px, calc((100% - var(--content-w)) / 2 - ' + (NAV_W + NAV_AWAY) + 'px))',
        width: NAV_W,
        transform: 'translateY(-50%)',
        /* 两条车道的长度上限 + 右列那两个颜色：class 里只出现 var(...) 字面量，
           数值仍然只有这一处（AI_MAX / USER_MAX / 60% 主色）。 */
        '--ai-max': AI_MAX + 'px',
        '--user-max': USER_MAX + 'px',
        '--tick-user': 'color-mix(in srgb, var(--primary) 60%, transparent)',
        '--tick-user-on': 'var(--primary)',
      } as CSSProperties}
      className='pointer-events-none absolute z-20'
    >
      {/* 刻度轨：容器本身不接指针（正文照常可选可点），只有刻度行接；滚到头把滚轮让给对话区。
          高度是算出来的（刻度数 × 行距，夹在 48 与 min(70vh,520) 之间），不铺满。
          宽就是轨道宽：两条车道都画在里面（各自从本侧基准往中间长），悬停怎么伸展都出不了这条轨道，
          自滚档要 overflow-y 也不会把线裁掉 —— 不再需要「向左多留一截再整体左移」那一手。 */}
      <div
        ref={trackRef}
        data-msg-nav-track
        style={{
          width: trackWidth,
          height: plan.height,
          paddingTop: plan.padTop,
          paddingBottom: plan.padBottom,
          /* 放得下就别裁：悬停伸展出去的那一截不该被轨道切掉；要滚的时候才让 overflow 生效。 */
          overflowY: plan.scroll ? 'auto' : 'visible',
        }}
        onWheel={(event) => {
          const track = event.currentTarget
          const scrollable = track.scrollHeight > track.clientHeight + 1
          const atTop = track.scrollTop <= 0
          const atEnd = track.scrollTop + track.clientHeight >= track.scrollHeight - 1
          const inside = (event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atEnd)
          if (scrollable && inside) return
          const scroller = scrollerRef.current
          if (scroller) scroller.scrollTop += event.deltaY
        }}
        className='pointer-events-none relative flex flex-col [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
      >
        {/* 位置指示条：只靠 transform / opacity 动，跟着轨道一起滚（所以放在轨道里面）。
            落在这条轨道左缘那 6px 的留白里，不压左边的刻度线。 */}
        <span
          ref={markerRef}
          data-nav-marker
          aria-hidden='true'
          style={{
            left: 0,
            height: markerH,
            width: MARKER_W,
            opacity: activeIndex >= 0 ? 1 : 0,
            transform: 'translate3d(0,' + (plan.padTop + (activeIndex < 0 ? 0 : activeIndex * plan.pitch + plan.pitch / 2 - markerH / 2)) + 'px,0)',
          }}
          className='pointer-events-none absolute top-0 rounded-full bg-primary transition-[transform,opacity] duration-[var(--motion-fast)] ease-[var(--ease-enter)]'
        />
        {points.map((point, index) => {
          const isActive = index === activeIndex
          const at = timeOf(point.head)
          const user = point.head.kind === 'user' ? point.head : undefined
          const aiAt = point.aiHead ? timeOf(point.aiHead) : undefined
          const range = turnRangeLabel(point.turnFrom, point.turnTo)
          const userText = user ? summarize(user.text, 40) : ''
          const aiText = point.aiHead ? summarize(itemText(point.aiHead), 40) : ''
          /// 「进行中」写进无障碍名：这一条还在长，长度是基线、颜色在脉冲 —— 读屏也该知道。
          const liveSuffix = point.live ? ' · 进行中' : ''
          const userLabel = range + ' · 你' + (at ? ' · ' + fmtTime(at) : '') + (userText ? ' · ' + userText : '') + liveSuffix
          const aiLabel = range + ' · AI 回复' + (aiAt ? ' · ' + fmtTime(aiAt) : '') + (aiText ? ' · ' + aiText : '') + liveSuffix
          /* 两条刻度线的基础长度走 CSS 变量（**不是** width）：长度得留给 class 里的
             当前档（+2px）与悬停档（本侧最长）去盖，内联 width 会把它们全压死。 */
          const rowStyle = {
            width: NAV_W,
            height: plan.pitch,
            paddingLeft: NAV_GUTTER,
            /* 命中高度：视觉线只有 2px，但整行 12px 都好点（行距不足 12px 时退到行距，绝不串到邻行） */
            '--tick-hit': Math.max(TICK_H, Math.min(TICK_HIT, Math.floor(plan.pitch))) + 'px',
            '--ai-w': point.bar + 'px',
            '--user-w': point.user + 'px',
          } as CSSProperties
          return (
            <div
              key={point.key}
              ref={(el) => { rowRefs.current[index] = el }}
              data-nav-point={index}
              data-nav-from={point.turnFrom}
              data-nav-to={point.turnTo}
              /* 条目下标范围：自检 / 调试按它把「可见区间」换算成刻度，不必猜 */
              data-nav-item={point.itemIndex}
              data-nav-ai={point.aiIndex}
              data-nav-last={point.to}
              /* 两条线的长度 / 有没有工具段 / 有没有错误：都取自「轮结束时算出来的那一份」 */
              data-nav-bar={point.bar}
              data-nav-user={point.user}
              data-nav-tool={point.tool > 0 ? 'true' : 'false'}
              data-nav-error={point.error ? 'true' : 'false'}
              /* 生成中的点：只有它带这个标记（长度是基线、颜色走主色脉冲） */
              data-nav-live={point.live ? 'true' : 'false'}
              data-active={isActive ? 'true' : 'false'}
              /* 悬停态：JS 只翻这两个属性，视觉（变主色 / 伸展 / 淡化）全在 CSS 里 */
              data-hot='false'
              data-dim='false'
              style={rowStyle}
              /* 悬停部位只看事件目标是哪条线：右线＝用户那条，其余（行空白 / 左线）＝AI 那条。
                 这样就不依赖 enter 在「行 → 子元素」上的派发顺序了。 */
              onPointerEnter={(event) => scheduleHot(index, hoverPart(event.target))}
              onPointerLeave={releaseHot}
              onClick={() => jump(index, point.aiIndex >= 0 ? point.aiIndex : point.itemIndex)}
              className='group/row pointer-events-auto relative flex shrink-0 cursor-pointer items-center transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-spring)] data-[dim=true]:opacity-25'
            >
              {/* 左＝AI 回复：**左对齐**的细线，从轨道左缘（让开那 6px 指示留白）往右长，
                  长度按这一轮的体量对数映射（4 / 10 / 22px）。有工具调用时**末段换一段更淡的**
                  （opacity .5，宽 2~5px）；有错误时线的**最右端加一个 2px 红点**。点它跳这一轮的回答。 */}
              {point.aiIndex >= 0 ? (
                <button
                  type='button'
                  data-nav-dot='ai'
                  data-nav-role='ai'
                  data-nav-at={point.aiIndex}
                  aria-label={aiLabel}
                  onPointerEnter={() => scheduleHot(index, 'ai')}
                  onClick={(event) => { event.stopPropagation(); jump(index, point.aiIndex) }}
                  /* 长度只有 class 说了算：var(--ai-w) 是这一轮体量算出来的长度，
                     当前轮 +2px、悬停档伸到本侧最长 22px —— 全在 CSS，JS 一行样式都不写。
                     命中高度是整行 12px（--tick-hit），视觉线仍然只有里面那 2px。 */
                  className='pointer-events-auto relative flex h-[var(--tick-hit)] w-[var(--ai-w)] shrink-0 cursor-pointer items-center bg-transparent p-0 transition-[width] duration-[var(--motion-fast)] ease-[var(--ease-spring)] group-data-[active=true]/row:w-[calc(var(--ai-w)_+_2px)] group-data-[hot=true]/row:w-[var(--ai-max)]'
                >
                  {/* 主段：这一轮的长度减去末段那几像素（没有工具调用时末段为 0，整根都是它） */}
                  <span
                    aria-hidden='true'
                    data-loop-anim={point.live ? '' : undefined}
                    className={cn(
                      TICK_SHAPE,
                      /* 生成中：**主色脉冲**（长度仍是基线 10px）—— 「还在长」只在这一个状态上表达，
                         所以它与「当前项 / 悬停」那两档不叠加（那两档是给已定稿的刻度用的）。 */
                      point.live
                        ? 'min-w-[2px] flex-1 animate-pulse bg-primary/60'
                        : 'min-w-[2px] flex-1 bg-ink-4 group-data-[active=true]/row:bg-ink-2 group-data-[hot=true]/row:bg-primary',
                    )}
                  />
                  {/* 工具延长段：接在主段后面、更淡的同一根线（宽度按工具占这一轮体量的比例 2~5px） */}
                  {point.tail > 0 ? (
                    <span
                      aria-hidden='true'
                      style={{ width: point.tail }}
                      className={cn(
                        TICK_SHAPE,
                        'opacity-50 bg-ink-4 group-data-[active=true]/row:bg-ink-2 group-data-[hot=true]/row:bg-primary',
                      )}
                    />
                  ) : null}
                  {/* 出错：线的**最右端**那 2px 红点 */}
                  {point.error ? (
                    <span
                      aria-hidden='true'
                      style={{ width: ERROR_DOT, height: ERROR_DOT }}
                      className='pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 rounded-full bg-danger'
                    />
                  ) : null}
                </button>
              ) : null}
              {/* 右＝用户消息：**右对齐**的细线，从轨道右缘往左长，长度按这条消息的字数（4 ~ 10px），
                  颜色是 60% 的主色。它排在行尾（ml-auto），所以每一轮的右线都落在同一条竖直基准上，
                  往左长多少都不带动别的行 ——「一问一答分列两端」的秩序感就来自这对基准。 */}
              {user ? (
                <button
                  type='button'
                  ref={(el) => { userTickRefs.current[index] = el }}
                  data-nav-dot='user'
                  data-nav-role='user'
                  data-nav-at={point.itemIndex}
                  aria-label={userLabel}
                  onPointerEnter={() => scheduleHot(index, 'user')}
                  onClick={(event) => { event.stopPropagation(); jump(index, point.itemIndex) }}
                  /* 基线长度走 var(--user-w)；当前轮 +2px、悬停档伸到本侧最长 10px —— 全在 class 里。
                     颜色三档：60% 主色（静默）→ 主色（当前）→ 主色（悬停，另有伸展与聚光灯）。 */
                  className='pointer-events-auto ml-auto flex h-[var(--tick-hit)] w-[var(--user-w)] shrink-0 cursor-pointer items-center bg-transparent p-0 transition-[width] duration-[var(--motion-fast)] ease-[var(--ease-spring)] group-data-[active=true]/row:w-[calc(var(--user-w)_+_2px)] group-data-[hot=true]/row:w-[var(--user-max)]'
                >
                  <span
                    aria-hidden='true'
                    data-loop-anim={point.live ? '' : undefined}
                    className={cn(
                      TICK_SHAPE,
                      // 右线同理：生成中的点（正在跑的那一轮 / 刚追加的那一条）是半透明主色 + 脉冲。
                      point.live
                        ? 'w-full animate-pulse bg-primary/60'
                        : 'w-full bg-[var(--tick-user)] group-data-[active=true]/row:bg-[var(--tick-user-on)] group-data-[hot=true]/row:bg-primary',
                    )}
                  />
                </button>
              ) : null}
            </div>
          )
        })}
      </div>

      {/* 预览浮层：**问 + 答两段式**。
          上段＝用户问题（text-13 / text-ink / font-medium，最大号），
          中间一条 border-line 细分割线，
          下段＝AI 回复摘要（text-12 / text-ink-2，比旧版提一号字，**不虚化**）。
          悬停左线 / 右线不再切换内容，只高亮对应那一段（淡主色底，两段都不降透明度）。
          尾部渐隐改为条件挂载：只有真的超出行数上限的那一段才挂（见 previewOverflow）。
          导航条在左，所以一律翻到右侧；进场 / 退场只动 opacity 与 translate，不碰布局。 */}
      {preview && previewPoint ? (
        <div
          ref={previewBoxRef}
          data-nav-preview
          data-side='right'
          /* 两个属性都写「悬停的是哪一半」：半边信息不再用来切内容，但绝不能丢。
             data-nav-role 沿用旧名（外部自检脚本读的就是它），data-nav-focus 是它的语义化别名。 */
          data-nav-role={focus}
          data-nav-focus={focus}
          style={{
            left: preview.left,
            top: preview.top,
            width: PREVIEW_W,
            opacity: previewShown ? 1 : 0,
            transform: previewShown ? 'translate3d(0,0,0)' : 'translate3d(-8px,0,0)',
            transition: previewTransition,
          }}
          className='pointer-events-none absolute z-30 rounded-[12px] border border-line bg-overlay px-3.5 py-3 shadow-elev-2'
        >
          {userSeg ? (
            <div
              data-nav-seg='user'
              data-nav-seg-at={userSeg.index}
              /* 高亮只加一层很淡的主色底：**不压字号、不降透明度** ——
                 两段的可读性始终一样，只是被指到的那一段更显眼。 */
              className={cn(
                '-mx-1.5 rounded-[8px] px-1.5 py-1 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
                focus === 'user' ? 'bg-primary-soft' : 'bg-transparent',
              )}
            >
              <div className='flex items-center gap-1.5'>
                <span className={cn('text-10 font-normal tracking-[0.02em]', focus === 'user' ? 'text-primary' : 'text-ink-3')}>
                  {pickLabel('user')}
                </span>
                {userSeg.at ? <span className='text-10 text-ink-4'>{fmtTime(userSeg.at)}</span> : null}
                <span className='ml-auto shrink-0 text-10 text-ink-4'>{rangeLabel}</span>
              </div>
              <p
                ref={previewUserRef}
                className='mt-1 overflow-hidden text-13 font-medium leading-[1.54] text-ink'
                style={{ maxHeight: userMaxH, ...fadeStyle(previewOverflow.user) }}
              >
                {summarize(userSeg.text) || '（无文本内容）'}
              </p>
            </div>
          ) : null}
          {/* 两段之间那条细分割线：只在两段都在场时才画（只剩一段时它既没意义又多一条横线）。
              用的是现成的 border-line 令牌，不引入新的视觉语言。 */}
          {userSeg && aiSeg ? <div className='my-2 border-t border-line' aria-hidden='true' /> : null}
          {aiSeg ? (
            <div
              data-nav-seg='ai'
              data-nav-seg-at={aiSeg.index}
              className={cn(
                '-mx-1.5 rounded-[8px] px-1.5 py-1 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
                focus === 'ai' ? 'bg-primary-soft' : 'bg-transparent',
              )}
            >
              <div className='flex items-center gap-1.5'>
                {/* AI 角色标签从 ink-3 提到 ink-2：它不该比正文还淡。 */}
                <span className={cn('text-10 font-normal tracking-[0.02em]', focus === 'ai' ? 'text-primary' : 'text-ink-2')}>
                  {pickLabel('ai')}
                </span>
                {aiSeg.at ? <span className='text-10 text-ink-4'>{fmtTime(aiSeg.at)}</span> : null}
                {/* 这一轮没有用户段（例如只有回复）时，轮次范围落到下段来，免得整条信息丢掉。 */}
                {!userSeg ? <span className='ml-auto shrink-0 text-10 text-ink-4'>{rangeLabel}</span> : null}
              </div>
              <p
                ref={previewAiRef}
                className='mt-1 overflow-hidden text-12 leading-[1.55] text-ink-2'
                style={{ maxHeight: aiMaxH, ...fadeStyle(previewOverflow.ai) }}
              >
                {summarize(aiSeg.text) || '（无文本内容）'}
              </p>
            </div>
          ) : null}
          <div className='mt-2 flex items-center gap-1 text-10 text-ink-4'>
            <MousePointerClick size={10} className='shrink-0' />
            <span>点击跳转</span>
          </div>
        </div>
      ) : null}
    </nav>
  )
})


