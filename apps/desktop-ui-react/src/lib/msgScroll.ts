/** 消息定位中枢：MessageList 注册实现，消息导航条（会话内跳转 / 上下一条）调用跳转。
    两边只通过这一个模块耦合，导航条不需要知道当前是普通列表还是虚拟列表
    （虚拟列表里目标条目可能还没挂载，只有列表自己知道该 scrollToIndex 还是 scrollIntoView）。 */

export type MessageScroller = (msgId: string) => void

let current: MessageScroller | null = null

/** 注册（传 null 注销）消息定位实现，返回注销函数——effect 里直接 return 它即可。
    重复注册以最后一次为准：列表重挂载时旧实现会被新实现顶掉。 */
export function registerMessageScroller(fn: MessageScroller | null): () => void {
  current = fn
  return () => { if (current === fn) current = null }
}

/** 跳到某条消息。返回是否真的交给了实现：
    false = 还没有列表挂载（骨架阶段）或这条消息不在当前列表里，调用方可以据此给提示。 */
export function scrollToMessage(msgId: string): boolean {
  if (!msgId || !current) return false
  current(msgId)
  return true
}
