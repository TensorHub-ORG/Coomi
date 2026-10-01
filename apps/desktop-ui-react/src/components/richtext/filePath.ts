/**
 * 文件路径的识别与解析（纯函数，不碰 DOM / 不碰网络，方便单测与冒烟）。
 *
 * 这里只做一件事：从**一段普通文本**里切出「看起来是文件路径」的片段，并把它解析成绝对路径。
 * 三条口径，与 detect.ts 的「宁可判不出，也不误判」一脉相承：
 *
 *   1) **全是线性扫描，没有一个回溯型正则**。所有循环的前瞻都有界，最坏 O(n)；
 *      一条 20 万字符的正文也不会因为这里把主线程按死。
 *   2) **只在「非路径字符」之后起头**（scanPaths 的 startsCandidate）：从单词中间切开
 *      （`foo/bar.ts` 只认出 `bar.ts`）比认不出更糟。
 *   3) **认得保守**：
 *      · 绝对路径（`C:\…`、`/…`、`\\server\share\…`、`~/…`）只要有内容就收；
 *      · 相对路径必须**同时**带分隔符与末段扩展名（`src/a.ts` 收，`and/or`、`24/7`、`a/b` 不收）；
 *      · 含空格 / 中文的路径一律不认——正文里「空格后面跟的是不是路径」无法判定，
 *        宁可漏认，也不能把一整句话吃进芯片。
 *
 * 解析（resolvePath）：绝对路径原样归一化；`~/…` 换成引擎给的 home；其余按当前会话工作目录拼接。
 */

export interface PathSpan {
  /** 在原文里的起始下标（含）。 */
  start: number
  /** 在原文里的结束下标（不含）。 */
  end: number
  /** 原文里那一段（未解析、未归一化）。 */
  raw: string
}

/* ── 字符类：三条判定全部是 charCode 比较，没有正则 ── */

function isAlphaNum(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
}

function isSep(ch: string): boolean {
  return ch === '/' || ch === '\\'
}

/** 允许出现在路径「名字」里的字符：字母数字 _ - . + @ $ % & # ( ) [ ] { } ^ ~ */
function isNameChar(ch: string): boolean {
  if (!ch) return false
  if (isAlphaNum(ch)) return true
  return ch === '_' || ch === '-' || ch === '.' || ch === '+' || ch === '@'
    || ch === '$' || ch === '%' || ch === '&' || ch === '#' || ch === '~'
    || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}'
    || ch === '^'
}

function isPathChar(ch: string): boolean {
  return isSep(ch) || isNameChar(ch)
}

/** 结尾要剥掉的「句读」：这些字符本身合法，但出现在句尾时几乎总是标点而不是路径的一部分。 */
const TRIM_TAIL = '.!^~)]}'

function trimTail(text: string, start: number, end: number): number {
  let i = end
  while (i > start && TRIM_TAIL.indexOf(text[i - 1] ?? '') !== -1) i--
  return i
}

/* ── 扫描 ── */

/** i 处能不能作为一段路径的起头：必须紧跟在「非路径字符」之后，且首字符本身要像路径。 */
function startsCandidate(text: string, i: number): boolean {
  const ch = text[i] ?? ''
  if (!ch) return false
  const before = text[i - 1]
  // 前一个字符也是路径字符 → 这是单词中间，不能起头。
  if (before !== undefined && isPathChar(before)) return false
  if (ch === '~') return text[i + 1] === '/' || text[i + 1] === '\\'
  if (ch === '/') {
    // '//' 可能是协议相对 URL，'://' 前面是 ':'（不是路径字符，靠上面的判断拦不住），这里显式排除。
    if (text[i + 1] === '/') return false
    return text[i - 1] !== ':'
  }
  if (ch === '\\') return text[i + 1] === '\\'
  return isAlphaNum(ch) || ch === '.'
}

/** 从 start 往后吃一段「路径字符」：盘符 / UNC 前缀特殊处理，':' 不出现在普通片段里。 */
function scanRun(text: string, start: number): number {
  const len = text.length
  let i = start
  if (isAlphaNum(text[i] ?? '') && text[i + 1] === ':' && isSep(text[i + 2] ?? '')) i += 3
  else if (text[i] === '\\' && text[i + 1] === '\\') i += 2
  while (i < len && isPathChar(text[i] ?? '')) i++
  return i
}

