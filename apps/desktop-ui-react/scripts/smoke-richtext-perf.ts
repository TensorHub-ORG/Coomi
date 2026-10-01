/**
 * 富内容卡死冒烟：验证「超长文本 + 异常代码块」下识别 / 切块都还是线性的，
 * 单次处理 < 50ms、不抛异常、不做任何重活。
 *
 * 为什么这几组输入：它们都是老版本正则会「回溯爆炸」的形态 ——
 *   A 20 万字符的多行文本（含围栏、$$、import、@@、Table-snapshot 等特征行）；
 *   B \`$$\` + 20 万个 \`$\`（打 ^\$\$[\s\S]*\$\$$ 这种「首尾锚 + 贪婪任意串」）；
 *   C 20 万个「空白 + 换行」（打带 m 标志的 ^\s*(import|export)\s）；
 *   D 只有反斜杠与 begin{ 的 LaTeX 炸弹；
 *   E use(State|…) 后面拖 10 万个空格（打 \s*\( 这种「前瞻很长」的组合）。
 *
 * 运行（不要 cargo / tauri）：在 apps/desktop-ui-react 下
 *   esbuild scripts/smoke-richtext-perf.ts --bundle --platform=node --format=cjs --outfile=.smoke-build/smoke-richtext-perf.cjs
 *   node .smoke-build/smoke-richtext-perf.cjs
 */
import { detectRichBlock, normalizeLang, stripMathShell } from '../src/components/richtext/detect'
import { chunkSettled, scanFenceBlocks, splitSettled } from '../src/components/richtext/parse'
import { beginSettlePass, settleOnce } from '../src/components/richtext/settle'
import { RICH_BUDGET_MS, RICH_RECOGNIZE_MAX_CHARS, highlightAllowed, runWithBudget, scheduleIdle } from '../src/components/richtext/limits'

const BUDGET_MS = 50

let failures = 0
const problems: string[] = []

