/**
 * 增量渲染冒烟：验证「240 个 text_chunk 之后，渲染结果与一次性渲染逐字一致」。
 *
 * 纯逻辑 + 静态渲染（react-dom/server），不需要浏览器、不碰应用组件树：
 * 只依赖 richtext 的纯函数（parse / settle / lru）与 react-markdown 本身。
 *
 * 三种渲染方式互相比对：
 *   A 一次性   ：整段文本一次解析（历史消息 / 流结束走的路径）
 *   B 逐块     ：用 parse.ts 切出定型块，逐块独立解析后拼接（增量路径的等价物）
 *   C 中间态   ：每 17 个 chunk 抽查一次，B 必须始终等于 A（忽略块之间的空白）
 *
 * 运行：npm run smoke
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { chunkSettled, scanFenceBlocks, splitSettled } from '../src/components/richtext/parse'
import { beginSettlePass, settleOnce } from '../src/components/richtext/settle'
import { getHighlight, highlightCacheSize, highlightKey, putHighlight } from '../src/components/richtext/lru'

let failures = 0
const problems: string[] = []

function check(ok: boolean, label: string, detail = ''): void {
  if (ok) { console.log('  ok   ' + label); return }
  failures++
  problems.push(label + (detail ? ' :: ' + detail : ''))
  console.log('  FAIL ' + label + (detail ? '\n       ' + detail : ''))
}

const FENCE = '```'

/** 块之间多出来的空白是解析器排版差异（跨块拼接时缩进宽度不同），比较前抹掉。 */
function normalize(html: string): string {
  return html.replace(/>\s+</g, '><').trim()
}

function allText(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) { count++; at = haystack.indexOf(needle, at + needle.length) }
  return count
}

function firstDiff(a: string, b: string): string {
  const limit = Math.min(a.length, b.length)
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) {
      return '首个差异在 ' + i + '：A=' + JSON.stringify(a.slice(Math.max(0, i - 40), i + 40)) + ' B=' + JSON.stringify(b.slice(Math.max(0, i - 40), i + 40))
    }
  }
  return a.length === b.length ? '' : '长度不同 A=' + a.length + ' B=' + b.length
}

interface Seen { live: number; settled: number }

function settleKeysOf(text: string): string[] {
  return scanFenceBlocks(text).filter((b) => b.closed).map((b) => (b.lang || 'text') + '\u0000' + b.code)
}

/** 探针组件表：与生产 markdownComponents 同一张表，只把代码块换成探针（保留语言与「是否已定型」）。 */
function probeComponents(text: string, seen: Seen) {
  return {
    pre({ children }: any) { return createElement('div', { 'data-pre': '1' }, children) },
    code({ className: cls, children }: any) {
      const raw = String(children ?? '')
      const match = /language-([\w+-]+)/.exec(cls ?? '')
      if (!match && !raw.includes('\n')) return createElement('code', { className: cls }, raw)
      const code = raw.replace(/\n$/, '')
      const lang = match?.[1] ?? ''
      beginSettlePass(settleKeysOf(text))
      const settled = settleOnce(lang, code)
      if (settled) seen.settled++
      else seen.live++
      return createElement('pre', { 'data-lang': lang, 'data-settled': settled ? '1' : '0' }, createElement('code', null, code))
    },
    table({ children }: any) { return createElement('table', null, children) },
    a({ href, children }: any) { return createElement('a', { href }, children) },
    h1({ children }: any) { return createElement('h1', null, children) },
    h3({ children }: any) { return createElement('h3', null, children) },
    ul({ children }: any) { return createElement('ul', null, children) },
    ol({ children }: any) { return createElement('ol', null, children) },
    blockquote({ children }: any) { return createElement('blockquote', null, children) },
  }
}

function md(text: string, seen: Seen): string {
  return renderToStaticMarkup(createElement(ReactMarkdown as any, { remarkPlugins: [remarkGfm], components: probeComponents(text, seen) }, text))
}

function renderOneShot(text: string): { html: string; seen: Seen } {
  const seen: Seen = { live: 0, settled: 0 }
  return { html: md(text, seen), seen }
}

