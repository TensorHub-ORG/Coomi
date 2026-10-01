/** 会话内搜索（Ctrl/Cmd+F）。
 *
 *  命中在 MessageList 里靠 DOM 遍历算出（不改 Markdown 渲染，也就不需要永久标记），
 *  这里只保存界面状态：是否打开 / 关键词 / 命中数 / 当前第几条。 */
import { create } from 'zustand'

export interface SearchController {
  /** 在当前会话的消息 DOM 里找命中，返回命中总数。 */
  search: (query: string) => number
  /** 跳到第 index 条命中（0 基）并做一次短暂高亮。 */
  focus: (index: number) => void
  /** 清掉所有临时高亮。 */
  clear: () => void
}

let controller: SearchController | null = null

/** MessageList 挂载 / 消息更新时注册；卸载时传 null 注销，避免操作已卸载的 DOM。 */
export function registerSearchController(next: SearchController | null): void {
  controller = next
  // 控制器换了（消息列表变了）要按当前关键词重算，否则命中数会停在旧值，
  // 流式追加的正文也永远搜不到。
  const { open, query } = useChatSearch.getState()
  if (open && query) useChatSearch.getState().refresh()
}

interface ChatSearchState {
  open: boolean
  query: string
  /// 命中总数；0 表示当前关键词没有命中（或还没输入）。
  count: number
  /// 当前第几条，1 基；0 表示没有命中。
  active: number
  show: () => void
  hide: () => void
  setQuery: (query: string) => void
  /// 消息内容变化后重算命中（保持当前序号不越界）。
  refresh: () => void
  next: () => void
  prev: () => void
}

function clampActive(active: number, count: number): number {
  if (!count) return 0
  return Math.min(Math.max(1, active || 1), count)
}

export const useChatSearch = create<ChatSearchState>((set, get) => ({
  open: false,
  query: '',
  count: 0,
  active: 0,

  show: () => set({ open: true }),

  hide: () => {
    controller?.clear()
    set({ open: false, count: 0, active: 0 })
  },

  setQuery: (query) => {
    // 没有控制器（消息列表还没挂载）时命中数只能是 0，界面据此显示「无匹配」。
    const count = controller?.search(query) ?? 0
    set({ query, count, active: clampActive(1, count) })
    // 边打边跳：输入就把视图带到第一条命中，跟「页内查找」的习惯一致。
    if (count) controller?.focus(0)
  },

  refresh: () => {
    const { open, query, active } = get()
    if (!open || !query) { set({ count: 0, active: 0 }); return }
    const count = controller?.search(query) ?? 0
    set({ count, active: clampActive(active, count) })
  },

  next: () => {
    const { count, active } = get()
    if (!count) return
    const index = active >= count ? 1 : active + 1
    set({ active: index })
    controller?.focus(index - 1)
  },

  prev: () => {
    const { count, active } = get()
    if (!count) return
    const index = active <= 1 ? count : active - 1
    set({ active: index })
    controller?.focus(index - 1)
  },
}))