function check(ok: boolean, label: string, detail = ''): void {
  if (ok) { console.log('  ok   ' + label); return }
  failures++
  problems.push(label + (detail ? ' :: ' + detail : ''))
  console.log('  FAIL ' + label + (detail ? '\n       ' + detail : ''))
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

/** 跑一次并计时：抛异常 / 超预算都记成失败，但绝不让脚本自己崩掉。 */
function measure(label: string, task: () => void): number {
  const start = now()
  try {
    task()
  } catch (error) {
    failures++
    problems.push(label + ' 抛异常')
    console.log('  FAIL ' + label + ' 抛异常：' + (error instanceof Error ? error.message : String(error)))
    return Number.POSITIVE_INFINITY
  }
  const ms = now() - start
  check(ms < BUDGET_MS, label + ' 单次 ' + ms.toFixed(2) + 'ms < ' + BUDGET_MS + 'ms')
  return ms
}

/* ── 输入构造 ── */

/** A：20 万字符的多行文本，尽量把识别层的每条分支都摆到最坏形态。 */
function hugeMultiline(): string {
  const line = '这是一段普通正文，用来撑长度：' + 'x'.repeat(78)
  const parts: string[] = []
  for (let i = 0; i < 900; i++) {
    parts.push(line)
    if (i % 3 === 0) parts.push('```ts title=example')
    if (i % 3 === 1) parts.push('import React from "react"')
    if (i % 3 === 2) parts.push('const value = ${' + i + '} + "$$" + "?"')
  }
  parts.push('```')
  const text = parts.join('\n')
  return text.length >= 200_000 ? text : text + '\n' + 'y'.repeat(200_000 - text.length)
}

/** 5 个异常代码块：每一个都是某种「会让正则回溯爆炸」的极端形态。 */
const ODD_BLOCKS: Array<{ label: string; lang: string; code: string }> = [
  { label: 'B $$ + 20 万个 $', lang: '', code: '$$' + '$'.repeat(200_000) },
  { label: 'C 20 万个空白 + 换行', lang: '', code: ' \n'.repeat(100_000) },
  { label: 'D LaTeX 反斜杠炸弹', lang: '', code: '\\begin{' + 'a*'.repeat(50_000) },
  { label: 'E useState + 10 万空格', lang: '', code: 'useState' + ' '.repeat(100_000) + '(' },
  { label: 'F 未闭合 HTML 标签海', lang: '', code: '<div '.repeat(30_000) + '>' },
]

/* ── 冒烟 ── */

console.log('用例 1：20 万字符多行文本')
const huge = hugeMultiline()
console.log('  文本长度 ' + huge.length + ' 字符 / ' + (huge.split('\n').length) + ' 行')
check(huge.length >= 200_000, '构造出 20 万字符的多行文本', '实际 ' + huge.length)

measure('detectRichBlock（无标签，超长 → 跳识别）', () => {
  const result = detectRichBlock(huge, '')
  check(result.kind === 'code' && result.previewable === false, '超长内容按纯文本处理（不识别）')
  check(result.oversized === true, '超长内容带 oversized 标记（界面据此挂轻量提示）')
})
measure('detectRichBlock（带 js 标签，超长）', () => {
  const result = detectRichBlock(huge, 'js')
  check(result.oversized === true, '超长内容即使有语言标签也不做识别')
})
measure('splitSettled（切定型前缀）', () => { splitSettled(huge) })
measure('chunkSettled（切块）', () => { chunkSettled(huge) })
measure('scanFenceBlocks（扫围栏）', () => { scanFenceBlocks(huge) })
measure('beginSettlePass + settleOnce（超长不做结算）', () => {
  beginSettlePass(['js\u0000const a = 1'])
  check(settleOnce('js', huge) === false, '超长块一律判为「还在长」（不高亮）')
})

console.log('用例 2：5 个异常代码块')
check(ODD_BLOCKS.length === 5, '异常代码块共 5 个', '实际 ' + ODD_BLOCKS.length)
for (const block of ODD_BLOCKS) {
  console.log('  ── ' + block.label + '（' + block.code.length + ' 字符）')
  measure('  detectRichBlock ' + block.label, () => {
    const result = detectRichBlock(block.code, block.lang)
    check(result.oversized === true, '    标记为 oversized', 'kind=' + result.kind)
    check(result.previewable === false, '    不进预览')
  })
  measure('  stripMathShell ' + block.label, () => { stripMathShell(block.code) })
  measure('  splitSettled ' + block.label, () => { splitSettled(block.code) })
  measure('  chunkSettled ' + block.label, () => { chunkSettled(block.code) })
  measure('  detectRichBlock(lang=math) ' + block.label, () => { detectRichBlock(block.code, 'math') })
}

console.log('用例 3：预算与上限工具本身')
measure('runWithBudget（快任务）', () => {
  const outcome = runWithBudget(() => 42, RICH_BUDGET_MS)
  check(outcome.ok && outcome.value === 42, '预算内任务正常返回')
})
measure('runWithBudget（慢任务 → 丢弃产物）', () => {
  const outcome = runWithBudget(() => { const start = now(); while (now() - start < 230) { /* 空转 230ms */ } return 'slow' }, RICH_BUDGET_MS)
  check(!outcome.ok, '超过 ' + RICH_BUDGET_MS + 'ms 预算的产物被丢弃', 'ms=' + Math.round(outcome.ms))
})
measure('scheduleIdle（可取消）', () => {
  const cancel = scheduleIdle(() => { failures++; problems.push('取消掉的调度仍然执行了'); console.log('  FAIL 取消掉的调度仍然执行了') })
  cancel()
})
check(highlightAllowed('x'.repeat(1_000), 10) === true, '短代码允许高亮')
check(highlightAllowed('x'.repeat(200_000), 10) === false, '超长代码不允许高亮')
check(highlightAllowed('x', 100_000) === false, '超长行数不允许高亮')
check(normalizeLang('  Language-TSX ; title=x ') === 'tsx', '语言标签归一化', normalizeLang('  Language-TSX ; title=x '))
check(RICH_RECOGNIZE_MAX_CHARS === 100_000, '识别上限是 10 万字符')

console.log('')
if (failures) {
  console.log('冒烟失败：' + failures + ' 项')
  for (const problem of problems) console.log(' - ' + problem)
  process.exitCode = 1
} else {
  console.log('冒烟通过：识别 / 切块在 20 万字符与 5 个异常代码块上都在 ' + BUDGET_MS + 'ms 内且未抛异常。')
}
