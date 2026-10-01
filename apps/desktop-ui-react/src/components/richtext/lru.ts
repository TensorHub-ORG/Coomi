/**
 * 高亮结果缓存：key = 语言 + 代码内容哈希，LRU 容量 50。
 *
 * 为什么必须有它：流式期间同一个代码块会被反复重渲染，闭环后的内容又常常「看一眼再滑回来」。
 * 没有缓存的话，每次重渲染都要把整段代码重新丢给 shiki（长代码块一次就是几十毫秒，全在主线程），
 * 重复内容（重挂载、滚动回收、重新展开）也就白算了一遍。
 *
 * 这里存的是「已经算出来的结果」（HTML + 行数），不是整块 React 子树：只有真正需要高亮的块
 * 才会进缓存，折叠未展开的块不占用容量。
 * html 为空串表示「这一块被判定为不值得高亮」（超长 / 超预算），note 说明原因 ——
 * 把降级结论也缓存下来，重挂载时不会再白等一次预算。
 */

/** 内容哈希（djb2，够稳够短，不引第三方库；和 store.ts 的 blockId 同一套算法）。 */
export function contentHash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36) + '-' + text.length.toString(36)
}

export interface HighlightEntry {
  /** shiki 产出的 HTML（双主题）；空串表示降级，见 note。 */
  html: string
  /** 代码行数：算高亮时顺手算掉，省得每帧再 split 一次长字符串。 */
  lines: number
  /** 降级原因（超长 / 超预算 / 高亮不可用），界面按纯文本渲染时挂出来。 */
  note?: string
}

/** LRU 容量：50 个块足够覆盖一屏对话，再多就只是白占内存。 */
export const HIGHLIGHT_CACHE_MAX = 50

const cache = new Map<string, HighlightEntry>()

export function highlightKey(lang: string, code: string): string {
  return (lang || 'text') + '\u0000' + contentHash(code)
}

/** 取缓存：命中即把它挪到队尾（最近使用）。 */
export function getHighlight(key: string): HighlightEntry | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

/** 写缓存：超容量就从队首（最久未用）淘汰。 */
export function putHighlight(key: string, entry: HighlightEntry): void {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > HIGHLIGHT_CACHE_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/** 当前缓存条数（排查用；冒烟脚本也用它验证「重复内容不重复高亮」）。 */
export function highlightCacheSize(): number {
  return cache.size
}