/** 末段是不是带扩展名（`.rs` / `.tar.gz` 都算；纯数字扩展名不算错，但最多 8 位）。 */
function hasExtension(path: string): boolean {
  const name = lastSegment(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false
  const ext = name.slice(dot + 1)
  if (!ext || ext.length > 8) return false
  for (let i = 0; i < ext.length; i++) if (!isAlphaNum(ext[i] ?? '')) return false
  return true
}

function hasSep(path: string): boolean {
  for (let i = 0; i < path.length; i++) if (isSep(path[i] ?? '')) return true
  return false
}

function lastSegment(path: string): string {
  let end = path.length
  while (end > 0 && isSep(path[end - 1] ?? '')) end--
  let start = end
  while (start > 0 && !isSep(path[start - 1] ?? '')) start--
  return path.slice(start, end)
}

/** `C:\` / `D:/`：盘符必须是字母（`1:\a` 不是路径）。 */
function hasDrivePrefix(path: string): boolean {
  const first = path[0] ?? ''
  const letter = (first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z')
  return letter && path[1] === ':' && isSep(path[2] ?? '')
}

/** 一个候选片段到底像不像路径（保守判定的唯一出口）。 */
export function looksLikePath(raw: string): boolean {
  const text = String(raw ?? '').trim()
  if (text.length < 3) return false
  // 带协议的一律不是本地路径（http://… / file://… 由 Markdown 的链接层处理）。
  if (text.indexOf('://') !== -1) return false
  if (hasDrivePrefix(text)) return text.length > 3
  if (text.startsWith('\\\\')) return text.length > 2
  if (text.startsWith('~/') || text.startsWith('~\\')) return text.length > 2
  if (text.startsWith('/')) {
    // POSIX 绝对：至少两段，或者末段带扩展名（`/tmp` 这种单段目录不认，正文里太容易误判）。
    if (text.startsWith('//')) return false
    return text.indexOf('/', 1) !== -1 || hasExtension(text)
  }
  // 相对路径：分隔符 + 末段扩展名，缺一不可。
  if (!hasSep(text)) return false
  return hasExtension(text)
}

/** 扫描一段文本，返回其中所有「像文件路径」的片段（按出现顺序，互不重叠）。 */
export function scanPaths(text: string): PathSpan[] {
  const out: PathSpan[] = []
  const source = String(text ?? '')
  const len = source.length
  let i = 0
  while (i < len) {
    if (!startsCandidate(source, i)) { i++; continue }
    const end = scanRun(source, i)
    const stop = trimTail(source, i, end)
    if (stop > i) {
      const raw = source.slice(i, stop)
      if (looksLikePath(raw)) out.push({ start: i, end: stop, raw })
    }
    i = end > i ? end : i + 1
  }
  return out
}

/* ── 解析 ── */

/** `C:\…` / `\\server\…` / `/…`。 */
export function isAbsolutePathText(path: string): boolean {
  const text = String(path ?? '').trim()
  return hasDrivePrefix(text) || text.startsWith('\\\\') || text.startsWith('/')
}

/** `~/…` / `~\…`。 */
export function isHomePathText(path: string): boolean {
  const text = String(path ?? '').trim()
  return text.startsWith('~/') || text.startsWith('~\\')
}

/** 拼接（只补一个分隔符，不做归一化）。 */
export function joinRawPath(dir: string, name: string): string {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  if (!base) return String(name ?? '')
  const sep = base.indexOf('\\') !== -1 ? '\\' : '/'
  return base + sep + String(name ?? '')
}

/** 归一化：折叠 `.` / `..` 与重复分隔符，保留盘符 / UNC / 前导斜杠。 */
export function normalizePath(path: string): string {
  const text = String(path ?? '').trim()
  if (!text) return ''
  const windows = hasDrivePrefix(text) || text.startsWith('\\\\') || text.indexOf('\\') !== -1
  const sep = windows ? '\\' : '/'
  let head = ''
  let body = text
  if (hasDrivePrefix(text)) {
    head = text.slice(0, 2) + sep
    body = text.slice(3)
  } else if (text.startsWith('\\\\')) {
    head = sep + sep
    body = text.replace(/^[\\/]+/, '')
  } else if (text.startsWith('/')) {
    head = sep
    body = text.replace(/^[/]+/, '')
  }
  const stack: string[] = []
  for (const segment of body.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (stack.length && stack[stack.length - 1] !== '..') stack.pop()
      else if (!head) stack.push('..')
      continue
    }
    stack.push(segment)
  }
  return head + stack.join(sep)
}

/**
 * 把正文里认出来的路径解析成绝对路径（引擎的 /api/fs/* 只吃绝对路径）。
 * 解析不出来（相对路径但不知道工作目录）时返回空串，调用方据此降级成「只能复制」。
 */
export function resolvePath(raw: string, cwd: string, home: string): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (isAbsolutePathText(text)) return normalizePath(text)
  if (isHomePathText(text)) {
    const rest = text.slice(2)
    return home ? normalizePath(joinRawPath(home, rest)) : ''
  }
  return cwd ? normalizePath(joinRawPath(cwd, text)) : ''
}

/** 展示用的短路径：超过 max 个字符就把中间省略掉，头尾都留着（头是盘符 / 根，尾是文件名）。 */
export function shortenPath(path: string, max = 42): string {
  const text = String(path ?? '')
  if (text.length <= max) return text
  const keep = Math.max(4, Math.floor((max - 1) / 2))
  return text.slice(0, keep) + '…' + text.slice(text.length - keep)
}
