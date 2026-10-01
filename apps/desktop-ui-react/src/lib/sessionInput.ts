/** 输入区（草稿 / 引用 / 附件）按**会话 id 分桶**的持久化。
 *
 *  为什么要有这一层：输入区里的东西属于某一个会话。附件与引用以前只活在 Composer 的
 *  组件状态里，切到别的会话它们还留在输入框上——看起来是「跨会话跟过来」，严重时会被
 *  当成新会话的内容发出去。草稿早就是按会话存的（coomi.draft.v1.<id>），这里把三样
 *  收进同一套规则：
 *    · 键 = 前缀 + 会话 id（coomi.attachments.v1.<sessionId> / coomi.quotes.v1.<id> / 草稿同前）；
 *    · 切会话：先 saveInput(当前会话) 再 loadInput(目标会话)；
 *    · 新会话没有桶＝空输入区；
 *    · 发送成功＝clearInput(当前会话)，只清这一份，别的会话的待发送内容一个字都不动；
 *    · 删会话＝dropSessionBuckets(会话 id)，三个桶一起清，localStorage 不会无限长。
 *
 *  **纯逻辑**：零 import、不碰 DOM（storage 由调用方注入），所以 node 能直接跑它做断言。
 *  输入区只认这三个前缀；历史回读带回来的 attachments / quotes 属于**消息元数据**
 *  （coomi.msgmeta.v1.<id>，见 stores/session.ts），两者不共用键，永远不会互相灌。 */

/** 只需要这三个方法：localStorage 天然满足，测试里喂一个 Map 就够了。 */
export interface BucketStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const DRAFT_PREFIX = 'coomi.draft.v1.'
export const QUOTES_PREFIX = 'coomi.quotes.v1.'
export const ATTACHMENTS_PREFIX = 'coomi.attachments.v1.'
/** 输入区的三个桶：清空 / 删会话时一起处理。 */
export const INPUT_PREFIXES: readonly string[] = [DRAFT_PREFIX, QUOTES_PREFIX, ATTACHMENTS_PREFIX]

export interface ComposerInput<Quote = unknown, Attachment = unknown> {
  draft: string
  quotes: Quote[]
  attachments: Attachment[]
}

/** 桶键；会话 id 为空时返回空串（调用方据此跳过读写，绝不写一个没有归属的桶）。 */
export function bucketKey(prefix: string, sessionId: string): string {
  return sessionId ? prefix + sessionId : ''
}

export function readText(store: BucketStore, prefix: string, sessionId: string): string {
  const key = bucketKey(prefix, sessionId)
  if (!key) return ''
  try { return store.getItem(key) ?? '' } catch { return '' }
}

export function writeText(store: BucketStore, prefix: string, sessionId: string, text: string): void {
  const key = bucketKey(prefix, sessionId)
  if (!key) return
  try {
    // 空值删键：否则每个用过一次的会话都会留下一个空串占着 localStorage。
    if (text) store.setItem(key, text)
    else store.removeItem(key)
  } catch { /* 隐私模式：忽略 */ }
}

export function readList<T>(store: BucketStore, prefix: string, sessionId: string): T[] {
  const raw = readText(store, prefix, sessionId)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch { return [] }
}

export function writeList<T>(store: BucketStore, prefix: string, sessionId: string, list: T[]): void {
  const items = Array.isArray(list) ? list : []
  writeText(store, prefix, sessionId, items.length ? JSON.stringify(items) : '')
}

/** 读某个会话的整套输入区。没有桶（新会话 / 从没输入过）就是空。 */
export function loadInput<Quote = unknown, Attachment = unknown>(
  store: BucketStore,
  sessionId: string,
): ComposerInput<Quote, Attachment> {
  return {
    draft: readText(store, DRAFT_PREFIX, sessionId),
    quotes: readList<Quote>(store, QUOTES_PREFIX, sessionId),
    attachments: readList<Attachment>(store, ATTACHMENTS_PREFIX, sessionId),
  }
}

/** 把某个会话的整套输入区落盘（切会话 / 关窗前的 flush）。空项会把对应的键删掉。 */
export function saveInput(store: BucketStore, sessionId: string, input: ComposerInput): void {
  writeText(store, DRAFT_PREFIX, sessionId, input?.draft ?? '')
  writeList(store, QUOTES_PREFIX, sessionId, input?.quotes ?? [])
  writeList(store, ATTACHMENTS_PREFIX, sessionId, input?.attachments ?? [])
}

/** 发送成功 = 这一份已经变成消息：清掉**这个会话**的三个桶。别的会话的桶不动。 */
export function clearInput(store: BucketStore, sessionId: string): void {
  removeBuckets(store, sessionId)
}

/** 会话被删除：清掉它留下的桶（不清就是 localStorage 只涨不跌）。 */
export function dropSessionBuckets(store: BucketStore, sessionId: string): void {
  removeBuckets(store, sessionId)
}

function removeBuckets(store: BucketStore, sessionId: string): void {
  if (!sessionId) return
  for (const prefix of INPUT_PREFIXES) {
    const key = bucketKey(prefix, sessionId)
    if (!key) continue
    try { store.removeItem(key) } catch { /* 忽略 */ }
  }
}
