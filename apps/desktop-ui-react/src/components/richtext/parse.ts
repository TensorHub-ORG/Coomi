/**
 * 流式 Markdown 的切块层：纯字符串处理，不碰 React / DOM，方便单测与冒烟。
 *
 * 目的只有一个：别让每个 text_chunk 都把整条消息重新解析一遍。
 * 做法是把文本切成「已定型的块」+「还在长的尾巴」：
 *   - 定型块之间一定隔着一条顶层空行（空行是 Markdown 的块级边界），所以
 *     「逐块解析后拼起来」与「整段一次性解析」结果一致（scripts/smoke-incremental.test.tsx 会逐字比对）；
 *   - 尾巴从「最后一个块」开始（有未闭合围栏时就是那个围栏），每次都重解析。
 *
 * 三条安全规则（宁可少切，也不要把一次解析拆成两次）：
 *   1) 只切在**顶层空行**之后：前一行不是缩进行、后一行缩进 < 4（不然可能切进缩进代码块）；
 *   2) 前缀里不能有未闭合围栏（那会把半截代码块切进前缀，解析出来就是错的）；
 *   3) 边界之后不能只剩「空行 + 半截围栏」：那种半截围栏会被后面的 chunk 重新配对，
 *      把边界卷进一个更大的代码块。这种情况下退回更早的位置 —— 于是有一条更强的性质：
 *
 *      **同一条消息里，定型前缀只会往后长，不会因为新 chunk 到来而缩短或改变内容。**
 *
 *   这正是「稳定子树」能成立的前提：已经交出去的块不会被重新解析、React 也不会重挂。
 *   找不到安全边界就返回 0（整段当尾巴一次解析）—— 正确性永远优先于性能。
 */

export interface FenceInfo {
  /** 起始偏移（围栏所在行的行首）。 */
  start: number
  /** 结束偏移（闭合围栏所在行的行尾 + 换行）。文本被截断时等于文本长度。 */
  end: number
  lang: string
  /** 围栏内部的代码（不含围栏行，保留内部换行）。 */
  code: string
  /** 是否有闭合围栏：false 表示这一块还在流式输出。 */
  closed: boolean
}