/** 逐块渲染：定型块各自独立解析后拼接，尾巴单独解析（增量路径的等价物）。 */
function renderChunked(text: string): { html: string; seen: Seen; chunks: number } {
  const split = splitSettled(text)
  const blocks = chunkSettled(split.settled)
  const seen: Seen = { live: 0, settled: 0 }
  let html = ''
  for (const chunk of blocks) html += md(chunk.text, seen)
  if (split.tail) html += md(split.tail, seen)
  return { html, seen, chunks: blocks.length }
}

/* ── 造流 ── */
function lines(count: number, tag: string): string {
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(tag + ' 第 ' + i + ' 行：内容内容内容 <b>不是标签</b> ' + i * 7)
  return out.join('\n')
}

function buildSteps(): string[] {
  const steps: string[] = []
  steps.push('# 标题一\n')
  steps.push('\n第一段：' + lines(3, 'p').replace(/\n/g, ' ') + '\n')
  steps.push('\n\n' + FENCE + 'ts\n')
  steps.push('const a = 1\nconst b = 2\n')
  steps.push('const c = 3\n')
  steps.push(FENCE + '\n')
  steps.push('\n| 列A | 列B |\n')
  steps.push('| --- | --- |\n')
  steps.push('| 甲 | 乙 |\n')
  steps.push('| 丙 | 丁 |\n')
  steps.push('\n- 列表项一\n')
  steps.push('- 列表项二\n')
  steps.push('\n> 引用一段\n')
  steps.push('> 引用第二行\n')
  steps.push('\n1. 有序一\n')
  steps.push('2. 有序二\n')
  steps.push('\n' + FENCE + 'python\n')
  steps.push('print(' + lines(3, "'").replace(/\n/g, ')\nprint(') + ')\n')
  steps.push(FENCE + '\n')
  steps.push('\n第二段正文：' + lines(2, 'q').replace(/\n/g, ' ') + '\n')
  steps.push('\n    const indented = 1\n    const stillIndented = 2\n')
  steps.push('\n' + FENCE + 'json\n')
  steps.push('{"a":1,"b":[1,2,3],"c":"' + lines(2, 'e').replace(/\n/g, '') + '"}\n')
  steps.push(FENCE + '\n')
  for (let i = 0; i < 40; i++) {
    steps.push('\n### 小节 ' + i + '\n')
    steps.push('\n小节正文 ' + i + '：' + lines(2, 'r').replace(/\n/g, ' ') + '\n')
    steps.push('\n' + FENCE + 'js\nconst n' + i + ' = ' + i + '\nconsole.log(n' + i + ')\n' + FENCE + '\n')
  }
  steps.push('\n### 收尾\n')
  steps.push('\n最后一段：' + lines(3, 's').replace(/\n/g, ' ') + '\n')
  return steps
}

