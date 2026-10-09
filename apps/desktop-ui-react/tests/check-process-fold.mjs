#!/usr/bin/env node
/**
 * 过程折叠（对标 DSH 的 Turn process）的源码护栏。
 *
 * 背景：旧实现把「思考 + 工具调用」的折叠区渲染在正文**下方**，与本文件早先写下的
 * 顺序注释（思考 → 正文 → 工具）正好相反；用了工具的轮次还会走另一条分支，思考直接不显示。
 * 现在改成：**过程整块折在答案上方，答案独立在后且永不参与折叠**。
 *
 * 这一组断言守的就是那个顺序 —— 它是纯结构事实，单测跑不到，只能在源码层面钉住。
 * 运行：node tests/check-process-fold.mjs
 */
import { readFileSync } from 'node:fs'

let failed = 0
let total = 0
function ok(name, condition, detail) {
  total += 1
  if (condition) return
  failed += 1
  console.error('FAIL ' + name + (detail === undefined ? '' : '\n  ' + detail))
}
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const list = read('../src/components/chat/MessageList.tsx')
const block = read('../src/components/chat/ProcessBlock.tsx')
const chat = read('../src/lib/chat.ts')
const css = read('../src/styles/base.css')

/* ── 顺序：过程在答案之前 ── */
const procAt = list.indexOf('{hasProcess ? (')
const ansAt = list.indexOf('{hasAnswer ? (')
ok('过程折叠块渲染在答案之前', procAt > 0 && ansAt > procAt, 'procAt=' + procAt + ' ansAt=' + ansAt)
ok('答案渲染的是 splitProcessAnswer 的结果', list.includes('<Markdown text={answer} streaming={item.streaming} />'))
ok('助手消息不再自己拼 segments', !list.includes('const renderSegments') && !list.includes('renderToolGroup'))
ok('旧的「挂在正文下方」写法已不存在', !list.includes('挂在正文**下方**'))

/* ── 判据本身 ── */
ok('分离判据在 lib 里（可单跑）', chat.includes('export function splitProcessAnswer'))
ok('分离返回 answer 与 members', /return \{ answer: last\.text, members: segments\.slice\(0, -1\) \}/.test(chat))

/* ── 过程体 ── */
ok('过程体按事件顺序渲染 members', block.includes('list.map((member, index)') && block.includes('member.callIds'))
ok('过程体的工具组走 ToolCallList', block.includes('<ToolCallList'))
ok('运行中强制展开且不可折叠', block.includes('const shown = running || open') && block.includes('const canCollapse = hasContent && !running'))

/* ── 折叠隐藏方式（DSH 的 until-found）── */
ok('折叠体用 useSearchableHidden', block.includes('useSearchableHidden(settledClosed, reveal)'))
ok('收起动画播完才移交 until-found', block.includes('COLLAPSE_FREEZE_MS'))
ok('CSS 让开收起态的 visibility，否则 find-in-page 命不中', css.includes(".collapse[data-until-found='1']"))

if (failed) {
  console.error('\n' + failed + '/' + total + ' 条断言失败')
  process.exit(1)
}
console.log('OK  ' + total + ' 条断言全部通过（过程在答案之前 / 答案独立 / until-found 折叠）')
