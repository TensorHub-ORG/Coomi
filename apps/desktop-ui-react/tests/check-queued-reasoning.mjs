#!/usr/bin/env node
/**
 * 排队插话与思考保真的回归断言。
 *
 * 真机事故：用户发的问题与 AI 的回答「对不上」，思考过程看着「消失」。
 * 根因（chat.ts）：
 *   · findCurrentAssistant 会跳过带「排队中」标记的用户条目；
 *   · 而摘标记的判据是**正文完全相等**，只要有一字之差（技能前缀 / 引用改写 / 空白）
 *     就永远摘不掉 → 新一轮正文与思考被追加到**上一轮的助手条目**上。
 *
 * 运行：node tests/check-queued-reasoning.mjs
 */
import { applyHistoryItems, clearQueuedUserItems, collapseAssistantCopies } from '../src/lib/chat.ts'

let failed = 0
let total = 0
function check(name, got, want) {
  total += 1
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed += 1
    console.error('FAIL ' + name + '\n  want=' + JSON.stringify(want) + '\n  got =' + JSON.stringify(got))
  }
}

const user = (id, text, queued) => ({ kind: 'user', id, text, at: 1, ...(queued ? { queued: true } : {}) })
const asst = (id, text, extra = {}) => ({ kind: 'assistant', id, text, tools: [], segments: [], streaming: false, reasoningStreaming: false, ...extra })

/* ① 正文对不上时，按队列顺序摘**最早**那条（这正是引擎"下一条排队消息开跑了"的语义） */
const q1 = [user('u1', '第一条', false), user('u2', '排队一', true), user('u3', '排队二', true)]
check('①·正文对不上 → 摘最早那条排队消息', clearQueuedUserItems(q1, '引擎说的正文和本地不完全一样').map((i) => i.kind === 'user' ? (i.queued ? 'Q' : 'N') : '-'), ['N', 'N', 'Q'])
check('①·只摘一条，第二条仍排队', clearQueuedUserItems(q1, '完全不一致').filter((i) => i.queued).length, 1)

/* ② 正文完全一致时优先摘它（保持原有语义） */
const q2 = [user('u1', '排队一', true), user('u2', '排队二', true)]
check('②·正文命中 → 摘对应的那一条', clearQueuedUserItems(q2, '排队二').map((i) => i.queued ? 'Q' : 'N'), ['Q', 'N'])

/* ③ 不给正文 → 全部摘掉（引擎清空队列） */
check('③·不给正文 → 全部摘掉', clearQueuedUserItems(q2).filter((i) => i.queued).length, 0)

/* ④ 没有排队条目时原样返回（引用稳定，不触发多余重渲染） */
const none = [user('u1', 'x', false)]
check('④·无排队条目 → 原数组引用不变', clearQueuedUserItems(none, 'y') === none, true)

/* ⑤ 回读时历史那条没有思考、本地有 → 思考必须保住（否则界面「思考消失」） */
const localWithReasoning = [
  { kind: 'user', id: 'u1', text: '问', at: 1 },
  asst('e2', '答', { reasoning: '本地流式里拿到的思考', streaming: true }),
]
const histWithout = [
  { kind: 'user', id: 'h1', msgId: 'h1', text: '问', at: 1 },
  { kind: 'assistant', id: 'h2', msgId: 'h2', text: '答', tools: [], segments: [], streaming: false, reasoningStreaming: false },
]
const merged = applyHistoryItems(localWithReasoning, histWithout)
check('⑤·历史缺思考时用本地的补上', merged[1].reasoning, '本地流式里拿到的思考')
check('⑤·id 仍然稳定（不重挂）', merged[1].id, 'e2')

/* ⑥ 历史带了思考且更长 → 以历史为准 */
const histLonger = [
  { kind: 'user', id: 'h1', msgId: 'h1', text: '问', at: 1 },
  { kind: 'assistant', id: 'h2', msgId: 'h2', text: '答', reasoning: '引擎落库的完整思考链', tools: [], segments: [], streaming: false, reasoningStreaming: false },
]
check('⑥·历史思考更长时以历史为准', applyHistoryItems(localWithReasoning, histLonger)[1].reasoning, '引擎落库的完整思考链')

/* ⑦ 折叠重复回复时，思考是并集而不是"跟着更长那份走" */
const copies = collapseAssistantCopies([
  { kind: 'user', id: 'u1', text: '问' },
  asst('a1', '短答案', { reasoning: '只有这一份有思考' }),
  asst('a2', '短答案加长版'),
])
check('⑦·折叠后保留思考', copies[1].reasoning, '只有这一份有思考')
check('⑦·折叠后留更长正文', copies[1].text, '短答案加长版')

if (failed === 0) {
  console.log('OK  ' + total + ' 条断言全部通过（排队标记按序摘除 / 思考在回读与折叠中不丢）')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 条断言失败')
  process.exit(1)
}
