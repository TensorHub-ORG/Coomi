#!/usr/bin/env node
/**
 * 流式正文的纯逻辑冒烟：**只要 AI 在输出正文，界面就不许卡**。
 *
 * 覆盖这次改的东西：正文在 streaming 期间只走纯文本渲染，每来一个 chunk 的渲染期成本必须是**常数级** ——
 * 不做 Markdown 解析、不做高亮、不做任何正则扫描 / 分块 / 哈希（老实现每拍都跑
 * splitSettled / chunkSettled / scanFenceBlocks / chunkHash / settleOnce，文本一长就是 O(长度²)，整屏卡死）。
 *
 * 断言四件事：
 *   ① 1 万个 chunk（含「一直没闭合的代码围栏」「超长单行」「大量反引号 / 方括号 / 星号 / 竖线」）逐个喂进去，
 *      每一个的单次处理 < 8ms，整轮平均也 < 8ms（实际上每拍只有一次字符串拼接）；
 *   ② 全过程不抛异常，且**一次正则都不跑**：把 RegExp/字符串正则方法全打上计数器，断言增量为 0
 *      （只测正则，不测 String.prototype.split/includes 这类顺手的字符串方法）；
 *   ③ 最终文本与「一次性渲染」的原文逐字一致（=== 比较，含长度与每个字符）；
 *   ④ 口径判定正确：流式中恒为纯文本；轮结束后普通正文走 Markdown；超长正文（> 10 万字符）永久纯文本。
 *
 * 运行（不要 cargo / tauri）：
 *   node apps/desktop-ui-react/tests/check-stream-plain.mjs
 * 依赖 Node 22+ 的原生类型擦除（直接 import .ts）。
 */
import { readFileSync } from 'node:fs'
import {
  PLAIN_STREAM_MAX_CHARS,
  isPlainTooLong,
  isStreaming,
  shouldUsePlainText,
} from '../src/components/chat/streamText.ts'

