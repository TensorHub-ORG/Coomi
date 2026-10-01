/**
 * 富块识别层：把 Markdown 里的代码块判成「可预览的富块」。
 *
 * 判定分两步，先看语言标签，标签不认再嗅内容：
 *   1) 语言标签归一（html / svg / js / tsx / mermaid / json / csv / diff / math），别名都收口在这里；
 *   2) 没标签或标签不认时，用极保守的启发式嗅探（宁可判不出，也不要把普通代码误判成 HTML）。
 * 识别不出的一律返回 kind='code'，界面保持现在的普通代码块，不提供预览入口。
 *
 * ── 为什么这里一个回溯型正则都没有（「整屏无响应」的第一类来源）──
 * 老版本用过 `^\$\$[\s\S]*\$\$`（开头锚 + 贪婪任意串 + 结尾锚）、带 m 标志的 `^\s*(import|export)\s`：
 * 这类组合在超长文本上的回溯是 O(n²) 甚至指数级，**一条** 20 万字符的消息就足以按死主线程，
 * 与消息条数、与代码块数量都无关。现在：
 *   - 所有判断都是 indexOf / startsWith / 一次 charCode 扫描，最坏 O(n)，且每个循环里的前瞻都有界；
 *   - 「像什么」的形态判断只看开头 SNIFF_HEAD_CHARS 个字符与结尾一小段，天然有界；
 *   - 逐行判断走 eachLine（最多 SNIFF_LINE_LIMIT 行），绝不 split 整段文本；
 *   - 最后还有一道硬闸：超过 RICH_RECOGNIZE_MAX_CHARS 直接跳过识别，按纯文本渲染（oversized=true）。
 *
 * 这个文件是纯函数，不碰 DOM / 不碰网络，方便单测与排查。
 */
import { OVERSIZED_NOTE, RICH_RECOGNIZE_MAX_CHARS, SNIFF_HEAD_CHARS } from './limits'

export type RichKind = 'html' | 'css' | 'svg' | 'js' | 'tsx' | 'mermaid' | 'json' | 'csv' | 'diff' | 'math' | 'code'

export interface RichDetection {
  kind: RichKind
  /** 归一化后的标签：用于动作条展示与产物扩展名。 */
  lang: string
  /** 是否可以进预览（kind !== 'code'）。 */
  previewable: boolean
  /** 识别依据（动作条徽标的 title）：写清楚「为什么判成它」，排查误判时不用猜。 */
  reason: string
  /** 数学块：剥掉 `$$\u2026$$` 外壳后的正文，供 KaTeX 直接渲染。 */
  math: string
  /** 内容超过识别上限：调用方按纯文本渲染并挂一条轻量标记（见 limits.OVERSIZED_NOTE）。 */
  oversized: boolean
}

/** 语言别名表：键是小写、去空格后的标签。 */
const ALIAS: Record<string, RichKind> = {
  html: 'html', htm: 'html', xhtml: 'html', markup: 'html',
  css: 'css',
  svg: 'svg', 'svg+xml': 'svg',
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', ecmascript: 'js', node: 'js', nodejs: 'js',
  jsx: 'tsx', tsx: 'tsx', react: 'tsx', 'react-dom': 'tsx',
  mermaid: 'mermaid', mmd: 'mermaid',
  json: 'json', jsonc: 'json', json5: 'json', geojson: 'json',
  csv: 'csv', tsv: 'csv',
  diff: 'diff', patch: 'diff',
  math: 'math', latex: 'math', tex: 'math', katex: 'math', formula: 'math', equation: 'math',
}

/** 归一化语言标签：`tsx title=x`、`TSX`、`language-js` 都能落回同一个键。 */
export function normalizeLang(raw: string): string {
  const text = String(raw ?? '').trim().toLowerCase()
  // 等价于 split(/[\s:,;]/)[0]：手写扫描，不建中间数组。
  let end = text.length
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ':' || ch === ',' || ch === ';') { end = i; break }
  }
  let first = text.slice(0, end)
  if (first.startsWith('language-')) first = first.slice('language-'.length)
  // 等价于 replace(/[^a-z0-9+#]/g, '')：只留字母数字与 + #。
  let out = ''
  for (let i = 0; i < first.length; i++) {
    const ch = first[i] ?? ''
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '+' || ch === '#') out += ch
  }
  return out
}

/* ── 直线扫描的小工具（全部有界，无回溯）── */

/** 最多看这么多行：识别只需要「开头像什么」，不需要读完整个块。 */
const SNIFF_LINE_LIMIT = 4_000

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
}

function isWordChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_'
}

function isNameChar(ch: string): boolean {
  return isWordChar(ch) || ch === '$'
}

/** 跳过空白（`\s*` 的线性等价）：从 from 往后扫到第一个非空白。 */
function skipSpace(text: string, from: number): number {
  let i = from
  while (i < text.length && isSpace(text[i] ?? '')) i++
  return i
}

/** 逐行扫描，最多 limit 行；visit 返回 true 就提前结束。不 split 整段文本。 */
function eachLine(text: string, limit: number, visit: (line: string) => boolean | void): boolean {
  let from = 0
  let seen = 0
  while (from <= text.length && seen < limit) {
    const nl = text.indexOf('\n', from)
    const end = nl === -1 ? text.length : nl
    let line = text.slice(from, end)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (visit(line) === true) return true
    seen++
    if (nl === -1) break
    from = nl + 1
  }
  return false
}

/** `^<tag[\s>]` 的线性等价；tag 传小写，text 也必须是已小写的串。 */
function startsWithTag(text: string, tag: string): boolean {
  if (text.charCodeAt(0) !== 60 /* < */) return false
  if (!text.startsWith(tag, 1)) return false
  const next = text[tag.length + 1]
  return next === undefined || next === '>' || isSpace(next)
}

/** `<\/[a-z][\w-]*>\s*$` 的线性等价：从尾部倒着看，不回溯。 */
function endsWithClosingTag(text: string): boolean {
  let i = text.length - 1
  while (i >= 0 && isSpace(text[i] ?? '')) i--
  if (i < 0 || text[i] !== '>') return false
  i--
  const nameEnd = i
  while (i >= 0 && (isWordChar(text[i] ?? '') || text[i] === '-')) i--
  if (i === nameEnd) return false
  const first = text[i + 1] ?? ''
  if (!(first >= 'a' && first <= 'z')) return false
  return text[i] === '/' && text[i - 1] === '<'
}

/** `\bword\b` 的线性等价：找 word 的每一处出现并检查两侧边界。 */
function hasWord(text: string, word: string): boolean {
  let at = text.indexOf(word)
  while (at !== -1) {
    const before = text[at - 1]
    const after = text[at + word.length]
    const leftOk = before === undefined || !isWordChar(before)
    const rightOk = after === undefined || !isWordChar(after)
    if (leftOk && rightOk) return true
    at = text.indexOf(word, at + 1)
  }
  return false
}

/* ── 嗅探 ── */

const HTML_BLOCK_TAGS = ['head', 'body', 'div', 'section', 'main', 'article', 'table', 'ul', 'ol', 'form', 'button', 'canvas', 'video', 'template']

/** Mermaid 首行关键字：带 -v2 / -beta 的整词（左），与允许被 \b 截断的单词（右）。 */
const MERMAID_FULL = new Set([
  'graph', 'flowchart', 'sequencediagram', 'classdiagram', 'statediagram', 'statediagram-v2', 'erdiagram',
  'journey', 'gantt', 'pie', 'gitgraph', 'mindmap', 'timeline', 'quadrantchart', 'requirementdiagram',
  'c4context', 'sankey-beta', 'xychart-beta', 'block-beta',
])
const MERMAID_PLAIN = new Set([
  'graph', 'flowchart', 'sequencediagram', 'classdiagram', 'statediagram', 'erdiagram',
  'journey', 'gantt', 'pie', 'gitgraph', 'mindmap', 'timeline', 'quadrantchart', 'requirementdiagram',
])

const LATEX_COMMANDS = new Set([
  'frac', 'sqrt', 'sum', 'int', 'alpha', 'beta', 'gamma', 'theta', 'pi', 'mathbb', 'mathrm', 'vec', 'hat',
])

const HOOKS = ['useState', 'useEffect', 'useRef', 'useMemo', 'useCallback']
const CONSOLE_METHODS = ['log', 'error', 'warn']
const DECLARATIONS = ['const', 'let', 'var']

/** 从 from 起取一段「字符都在 allow 里」的连续串（长度上限 cap，防止病态输入把这一趟拉长）。 */
function leadingRun(text: string, from: number, cap: number, allow: (ch: string) => boolean): string {
  let i = from
  const end = Math.min(text.length, from + cap)
  while (i < end && allow(text[i] ?? '')) i++
  return text.slice(from, i)
}

function isAlphaNumDash(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-'
}

