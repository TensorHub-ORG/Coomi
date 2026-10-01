#!/usr/bin/env node
/**
 * 新管线循环护栏的纯逻辑断言（不需要浏览器、不需要引擎）。
 *
 * 旧管线的合并循环（mergeLiveIntoHistory / mergeHistoryMessages）需要「读游标严格递增 +
 * 轮数硬上限」的护栏；新管线把这类对账循环整个删掉了，剩下的循环都是**每步必然前进**的：
 *   · applyEventsToMessages —— 一批事件逐个就地追加（一条都不落）；
 *   · applyHistoryItems     —— 单遍扫本地 + 单遍扫历史，输出 ≤ 本地 + 历史（不可能凭空造条目）；
 *   · clearQueuedUserItems  —— 单遍 map，只摘匹配的「排队中」标记；
 *   · chatWindowTail        —— 纯切片，长度恒 ≤ size。
 * 这一份把这些不变量写成断言，防止以后有人往管线里加回无护栏的循环。
 *
 * 运行（Node 22+ 直接跑 TS，靠原生类型擦除）：
 *   node tests/check-loop-guards.mjs
 */
import {
  applyEventsToMessages, applyHistoryItems, chatWindowTail, clearQueuedUserItems,
} from '../src/lib/chat.ts'

let failed = 0
let total = 0
function check(name, got, want) {
  total += 1
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) {
    failed += 1
    console.error('FAIL ' + name + '\n  want=' + JSON.stringify(want) + '\n  got =' + JSON.stringify(got))
  }
}
function ok(name, condition, detail) {
  total += 1
  if (condition) return
  failed += 1
  console.error('FAIL ' + name + (detail === undefined ? '' : '\n  ' + detail))
}

const asst = (item) => item && item.kind === 'assistant' ? item : null

/* ══ ① applyEventsToMessages：一批事件一条都不落 ══ */
const CHUNKS = 500
const events = []
for (let i = 0; i < CHUNKS; i += 1) events.push({ event_type: 'text_chunk', content: '字' + i + '。' })
const folded = applyEventsToMessages([], events, 1)
check('①·五百个 chunk 只落成一条助手消息', folded.length, 1)
const totalText = asst(folded[0]) ? asst(folded[0]).text : ''
check('①·五百个 chunk 一个字符都不丢', totalText.length, events.map((e) => e.content).join('').length)
check('①·内容顺序与到达顺序一致', totalText.startsWith('字0。') && totalText.endsWith('字499。'), true)

/* ══ ② applyHistoryItems：不变量「输出 ≤ 本地 + 历史」+ 空快照不清空 ══ */
const local = [
  { kind: 'user', id: 'm1', msgId: 'm1', text: '问一', at: 1 },
  { kind: 'assistant', id: 'm2', msgId: 'm2', text: '答一', reasoning: '', tools: [], streaming: false, at: 2 },
  { kind: 'user', id: 'u3', text: '问二（乐观）', at: 3 },
  { kind: 'assistant', id: 'e4', text: '答二（流式）', reasoning: '', tools: [], streaming: true, at: 4 },
]
const incoming = [
  { kind: 'user', id: 'm1', msgId: 'm1', text: '问一', at: 1 },
  { kind: 'assistant', id: 'm2', msgId: 'm2', text: '答一', reasoning: '想', tools: [], streaming: false, at: 2 },
]
const merged = applyHistoryItems(local, incoming)
ok('②·输出条数 ≤ 本地条数 + 历史条数', merged.length <= local.length + incoming.length,
  merged.length + ' > ' + (local.length + incoming.length))
check('②·回读滞后保留本地尾部', merged.length, local.length)
check('②·空快照不清空本地', applyHistoryItems(local, []).length, local.length)
check('②·空本地直接采用历史', applyHistoryItems([], incoming).length, incoming.length)

/* ══ ③ applyHistoryItems 在同正文上重复调用（阶梯回读）是幂等的 ══ */
const fullHist = [
  { kind: 'user', id: 'm1', msgId: 'm1', text: '问一', at: 1 },
  { kind: 'assistant', id: 'm2', msgId: 'm2', text: '答一', reasoning: '想', tools: [], streaming: false, at: 2 },
  { kind: 'user', id: 'm3', msgId: 'm3', text: '问二（乐观）', at: 3 },
  { kind: 'assistant', id: 'm4', msgId: 'm4', text: '答二（流式）', reasoning: '', tools: [{ callId: 'c1', name: 'read', args: '{}', status: 'done' }], streaming: false, at: 4 },
]
const once = applyHistoryItems(local, fullHist)
const twice = applyHistoryItems(once, fullHist)
check('③·同正文回读幂等（不重复成条）', twice.length, once.length)
check('③·第二次回读条数等于历史条数', twice.length, fullHist.length)
// id 必须稳定（本地那份），否则每次回读都换 key → 行重挂 → 入场动画从 opacity:0 重播。
check('③·同 id 条目 id 保持稳定', twice[2].id, 'u3')
check('③·同 id 条目拿到引擎 msgId', twice[2].msgId, 'm3')
check('③·同 id 条目正文以历史为准', twice[2].text, '问二（乐观）')

/* ══ ④ clearQueuedUserItems：只摘匹配的「排队中」标记，单遍收敛 ══ */
const queued = [
  { kind: 'user', id: 'u1', text: '继续', queued: true, at: 1 },
  { kind: 'user', id: 'u2', text: '继续', queued: true, at: 2 },
  { kind: 'user', id: 'u3', text: '再来', queued: true, at: 3 },
]
const byText = clearQueuedUserItems(queued, '继续')
check('④·按正文只摘第一条', byText.map((i) => !!i.queued), [false, true, true])
const all = clearQueuedUserItems(queued)
check('④·全摘', all.map((i) => !!i.queued), [false, false, false])
// **契约变更（2026-09-28，真机事故修复）**：正文对不上时不再「什么都不做」，
// 而是按队列顺序摘**最早**那条排队消息 —— 引擎说「某条排队消息开始执行了」时，
// 语义就是队列最前面那条；以前要求正文完全相等，一字之差（技能前缀/引用改写/空白）
// 就永远摘不掉标记，而 findCurrentAssistant 会跳过带标记的条目 →
// 新一轮的正文和思考被追加到上一轮的助手条目上（用户看到「消息与回复对不上」、思考「消失」）。
const unmatched = clearQueuedUserItems(queued, '没有这个正文')
check('④·正文对不上 → 摘最早那条排队消息', unmatched.map((i) => !!i.queued), [false, true, true])
// 没有排队条目时仍然原样返回（引用稳定，不触发多余重渲染）。
const noQueued = [{ kind: 'user', id: 'u9', text: 'x', at: 1 }]
check('④·无排队条目 → 原数组引用不变', clearQueuedUserItems(noQueued, '没有这个正文') === noQueued, true)

/* ══ ⑤ chatWindowTail：长度恒 ≤ size，纯切片 ══ */
const many = Array.from({ length: 200 }, (_, i) => ({ kind: 'user', id: 'w' + i, text: 'm' + i }))
check('⑤·切片长度恒等于 size', chatWindowTail(many, 60).length, 60)
check('⑤·窗口不足时原样返回', chatWindowTail(many, 500) === many, true)
check('⑤·空列表不崩', chatWindowTail([], 60).length, 0)

if (failed === 0) {
  console.log('OK  ' + total + ' 个纯逻辑断言全部通过：追加一条不落 / 回读不变量 / 幂等 / 排队标记 / 切片边界')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 个断言失败')
  process.exit(1)
}