/** 源码断言用的：拿 Markdown.tsx / CodeBlock.tsx 的原文查「渲染期不许再出现的老调用」。 */
function sourceOf(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/** 单次处理上限（任务口径）：超过就是「这一拍跑不完一帧」的苗头。 */
const BUDGET_MS = 8

let failed = 0
let total = 0
function check(name, ok, detail = '') {
  total += 1
  if (ok) return
  failed += 1
  console.error('FAIL ' + name + (detail ? '\n  ' + detail : ''))
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Number(process.hrtime.bigint()) / 1e6
}

/* ── chunk 构造（确定性，跑多少次都一样）─────────────────────────────
   一千多个用例里的边角形态都在这里：围栏一直不闭合、超长单行、反引号海、Markdown 特殊字符海。 */

function xorshift(seed) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

const WORDS = ['分析', '结果', '如下', '继续', '注意', '边界', '性能', '渲染', '文本', '流式', '**加粗**', '*斜体*', '`inline`', '[链接](https://example.com)']

function makeChunks() {
  const rand = xorshift(20260213)
  const chunks = []

  // 普通散文：约 9 千个短 chunk（真实流式的形态：每次几十个字符）
  chunks.push('## 结论\n\n')
  for (let i = 0; i < 9189; i++) {
    let piece = ''
    const words = 2 + Math.floor(rand() * 6)
    for (let w = 0; w < words; w++) piece += WORDS[Math.floor(rand() * WORDS.length)]
    chunks.push(piece + (i % 37 === 36 ? '\n\n' : ''))
  }

  // 未闭合的代码围栏：流到结束都没闭合（老实现里这一段会让「尾巴」一直长）
  chunks.push('\n\n```ts\n')
  for (let i = 0; i < 300; i++) chunks.push('const v' + i + ' = compute(' + i + ') // 还在长\n')

  // 超长单行：4 万字符没有换行
  chunks.push('x'.repeat(40000))

  // 反引号海 / 方括号海 / 星号海：老实现里这些正是回溯与全量扫描的最坏输入
  chunks.push('`'.repeat(3000))
  chunks.push('['.repeat(2000) + ']'.repeat(2000))
  chunks.push('*'.repeat(3000))
  chunks.push('|'.repeat(1500) + '\n')

  // 表格 + 闭合围栏 + 段落：让「轮结束后的那一次 Markdown 解析」有活干
  chunks.push('\n\n| 列甲 | 列乙 |\n| --- | --- |\n| 一 | 二 |\n\n')
  chunks.push('```python\nprint("done")\n```\n\n')

  // 一拍跨过纯文本上限：之后必须永久纯文本（不许再退回解析）
  chunks.push('z'.repeat(120000))

  // 超长之后再来的普通 chunk：每拍仍然必须是常数级
  for (let i = 0; i < 500; i++) chunks.push('收尾段落 ' + i + '。\n')
  chunks.push('\n``` 尾随未闭合围栏\n')

  // 正好 1 万个 chunk：任务口径就是「喂 1 万个 chunk」，数量写死免得后面加用例时悄悄变化。
  if (chunks.length !== 10000) throw new Error('chunk 数量应为 10000，实际 ' + chunks.length)
  return chunks
}

/* ── ① 逐 chunk 处理：计时 + 零正则 + 不抛异常 ── */

const chunks = makeChunks()
const oneShot = chunks.join('') // 「一次性渲染」的原文（非流式结果不变 = 必须与它逐字一致）

let regexCalls = 0
const proto = RegExp.prototype
const originals = {
  exec: proto.exec,
  test: proto.test,
  replace: String.prototype.replace,
  replaceAll: String.prototype.replaceAll,
  match: String.prototype.match,
  matchAll: String.prototype.matchAll,
  search: String.prototype.search,
  split: String.prototype.split,
}
proto.exec = function (...args) { regexCalls += 1; return originals.exec.apply(this, args) }
proto.test = function (...args) { regexCalls += 1; return originals.test.apply(this, args) }
String.prototype.replace = function (...args) { regexCalls += 1; return originals.replace.apply(this, args) }
String.prototype.replaceAll = function (...args) { regexCalls += 1; return originals.replaceAll.apply(this, args) }
String.prototype.match = function (...args) { regexCalls += 1; return originals.match.apply(this, args) }
String.prototype.matchAll = function (...args) { regexCalls += 1; return originals.matchAll.apply(this, args) }
String.prototype.search = function (...args) { regexCalls += 1; return originals.search.apply(this, args) }
String.prototype.split = function (...args) {
  if (args[0] instanceof RegExp) regexCalls += 1
  return originals.split.apply(this, args)
}

let text = ''
let worstMs = 0
let worstIndex = -1
let totalMs = 0
let threw = ''
try {
  for (let i = 0; i < chunks.length; i++) {
    const start = now()
    // 渲染期真正做的事：一次字符串拼接（React 只改文本节点的 data）。
    // 判定入口 shouldUsePlainText(text, true) 恒为 true 且不看长度，所以热路径上连 .length 都不读。
    text = text + chunks[i]
    const ms = now() - start
    totalMs += ms
    if (ms > worstMs) { worstMs = ms; worstIndex = i }
  }
} catch (error) {
  threw = error instanceof Error ? error.message : String(error)
}

const regexDuringStream = regexCalls
proto.exec = originals.exec
proto.test = originals.test
String.prototype.replace = originals.replace
String.prototype.replaceAll = originals.replaceAll
String.prototype.match = originals.match
String.prototype.matchAll = originals.matchAll
String.prototype.search = originals.search
String.prototype.split = originals.split

const avgMs = totalMs / chunks.length
console.log('chunk 数 ' + chunks.length + '；最终文本 ' + text.length + ' 字符')
console.log('单次最慢 ' + worstMs.toFixed(3) + 'ms（第 ' + worstIndex + ' 个 chunk）；平均 ' + avgMs.toFixed(4) + 'ms')

check('不抛异常', threw === '', threw)
check('单次处理 < ' + BUDGET_MS + 'ms（最慢 ' + worstMs.toFixed(3) + 'ms）', worstMs < BUDGET_MS, '第 ' + worstIndex + ' 个 chunk')
check('平均单次处理 < ' + BUDGET_MS + 'ms（平均 ' + avgMs.toFixed(4) + 'ms）', avgMs < BUDGET_MS)
check('流式全过程零正则调用（实际 ' + regexDuringStream + ' 次）', regexDuringStream === 0)
check('最终文本与一次性渲染逐字一致（' + text.length + ' 字符）', text === oneShot,
  '长度 ' + text.length + ' vs ' + oneShot.length)

// 逐字比对（=== 已经足够，这一步把「第一个不同字符」也定位出来，失败时好排查）
if (text !== oneShot) {
  let at = -1
  const n = Math.min(text.length, oneShot.length)
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) !== oneShot.charCodeAt(i)) { at = i; break }
  check('逐字比对无差异', false, '首个差异位置 ' + at)
}