/** 首行是不是 Mermaid 图类型关键字（`^\s*(graph|flowchart|…)\b` 的线性等价）。 */
function sniffMermaidHead(head: string): boolean {
  let from = 0
  for (let index = 0; index < 4; index++) {
    const nl = head.indexOf('\n', from)
    const end = nl === -1 ? head.length : nl
    const line = head.slice(from, end).trim()
    if (line) return isMermaidHead(line)
    if (nl === -1) return false
    from = nl + 1
  }
  return false
}

function isMermaidHead(line: string): boolean {
  const word = leadingRun(line, 0, 32, isAlphaNumDash)
  if (MERMAID_FULL.has(word)) return true
  const letters = leadingRun(line, 0, 32, (ch) => ch >= 'a' && ch <= 'z')
  if (!MERMAID_PLAIN.has(letters)) return false
  const next = line[letters.length]
  return next === undefined || !isWordChar(next)
}

/** CSV：表头 + 至少一行数据，且分隔符出现次数一致（±1 容忍末列缺失）。只看头几行非空行。 */
function sniffCsv(text: string): { kind: RichKind; reason: string } | null {
  const head: string[] = []
  eachLine(text, SNIFF_LINE_LIMIT, (line) => {
    if (line.trim().length === 0) return false
    head.push(line)
    return head.length >= 6
  })
  if (head.length < 2) return null
  const delim = csvDelimiterOf(head[0] ?? '')
  if (!delim) return null
  const columns = countOutsideQuotes(head[0] ?? '', delim)
  if (columns < 1) return null
  for (let i = 1; i < head.length; i++) {
    if (Math.abs(countOutsideQuotes(head[i] ?? '', delim) - columns) > 1) return null
  }
  return { kind: 'csv', reason: '多行文本的分隔符数量一致（' + (delim === '\t' ? '制表符' : delim) + '）' }
}

/** 猜 CSV 分隔符：列出候选里出现次数最多、且表头至少出现一次的那个。 */
function csvDelimiterOf(header: string): string {
  const candidates = [',', '\t', ';', '|']
  let best = ''
  let bestCount = 0
  for (const delim of candidates) {
    const count = countOutsideQuotes(header, delim)
    if (count > bestCount) { best = delim; bestCount = count }
  }
  // 单个逗号也可能是普通句子：至少两列才认。
  return bestCount >= 1 && best ? best : ''
}

function countOutsideQuotes(line: string, delim: string): number {
  let count = 0
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { quoted = !quoted; continue }
    if (!quoted && ch === delim) count++
  }
  return count
}

/** `^@@ [-+\d, ]+@@` 的线性等价。 */
function isHunkHeader(line: string): boolean {
  let i = 3
  let count = 0
  while (i < line.length) {
    const ch = line[i] ?? ''
    const inside = ch === '-' || ch === '+' || ch === ',' || ch === ' ' || (ch >= '0' && ch <= '9')
    if (!inside) break
    i++
    count++
  }
  return count > 0 && line.startsWith('@@', i)
}

/** `^index [0-9a-f]{7,}` 的线性等价。 */
function isHexRun(line: string, from: number, min: number): boolean {
  let i = from
  while (i < line.length) {
    const ch = line[i] ?? ''
    const hex = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')
    if (!hex) break
    i++
  }
  return i - from >= min
}

/** diff 头 / @@ 块标记（原实现是四个带 m 标志的 ^… 正则，这里逐行做前缀判断）。 */
function sniffDiff(text: string): boolean {
  let previous = ''
  return eachLine(text, SNIFF_LINE_LIMIT, (line) => {
    if (line.startsWith('diff --git ')) return true
    if (previous.startsWith('--- ') && previous.length > 4 && line.startsWith('+++ ')) return true
    if (line.startsWith('@@ ') && isHunkHeader(line)) return true
    if (line.startsWith('index ') && isHexRun(line, 'index '.length, 7)) return true
    previous = line
    return false
  })
}

/** `\\begin{env}`。 */
function hasLatexEnvironment(text: string): boolean {
  let at = text.indexOf('\\begin{')
  while (at !== -1) {
    let i = at + '\\begin{'.length
    const bodyStart = i
    while (i < text.length) {
      const ch = text[i] ?? ''
      if ((ch >= 'a' && ch <= 'z') || ch === '*') i++
      else break
    }
    if (i > bodyStart && text[i] === '}') return true
    at = text.indexOf('\\begin{', at + 1)
  }
  return false
}