/** 一行围栏：``` 或 ~~~，前面最多 3 个空格；~ 围栏的信息串里不许再出现 ~。 */
const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})([^`]*)$/

function parseFenceLine(line: string): { marker: string; info: string } | null {
  const m = FENCE_LINE.exec(line)
  if (!m) return null
  const marker = m[2] ?? ''
  const info = m[3] ?? ''
  if (marker.startsWith('~') && info.includes('~')) return null
  return { marker, info }
}

/** 扫描全文里的围栏代码块：闭合与否都收进来，顺序即出现顺序。 */
export function scanFenceBlocks(text: string): FenceInfo[] {
  const out: FenceInfo[] = []
  let offset = 0
  let from = 0
  let open: { start: number; marker: string; lang: string; bodyStart: number } | null = null
  for (;;) {
    const lineEnd = text.indexOf('\n', from)
    const raw = lineEnd === -1 ? text.slice(from) : text.slice(from, lineEnd)
    const lineStart = offset
    offset += raw.length + 1 // +1 是行尾的换行（最后一行虚拟多出来的那个只用来推进）
    const fence = parseFenceLine(raw)
    if (!open) {
      if (fence) {
        open = { start: lineStart, marker: fence.marker, lang: fence.info.trim().split(/[\s:]/)[0] ?? '', bodyStart: offset }
      }
    } else if (fence && fence.marker[0] === open.marker[0] && fence.marker.length >= open.marker.length && fence.info.trim() === '') {
      out.push({ start: open.start, end: offset, lang: open.lang, code: text.slice(open.bodyStart, lineStart), closed: true })
      open = null
    }
    if (lineEnd === -1) break
    from = lineEnd + 1
  }
  if (open) out.push({ start: open.start, end: text.length, lang: open.lang, code: text.slice(open.bodyStart), closed: false })
  return out
}

/** 最后一段「还在长」的代码块的起始偏移；没有未闭合围栏时返回 null。 */
export function findOpenFenceStart(text: string): number | null {
  const blocks = scanFenceBlocks(text)
  const last = blocks[blocks.length - 1]
  if (last && !last.closed) return last.start
  return null
}

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line)
  return m ? m[0].length : 0
}

function nextLineEnd(text: string, from: number): number {
  const nl = text.indexOf('\n', from)
  return nl === -1 ? text.length : nl
}

/** 尾巴里是否出现过非空行。 */
function hasContentLine(text: string): boolean {
  return /[^\s]/.test(text)
}

export interface SettledSplit {
  /** 可以缓存下来、以后不再重解析的前缀。 */
  settled: string
  /** 每次 text_chunk 都要重解析的尾巴（至少包含最后一个块）。 */
  tail: string
}

/**
 * 主入口：把流式中的 Markdown 切成「定型前缀 + 尾巴」。
 *
 * 一次线性扫描同时跟踪三件事：
 *   - lastUnclosed：当前扫描位置之前那个未闭合围栏的起点（前缀里不能有它，规则 2）；
 *   - candidate：最后一个「顶层空行 + 后文不是半截围栏」的边界（规则 1、3）；
 *   - 候选必须落在 lastUnclosed 之前，否则作废。
 *
 * 结果与「上一次切到哪」无关，只由当前文本决定 —— 所以文本只往后追加时，
 * 定型前缀只增不改（冒烟脚本里有逐步断言）。
 */
export function splitSettled(text: string): SettledSplit {
  if (!text) return { settled: '', tail: '' }
  let boundary = 0
  let lastUnclosed = -1
  let openMarker = ''
  let openLineStart = -1
  let prevIndented = false
  let from = 0

  for (;;) {
    const lineEnd = nextLineEnd(text, from)
    const raw = text.slice(from, lineEnd)
    const lineStart = from
    const next = lineEnd + 1
    const fence = parseFenceLine(raw)

    if (openLineStart < 0) {
      if (fence) {
        openLineStart = lineStart
        openMarker = fence.marker
        // 未闭合围栏之前的候选边界不再安全（规则 2）；从这里开始重新攒候选。
        lastUnclosed = lineStart
      }
    } else if (fence && fence.marker[0] === openMarker[0] && fence.marker.length >= openMarker.length && fence.info.trim() === '') {
      openLineStart = -1
      openMarker = ''
      lastUnclosed = -1
    }

    if (raw.trim() === '') {
      const headEnd = nextLineEnd(text, next)
      const nextIndent = next >= text.length ? 0 : indentOf(text.slice(next, headEnd))
      if (!prevIndented && nextIndent < 4) {
        if (hasContentLine(text.slice(next))) {
          // 规则 1、3 都满足：这是一个稳定边界；但只有它落在未闭合围栏之前才作数（规则 2）。
          if (lastUnclosed < 0 || next <= lastUnclosed) boundary = next
        } else if (lastUnclosed > 0) {
          // 规则 3 不满足（边界之后只剩空行 + 半截围栏）：退回那个围栏的起点。
          if (lastUnclosed > boundary) boundary = lastUnclosed
        }
      }
    }

    prevIndented = indentOf(raw) >= 4
    if (lineEnd === -1) break
    from = next
  }

  if (boundary <= 0) return { settled: '', tail: text }
  return { settled: text.slice(0, boundary), tail: text.slice(boundary) }
}

export interface MarkdownChunk {
  /** 在这一段里的起始偏移：给 React key 用，保证块位置稳定、子树不重挂。 */
  start: number
  text: string
}

/** 把定型前缀切成若干块（每块都以空行收尾）：调用方逐块 memo 渲染即可。 */
export function chunkSettled(text: string): MarkdownChunk[] {
  if (!text) return []
  const out: MarkdownChunk[] = []
  let cursor = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    // 只在「行尾空行 + 下一个字符是行首」的位置切，等价于切在 \n\n 之后。
    if (text.charCodeAt(i + 1) !== 10) continue
    const end = i + 1
    out.push({ start: cursor, text: text.slice(cursor, end) })
    cursor = end
  }
  if (cursor < text.length) out.push({ start: cursor, text: text.slice(cursor) })
  return out
}
