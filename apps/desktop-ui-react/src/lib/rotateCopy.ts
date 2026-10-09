/**
 * 空态（新对话首屏）那句大标题的轮换文案（纯逻辑，node 可直接跑）。
 *
 *   · 池子固定七条：进入空态随机一组，之后每 14 秒换一组（节奏放长，避免抢注意力）；
 *   · 开关落在 localStorage 的 coomi.rotateCopy.v1（默认开，只有显式写 '0' 才是关）——
 *     刻意不并进 stores/ui 的 prefs：这条设置很小，独立成键就不会跟并行的偏好改动打架；
 *   · 组件侧只做两件事：读一次当前值 + 订阅变化（设置页一改，空态立刻跟上）。
 */

/** 开关的键：**独立成键**，不并进 coomi.prefs.v2。 */
export const ROTATE_COPY_KEY = 'coomi.rotateCopy.v1'
/** 轮换节奏：14 秒。短节奏会让人一直盯着它看，反而打扰阅读与输入。 */
export const ROTATE_COPY_MS = 14000

/** 池子（顺序即轮换顺序；第一条也是关掉轮换时的兜底）。 */
export const ROTATE_COPY_POOL = [
  '开始新会话',
  '问我任何事',
  '让我帮你写代码',
  '拆解复杂任务',
  '读文件·查资料·出图表',
  '把想法变成产物',
  '先说清楚，再动手',
] as const

/** 读写的唯一口子（隐私模式下 localStorage 会抛，一律吞掉）。 */
export interface CopyStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export const copyStore: CopyStore = {
  getItem: (key) => { try { return localStorage.getItem(key) } catch { return null } },
  setItem: (key, value) => { try { localStorage.setItem(key, value) } catch { /* 忽略 */ } },
}

/** 只有显式写成 '0' 才算关：没写过 / 写坏了都按默认「开」。 */
export function parseRotateCopy(raw: string | null): boolean {
  return raw !== '0'
}

export function readRotateCopyEnabled(store: CopyStore = copyStore): boolean {
  return parseRotateCopy(store.getItem(ROTATE_COPY_KEY))
}

/** 订阅者：设置页改了值，已挂载的空态立刻跟着变（同一个窗口内，不必等重新挂载）。 */
const listeners = new Set<() => void>()

export function subscribeRotateCopy(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function writeRotateCopyEnabled(on: boolean, store: CopyStore = copyStore): void {
  store.setItem(ROTATE_COPY_KEY, on ? '1' : '0')
  // 复制一份再遍历：通知过程中有人退订也不会把这次遍历改坏。
  for (const notify of [...listeners]) notify()
}

/** 进入空态时的那一组：随机（随机源可注入，便于断言）。 */
export function randomCopyIndex(length: number, random: () => number = Math.random): number {
  if (!(length > 0)) return 0
  const value = Math.floor(random() * length)
  return value >= 0 && value < length ? value : 0
}

/** 下一组（到底回头）。 */
export function nextCopyIndex(index: number, length: number): number {
  if (!(length > 0)) return 0
  return (index + 1) % length
}