/** `\\(frac|sqrt|…)\b`：找反斜杠，取后面的命令名，再要一个词边界。 */
function hasLatexCommand(text: string): boolean {
  let at = text.indexOf('\\')
  while (at !== -1) {
    const name = leadingRun(text, at + 1, 12, (ch) => ch >= 'a' && ch <= 'z')
    if (LATEX_COMMANDS.has(name)) {
      const next = text[at + 1 + name.length]
      if (next === undefined || !isWordChar(next)) return true
    }
    at = text.indexOf('\\', at + 1)
  }
  return false
}

function sniffMath(text: string): boolean {
  if (text.length >= 4 && text.startsWith('$$') && text.endsWith('$$')) return true
  if (hasLatexEnvironment(text)) return true
  return hasLatexCommand(text)
}

/** `^\s*(import|export)\s` 的线性等价：逐行去缩进后再看关键字。 */
function hasModuleStatement(text: string): boolean {
  return eachLine(text, SNIFF_LINE_LIMIT, (line) => {
    let i = 0
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
    const head = line.slice(i, i + 6)
    if (head !== 'import' && head !== 'export') return false
    const next = line[i + 6]
    // 行尾（后面只会是换行）也算 \s：与原来的 m 标志语义一致。
    return next === undefined || isSpace(next)
  })
}

/** `<[A-Z][\w.]*[\s/>]`：找 '<' + 大写字母，再要一个分隔符。 */
function hasJsxTag(text: string): boolean {
  let at = text.indexOf('<')
  while (at !== -1) {
    const first = text[at + 1] ?? ''
    if (first >= 'A' && first <= 'Z') {
      let i = at + 2
      while (i < text.length && (isWordChar(text[i] ?? '') || text[i] === '.')) i++
      const next = text[i]
      if (next === '>' || next === '/' || (next !== undefined && isSpace(next))) return true
    }
    at = text.indexOf('<', at + 1)
  }
  return false
}

/** `use(State|Effect|Ref|Memo|Callback)\s*\(`。 */
function hasHookCall(text: string): boolean {
  for (const hook of HOOKS) {
    let at = text.indexOf(hook)
    while (at !== -1) {
      if (text[skipSpace(text, at + hook.length)] === '(') return true
      at = text.indexOf(hook, at + 1)
    }
  }
  return false
}

/** `console\.(log|error|warn)\s*\(`。 */
function hasConsoleCall(text: string): boolean {
  let at = text.indexOf('console.')
  while (at !== -1) {
    const rest = at + 'console.'.length
    for (const method of CONSOLE_METHODS) {
      if (text.startsWith(method, rest) && text[skipSpace(text, rest + method.length)] === '(') return true
    }
    at = text.indexOf('console.', at + 1)
  }
  return false
}

/** `\b(const|let|var)\s+[\w$]+\s*=`。 */
function hasDeclaration(text: string): boolean {
  for (const keyword of DECLARATIONS) {
    let at = text.indexOf(keyword)
    while (at !== -1) {
      const before = text[at - 1]
      if (before === undefined || !isWordChar(before)) {
        const afterKeyword = skipSpace(text, at + keyword.length)
        if (afterKeyword > at + keyword.length) {
          let i = afterKeyword
          while (i < text.length && isNameChar(text[i] ?? '')) i++
          if (i > afterKeyword && text[skipSpace(text, i)] === '=') return true
        }
      }
      at = text.indexOf(keyword, at + 1)
    }
  }
  return false
}

/** 嗅探：只在语言标签缺失或不认识时调用，顺序即优先级。 */
function sniff(code: string): { kind: RichKind; reason: string } {
  const text = code.trim()
  if (!text) return { kind: 'code', reason: '空代码块' }
  const lower = text.toLowerCase()
  const head = lower.slice(0, SNIFF_HEAD_CHARS)

  // SVG 必须先于 HTML：`<svg>` 也满足「像 HTML」。
  if (startsWithTag(head, 'svg') && lower.includes('</svg>')) return { kind: 'svg', reason: '内容以 <svg> 开头且闭合' }

  if (head.startsWith('<!doctype html') || startsWithTag(head, 'html')) return { kind: 'html', reason: '完整 HTML 文档' }
  for (const tag of HTML_BLOCK_TAGS) {
    if (startsWithTag(head, tag) && endsWithClosingTag(lower)) return { kind: 'html', reason: '以 HTML 标签开头并闭合' }
  }

  const first = text.charCodeAt(0)
  const last = text.charCodeAt(text.length - 1)
  if ((first === 91 /* [ */ || first === 123 /* { */) && (last === 93 /* ] */ || last === 125 /* } */)) {
    try { JSON.parse(text); return { kind: 'json', reason: '内容可被 JSON.parse 解析' } } catch { /* 不是 JSON，继续往下嗅 */ }
  }

  const csv = sniffCsv(text)
  if (csv) return csv

  if (sniffDiff(text)) return { kind: 'diff', reason: '含 diff 头 / @@ 块标记' }
  if (sniffMermaidHead(head)) return { kind: 'mermaid', reason: '首行是 Mermaid 图类型关键字' }
  if (sniffMath(text)) return { kind: 'math', reason: '含 LaTeX 公式标记' }

  if (hasModuleStatement(text) && (text.includes('=>') || hasJsxTag(text) || hasHookCall(text))) {
    return { kind: 'tsx', reason: '含 ES 模块语法与 JSX / React Hook' }
  }
  if (text.includes('=>') || hasWord(text, 'function') || hasDeclaration(text) || hasConsoleCall(text) || text.includes('document.')) {
    return { kind: 'js', reason: '含 JS 语句特征' }
  }

  return { kind: 'code', reason: '没有可用于预览的特征' }
}