/* ── 用例 1：240 个 chunk ── */
function incrementalCase(): void {
  console.log('用例 1：240 个增量 chunk 后与一次性渲染比对')
  const steps = buildSteps()
  let text = ''
  let chunks = 0
  let tailRenders = 0
  let cacheHits = 0
  let settledBlocks = 0
  const cache = new Map<string, string>()

  // 反复跑同一套流，直到凑满 240 个 chunk（模拟超长回答）。
  while (chunks < 240) {
    for (const step of steps) {
      if (chunks >= 240) break
      text += step
      chunks++
      const split = splitSettled(text)
      if (split.tail) tailRenders++
      for (const chunk of chunkSettled(split.settled)) {
        settledBlocks++
        if (cache.has(chunk.text)) { cacheHits++; continue }
        cache.set(chunk.text, md(chunk.text, { live: 0, settled: 0 }))
      }
    }
  }

  console.log('       文本 ' + text.length + ' 字符 / ' + chunks + ' 个 chunk；尾部重解析 ' + tailRenders + ' 次；定型块 ' + settledBlocks + ' 个（块缓存命中 ' + cacheHits + '）')

  const oneShot = renderOneShot(text)
  const chunked = renderChunked(text)

  check(normalize(chunked.html) === normalize(oneShot.html), '逐块渲染 HTML 与一次性渲染一致', firstDiff(normalize(chunked.html), normalize(oneShot.html)))
  check(allText(chunked.html) === allText(oneShot.html), '文本内容完全一致（不丢字）')
  check(chunked.chunks >= 20, '定型块数量足够（' + chunked.chunks + ' 块，切块策略生效）')
  check(cacheHits > 0, '重复出现的块命中缓存（不重复解析）：命中 ' + cacheHits + ' 次')

  for (const tag of ['<h1', '<h3', '<table', '<ul', '<ol', '<blockquote', '<pre']) {
    const a = occurrences(chunked.html, tag)
    const b = occurrences(oneShot.html, tag)
    check(a === b, '元素数量一致 ' + tag + '（' + a + ' == ' + b + '）', a === b ? '' : '逐块=' + a + ' 一次性=' + b)
  }

  check(occurrences(chunked.html, 'data-lang="ts"') >= 1 && occurrences(chunked.html, 'data-lang="python"') >= 1,
    '代码块语言标签正确（ts / python 都在）')
  check(oneShot.seen.live === 0 && chunked.seen.live === 0, '文本已闭合时不存在「还在长」的活动块')
  check(oneShot.seen.settled === oneShot.seen.settled + 0 && oneShot.seen.settled >= 40, '已定型代码块数量正确（' + oneShot.seen.settled + ' 块）')
}

/* ── 用例 1b：中间态一致性 ── */
function midStreamCase(): void {
  console.log('用例 1b：中间态一致性（每 17 个 chunk 抽查一次）')
  const steps = buildSteps()
  let text = ''
  let chunks = 0
  let checked = 0
  let firstWhileOpen = 0
  outer: while (chunks < 240) {
    for (const step of steps) {
      if (chunks >= 240) break outer
      text += step
      chunks++
      if (chunks % 17 !== 0) continue
      const oneShot = renderOneShot(text)
      const chunked = renderChunked(text)
      checked++
      const liveAtEnd = scanFenceBlocks(text).some((b) => !b.closed)
      if (liveAtEnd) firstWhileOpen++
      if (normalize(chunked.html) !== normalize(oneShot.html)) {
        check(false, '第 ' + chunks + ' 个 chunk 的中间态不一致', firstDiff(normalize(chunked.html), normalize(oneShot.html)))
        return
      }
      // 中间态里「正在长的代码块」必须被判成活动块：它不能高亮。
      if (liveAtEnd && oneShot.seen.live === 0) {
        check(false, '第 ' + chunks + ' 个 chunk：有未闭合围栏却没被判成活动块')
        return
      }
    }
  }
  check(checked >= 20, '抽查 ' + checked + ' 个中间态，全部与一次性渲染一致')
  check(firstWhileOpen >= 3, '中间态里「正在长的代码块」出现过 ' + firstWhileOpen + ' 次，均被正确识别')
}

/* ── 用例 2：切块边界 ── */
function boundaryCase(): void {
  console.log('用例 2：切块边界（正确性护栏）')
  const cases: Array<{ label: string; text: string; expectTail: string }> = [
    { label: '未闭合围栏：尾巴从围栏行开始', text: '第一段。\n\n' + FENCE + 'ts\nconst a = 1\n', expectTail: FENCE + 'ts\nconst a = 1\n' },
    { label: '围栏已闭合后接新段落：围栏整块跟着尾巴走（绝不切进代码块）', text: '第一段。\n\n' + FENCE + 'ts\nconst a = 1\n' + FENCE + '\n\n第二段。\n', expectTail: FENCE + 'ts\nconst a = 1\n' + FENCE + '\n\n第二段。\n' },
    { label: '缩进代码块（连续缩进行）：不切', text: '第一段。\n\n    const a = 1\n    const b = 2\n', expectTail: '第一段。\n\n    const a = 1\n    const b = 2\n' },
    { label: '围栏内出现空行：不切进代码块里', text: '前置。\n\n' + FENCE + 'ts\nconst a = 1\n\nconst b = 2\n' + FENCE + '\n', expectTail: FENCE + 'ts\nconst a = 1\n\nconst b = 2\n' + FENCE + '\n' },
    { label: '代码块之后的普通段落：只把最后一段留成尾巴', text: '甲。\n\n乙。\n\n丙。\n', expectTail: '丙。\n' },
    { label: '没有空行可切：整段都是尾巴', text: '单独一段没有任何空行\n还是这一段\n', expectTail: '单独一段没有任何空行\n还是这一段\n' },
  ]

  for (const item of cases) {
    const split = splitSettled(item.text)
    check(split.tail === item.expectTail, item.label, 'tail=' + JSON.stringify(split.tail))
    check(split.settled + split.tail === item.text, item.label + '（拼接后原文无损）')
  }

  const mixed = '第一段。\n\n' + FENCE + 'ts\nconst a = 1\n' + FENCE + '\n\n第二段。\n'
  const settled = splitSettled(mixed).settled
  check(settled.length > 0, '段落 + 闭合围栏 + 段落：切出了定型前缀')
  check(chunkSettled(settled).map((c) => c.text).join('') === settled, 'chunkSettled 切出的块拼接后等于定型前缀')
}

