/**
 * 「新建但还没发第一条消息」的空会话：可见性规则（纯逻辑，node 可直接跑）。
 *
 * 背景：点「新建对话」时前端就生成了一个会话 id 并连上引擎，引擎那边会立刻多出一条空记录；
 * 而左侧列表在用户真的说出第一句话之前不该为它占一行 —— 那行只会显示「未命名对话」，
 * 点进去还是空的。四条规则：
 *   ① 新建：把 id 记进「未发名单」（落 localStorage，重启后也不会漏），并从列表里滤掉；
 *   ② 首次发送：从名单里摘掉，本地先补一行摘要（标题＝正文第一行），列表立刻出现并高亮；
 *   ③ 新建后没发消息就切走：它继续留在名单里（＝丢弃这条空会话），
 *      草稿桶（coomi.draft.v1.<id>）一个字都不动，按同一个 id 还能恢复；
 *   ④ **列表可见性以引擎数据为准**（见 hasSessionContent）：标题与摘要都没有的会话一律不显示。
 *      ①③ 那份本地名单只认得「这次新建、还没发」的那一条，管不住**老版本留下的空记录**
 *      （它们不在名单里，却以「未命名对话」的样子一直挂在列表上）——所以判据必须落在
 *      「这条会话到底有没有内容」上，名单退化成一条加速与记账的旁路。
 *
 * 这里只放规则本身：读写 localStorage 只经 KeyValueStore 这一个口子（隐私模式不抛），
 * 组件与 store 都不自己实现一份。
 */

/** 「新建未发」名单的键：引擎那边这条空记录还在，没有这份名单它会以「未命名对话」回到列表。 */
export const EMPTY_SESSIONS_KEY = 'coomi.emptySessions.v1'

/** 读写的唯一口子（localStorage 在隐私模式下会抛：实现方自己吞掉）。 */
export interface KeyValueStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** 会话摘要里这份规则用得到的字段（结构性类型：不 import stores 的类型，node 才跑得动）。 */
export interface SessionSummaryLike {
  id: string
  title?: string
  preview?: string
  cwd?: string
  updatedAt?: number
  createdAt?: number
}

/** 名单里存的是 id 数组；读坏了 / 没写过一律按空名单（＝没有隐藏任何会话）。 */
export function readHiddenEmptySessions(store: KeyValueStore): string[] {
  try {
    const raw = store.getItem(EMPTY_SESSIONS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((one): one is string => typeof one === 'string' && one.length > 0)
  } catch { return [] }
}

export function writeHiddenEmptySessions(store: KeyValueStore, ids: Iterable<string>): void {
  try { store.setItem(EMPTY_SESSIONS_KEY, JSON.stringify([...ids])) } catch { /* 隐私模式忽略 */ }
}

/** 界面兜底的默认标题（workspace.ts 的 sessionTitle 在标题 / 摘要都缺时显示的那一个）。
 *  引擎把「新建的空记录」也带上这个标题返回，所以它**不算内容**。 */
export const DEFAULT_SESSION_TITLE = '未命名对话'

/** 这条会话摘要里到底有没有「内容」——列表可见性的唯一判据。
 *
 *  有内容 ⇔ 有 preview，或者 title 非空且不是默认兜底标题「未命名对话」。
 *  反过来说：title 与 preview 都空、或 title 就是那句默认词的，一律按「没有任何内容」处理
 *  （空会话的 title / preview 都是空串，见引擎的 SessionSummary 推导）。
 *  判据落在引擎给的数据上，所以**老版本留下的空记录**（不在本地名单里）也挡得住；
 *  纯函数，node 直接跑，测试喂对象即可。 */
export function hasSessionContent(session: SessionSummaryLike): boolean {
  const preview = typeof session.preview === 'string' ? session.preview.trim() : ''
  if (preview.length > 0) return true
  const title = typeof session.title === 'string' ? session.title.trim() : ''
  return title.length > 0 && title !== DEFAULT_SESSION_TITLE
}

/** 引擎列表 → 该显示的那些。
 *
 *  两条判据，缺一不可：
 *   ① 摘要里得有内容（hasSessionContent）：title / preview 都没有的一律不进列表。
 *      这一条与本地名单无关 —— 老版本留下的空会话正是靠它才不再显示成「未命名对话」。
 *   ② 本地「未发名单」里记着的不显示（新建后一个字都没发）；
 *      一旦它有了内容就说明发过消息了，顺手把过期标记摘掉（healed）放出来。
 *  一条都没被摘掉时**原样返回入参**（同一个数组引用）：列表不该因为一次刷新就整片重渲染。 */
export function splitHiddenSessions<T extends SessionSummaryLike>(
  list: T[], hidden: ReadonlySet<string>,
): { visible: T[]; healed: string[] } {
  const visible: T[] = []
  const healed: string[] = []
  for (const one of list) {
    if (!one.id) { visible.push(one); continue }
    if (!hasSessionContent(one)) continue
    if (hidden.has(one.id)) healed.push(one.id)
    visible.push(one)
  }
  if (!healed.length && visible.length === list.length) return { visible: list, healed }
  return { visible, healed }
}

/** 第一条消息的标题：正文第一行、压掉空白、超长截断（引擎回读后会换成它自己的标题）。 */
export function firstMessageTitle(text: string, max = 42): string {
  const line = String(text ?? '').split('\n').map((one) => one.trim()).find((one) => one.length > 0) ?? ''
  const flat = line.replace(/\s+/g, ' ')
  return flat.length > max ? flat.slice(0, Math.max(1, max - 1)) + '…' : flat
}

/** 第一条消息发出去后本地补的那一行摘要：列表立刻出现它（高亮照旧按当前会话比对）。 */
export function firstMessageSummary(id: string, text: string, cwd: string, now: number): SessionSummaryLike {
  const title = firstMessageTitle(text)
  return { id, title, preview: title, cwd, updatedAt: now, createdAt: now }
}