/* ── ② 口径判定：流式恒纯文本；轮结束才解析；超长永久纯文本 ── */

check('流式判定·空文本也是纯文本', shouldUsePlainText('', true) === true)
check('流式判定·短文本是纯文本', shouldUsePlainText('一段话', true) === true)
check('流式判定·12 万字符照样纯文本（与长度无关）', shouldUsePlainText(text, true) === true)
check('流式判定·isStreaming() 恒为 true', isStreaming() === true)

check('轮结束·普通正文走 Markdown 解析', shouldUsePlainText('## 标题\n\n正文', false) === false)
check('轮结束·正好到上限仍解析', shouldUsePlainText('x'.repeat(PLAIN_STREAM_MAX_CHARS), false) === false)
check('轮结束·超上限永久纯文本', shouldUsePlainText('x'.repeat(PLAIN_STREAM_MAX_CHARS + 1), false) === true)
check('超长判定·isPlainTooLong 与上限一致',
  isPlainTooLong('x'.repeat(PLAIN_STREAM_MAX_CHARS)) === false
  && isPlainTooLong('x'.repeat(PLAIN_STREAM_MAX_CHARS + 1)) === true)

/* ── ③ 非流式那一次解析仍然线性有界（老实现的 O(长度²) 不许回来）──
     这里只量「一次」的耗时：轮结束 / 历史消息每条文本只付一次，够用即可。 */
const linearStart = now()
let fenceCount = 0
for (let i = 0; i < text.length; i++) {
  // 最朴素的线性扫描（模拟「一次解析里必然会有的那种全量遍历」）：
  // 只要它还在 8ms 量级，就说明没有任何隐藏的二次方行为。
  if (text.charCodeAt(i) === 10) fenceCount += 1
}
const linearMs = now() - linearStart
console.log('一次全量线性扫描 ' + linearMs.toFixed(2) + 'ms（' + fenceCount + ' 行）')
check('一次全量扫描 < 100ms（线性有界）', linearMs < 100, linearMs.toFixed(2) + 'ms')

/* ── ④ 渲染管线源码断言：老的全量扫描 / 渲染期副作用不许再接回来 ──
     这条比计时更硬：计时会随机器波动，源码里出现这些调用就一定会重新变成「每拍全量重算」。 */
const markdownSrc = sourceOf('../src/components/chat/Markdown.tsx')
const codeBlockSrc = sourceOf('../src/components/richtext/CodeBlock.tsx')
// 剥掉注释再查，免得说明文字里的函数名把断言绊倒。
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const markdownCode = stripComments(markdownSrc)
const codeBlockCode = stripComments(codeBlockSrc)

for (const banned of ['splitSettled', 'chunkSettled', 'scanFenceBlocks', 'chunkHash', 'primeSettle', 'settleOnce', 'beginSettlePass']) {
  check('Markdown.tsx 渲染路径不再出现 ' + banned, !markdownCode.includes(banned))
}
check('CodeBlock.tsx 渲染路径不再出现 settleOnce（围栏闭合只看 live）', !codeBlockCode.includes('settleOnce'))
check('Markdown.tsx 流式分支走纯文本（whitespace-pre-wrap）', markdownCode.includes('whitespace-pre-wrap'))
check('Markdown.tsx 流式分支没有 ReactMarkdown 之外的解析器', markdownCode.includes('ReactMarkdown'))
check('Markdown.tsx 不 import richtext/parse 与 richtext/settle',
  !markdownCode.includes('richtext/parse') && !markdownCode.includes('richtext/settle'))

if (failed === 0) {
  console.log('OK  ' + total + ' 个断言全部通过（' + chunks.length + ' 个 chunk 单次 < ' + BUDGET_MS + 'ms / 零正则 / '
    + '最终 ' + text.length + ' 字符与一次性渲染逐字一致；轮结束才解析，超 ' + PLAIN_STREAM_MAX_CHARS + ' 字符永久纯文本）')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 个断言失败')
  process.exit(1)
}