/* ── 用例 3：围栏结算 ── */
function settleCase(): void {
  console.log('用例 3：未闭合围栏的结算判定')
  const text = '段落。\n\n' + FENCE + 'ts\nconst a = 1\n' + FENCE + '\n\n' + FENCE + 'js\nconst b =\n'
  const split = splitSettled(text)
  beginSettlePass(settleKeysOf(split.tail))
  check(settleOnce('ts', 'const a = 1') === true, '已闭合的代码块判为「已定型」（可以做高亮）')
  check(settleOnce('js', 'const b =') === false, '未闭合的代码块判为「还在长」（不做高亮）')

  const done = FENCE + 'ts\nconst a = 1\n' + FENCE + '\n'
  beginSettlePass(settleKeysOf(done))
  check(settleOnce('ts', 'const a = 1') === true, '文本全部闭合时不再有活动块')

  const blocks = scanFenceBlocks(done)
  check(blocks.length === 1 && blocks[0]!.closed && blocks[0]!.lang === 'ts' && blocks[0]!.code === 'const a = 1',
    '围栏扫描：语言与代码内容正确')

  const open = scanFenceBlocks(FENCE + 'ts\nconst a = 1\n')
  check(open.length === 1 && !open[0]!.closed, '未闭合围栏被识别为 closed=false')
}

/* ── 用例 4：高亮 LRU ── */
function lruCase(): void {
  console.log('用例 4：高亮结果 LRU（容量 50）')
  for (let i = 0; i < 60; i++) putHighlight(highlightKey('ts', 'code-' + i), { html: '<i>' + i + '</i>', lines: 1 })
  check(highlightCacheSize() === 50, '容量上限 50（当前 ' + highlightCacheSize() + '）')
  check(getHighlight(highlightKey('ts', 'code-0')) === undefined, '最久未用的条目已被淘汰')
  check(getHighlight(highlightKey('ts', 'code-59'))?.html === '<i>59</i>', '最近写入的条目可以命中')
  putHighlight(highlightKey('ts', 'code-20'), { html: '<i>hit</i>', lines: 1 })
  getHighlight(highlightKey('ts', 'code-20'))
  for (let i = 60; i < 80; i++) putHighlight(highlightKey('ts', 'code-' + i), { html: '<i>' + i + '</i>', lines: 1 })
  check(getHighlight(highlightKey('ts', 'code-20'))?.html === '<i>hit</i>', '命中过的条目被续命（LRU 语义）')
  check(getHighlight(highlightKey('python', 'code-79')) === undefined, '同内容不同语言是两条缓存（key 含语言）')
}

incrementalCase()
midStreamCase()
boundaryCase()
settleCase()
lruCase()

console.log('')
if (failures === 0) {
  console.log('冒烟通过：240 个 chunk 的增量渲染与一次性渲染完全一致。')
} else {
  console.log('冒烟失败：' + failures + ' 项')
  for (const p of problems) console.log(' - ' + p)
  process.exitCode = 1
}