/** 数学块外壳剥离：`$$\n x \n$$` → `x`。 */
export function stripMathShell(code: string): string {
  const text = code.trim()
  // 原实现是 ^\$\$[\s\S]*?\$\$$ 这类「首尾锚 + 贪婪任意串」：等价于「首尾都匹配且长度够」，
  // 但不会在 `$$$$$$…` 上回溯爆炸。
  if (text.length >= 4 && text.startsWith('$$') && text.endsWith('$$')) return text.slice(2, -2).trim()
  if (text.length >= 4 && text.startsWith('\\[') && text.endsWith('\\]')) return text.slice(2, -2).trim()
  if (text.length >= 4 && text.startsWith('\\(') && text.endsWith('\\)')) return text.slice(2, -2).trim()
  return text
}

/** 主入口：代码块 → 富块判定。 */
export function detectRichBlock(code: string, rawLang: string): RichDetection {
  const source = String(code ?? '')
  const lang = normalizeLang(rawLang)

  // 长度硬闸：超过上限连标签后的嗅探都不做，直接按纯文本（也就不会有任何正则跑在超长串上）。
  if (source.length > RICH_RECOGNIZE_MAX_CHARS) {
    return { kind: 'code', lang, previewable: false, reason: OVERSIZED_NOTE, math: '', oversized: true }
  }

  const known = ALIAS[lang]

  if (known === 'math') {
    return { kind: 'math', lang: 'math', previewable: true, reason: '语言标签 math/latex', math: stripMathShell(source), oversized: false }
  }
  if (known && known !== 'code') {
    return { kind: known, lang, previewable: true, reason: '语言标签 ' + lang, math: '', oversized: false }
  }

  const guess = sniff(source)
  if (guess.kind === 'code') {
    return { kind: 'code', lang, previewable: false, reason: lang ? '语言标签 ' + lang + ' 没有预览方式' : guess.reason, math: '', oversized: false }
  }
  return {
    kind: guess.kind,
    lang: lang || guess.kind,
    previewable: true,
    reason: lang ? '语言标签 ' + lang + ' + 内容嗅探：' + guess.reason : '内容嗅探：' + guess.reason,
    math: guess.kind === 'math' ? stripMathShell(source) : '',
    oversized: false,
  }
}

/** 富块的展示名（动作条徽标 + 右侧栏标题）。 */
export const KIND_LABEL: Record<RichKind, string> = {
  html: 'HTML',
  css: 'CSS',
  svg: 'SVG',
  js: 'JavaScript',
  tsx: 'React/TSX',
  mermaid: 'Mermaid',
  json: 'JSON',
  csv: 'CSV',
  diff: 'Diff',
  math: 'KaTeX 公式',
  code: '代码',
}

/** 产物扩展名：存为产物 / 下载都按它挑后缀。 */
export const KIND_EXT: Record<RichKind, string> = {
  html: 'html', css: 'css', svg: 'svg', js: 'js', tsx: 'tsx', mermaid: 'mmd',
  json: 'json', csv: 'csv', diff: 'diff', math: 'tex', code: 'txt',
}

/** 预览用 MIME：下载 / 新窗口都以它为准。 */
export const KIND_MIME: Record<RichKind, string> = {
  html: 'text/html', css: 'text/css', svg: 'image/svg+xml', js: 'text/javascript', tsx: 'text/plain',
  mermaid: 'text/plain', json: 'application/json', csv: 'text/csv',
  diff: 'text/plain', math: 'text/plain', code: 'text/plain',
}
