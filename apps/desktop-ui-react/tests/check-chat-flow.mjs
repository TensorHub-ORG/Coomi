#!/usr/bin/env node
/**
 * 「单一消息数组」对话流的回归断言（纯逻辑，node 直接跑 TS）。
 *
 * 覆盖三件曾经会「丢内容 / 卡在进行中」的事，全部用 lib/chat.ts 里的纯函数直接断言：
 *   · 流式事件**就地追加**（applyEventsToMessages）：chunk 使最后一条消息变长、
 *     tool 写进同一条的 tools / 顺序段、turn_end 收尾、排队标记维护；
 *   · 历史回读**替换但不丢尾部**（applyHistoryItems）：回读滞后保留本地尾巴、
 *     补齐后按同正文认领成引擎真身（不重复渲染）；
 *   · 历史 → 条目映射（itemsFromHistory）仍还原工具状态与思考。
 *
 * 运行（Node 22+ 直接跑 TS，靠原生类型擦除）：
 *   node tests/check-chat-flow.mjs
 */
import {
  applyEventsToMessages, applyHistoryItems, clearQueuedUserItems, itemsFromHistory,
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
const chunk = (content) => ({ event_type: 'text_chunk', content })
const think = (content) => ({ event_type: 'reasoning_chunk', content })

/* ══ ① 流式就地追加：最后一条消息变长 ══ */
const justFinished = applyEventsToMessages([], [
  think('想了想'),
  chunk('第一段。'),
  chunk('第二段（最后一段）。'),
], 1)
const finished = applyEventsToMessages(justFinished, [{ event_type: 'turn_end' }], 9)
check('turn_end·只产生一条助手消息', finished.length, 1)
const f0 = asst(finished[0])
check('turn_end·正文逐 chunk 就地追加', f0 ? f0.text : '', '第一段。第二段（最后一段）。')
check('turn_end·思考就地追加', f0 ? f0.reasoning : '', '想了想')
check('turn_end·收尾后 streaming=false', f0 ? f0.streaming : true, false)
check('turn_end·收尾后思考不再流式', f0 ? !!f0.reasoningStreaming : true, false)

/* ══ ② 历史回读：替换但不丢本地尾部 ══ */
const historyUser = (text, id = 'h') => ({ kind: 'user', id, msgId: id, text, at: 1 })
const historyAssistant = (text, id = 'a') => ({ kind: 'assistant', id, msgId: id, text, reasoning: '', tools: [], streaming: false, at: 2 })

// 本地：上一轮（已落库）+ 本轮乐观用户 + 还在流式的回复。
const localTurn = [
  historyUser('第一问', 'm1'),
  historyAssistant('第一答', 'm2'),
  { kind: 'user', id: 'u3', text: '第二问（还没落库）', at: 3 },
  { kind: 'assistant', id: 'e4', text: '第二答（流式中）', reasoning: '', tools: [], streaming: true, at: 4 },
]
// 回读滞后：历史只到上一轮 → 本地尾部必须原样保留。
const laggingHist = [historyUser('第一问', 'm1'), historyAssistant('第一答', 'm2')]
const keptTail = applyHistoryItems(localTurn, laggingHist)
check('回读滞后·本地尾部一条不丢', keptTail.length, 4)
check('回读滞后·本地尾部顺序不变', keptTail.slice(2).map((i) => i.id), ['u3', 'e4'])
// 回读补齐：历史有了整轮 → 同正文认领成引擎真身，不重复成条。
const fullHist = [
  historyUser('第一问', 'm1'),
  historyAssistant('第一答', 'm2'),
  historyUser('第二问（还没落库）', 'm3'),
  { ...historyAssistant('第二答（流式中）', 'm4'), reasoning: '又想了想', tools: [{ callId: 'c1', name: 'read', args: '{}', status: 'done', preview: 'ok' }] },
]
const confirmed = applyHistoryItems(localTurn, fullHist)
check('回读补齐·条数不变（不重复渲染）', confirmed.length, 4)
// id 保持本地那份（React key 不变 → 行不重挂 → 入场动画不重播：这是「消息变透明/暗淡」的根因修复），
// 引擎 id 记进 msgId，正文与元数据仍以历史为准。
check('回读补齐·id 保持稳定（不重挂）', confirmed[2].id, 'u3')
check('回读补齐·引擎 id 记进 msgId', confirmed[2].msgId, 'm3')
const confirmedLast = asst(confirmed[3])
check('回读补齐·元数据以历史为准（思考 / 工具终态）', confirmedLast ? confirmedLast.reasoning + '/' + confirmedLast.tools[0].status : '', '又想了想/done')
check('回读补齐·读回空快照不清空本地', applyHistoryItems(localTurn, []).length, 4)
check('回读补齐·replace 完全以回读为准', applyHistoryItems(localTurn, laggingHist, { replace: true }).length, 2)

/* ══ ③ 排队中的插话标记 ══ */
const withQueued = applyEventsToMessages(
  [{ kind: 'user', id: 'u9', text: '第一轮', at: 1 }, { kind: 'assistant', id: 'e9', text: '正文', reasoning: '', tools: [], streaming: true }],
  [{ event_type: 'message_queued' }], 9,
)
// message_queued：标记末尾那条用户消息。
check('message_queued·末尾用户消息挂上排队标记', withQueued[0].kind === 'user' ? !!withQueued[0].queued : false, true)
const started = applyEventsToMessages(withQueued, [{ event_type: 'queued_message_started', text: '第一轮' }], 10)
check('queued_message_started·按正文摘掉标记', started[0].kind === 'user' ? !!started[0].queued : true, false)
const requeued = [...withQueued]
requeued[0] = { ...requeued[0], queued: true }
const cleared = clearQueuedUserItems(requeued)
check('queue_cleared·全部摘掉', cleared[0].kind === 'user' ? !!cleared[0].queued : true, false)
const plain = [{ kind: 'user', id: 'u0', text: 'x', at: 0 }]
check('queue_cleared·没标记的原样返回（同一引用）', clearQueuedUserItems(plain) === plain, true)

/* ══ ④ 历史 → 条目映射 ══ */
const queuedEntry = itemsFromHistory([{ id: 'u1', role: 'user', content: '你好', __queued: true }])
check('itemsFromHistory·__queued 带进条目', queuedEntry.map((i) => [i.kind, i.queued]), [['user', true]])
const mapped = itemsFromHistory([
  { id: 'u1', role: 'user', content: '问题' },
  { id: 'a1', role: 'assistant', content: '', reasoning: '思考', tool_calls: [{ id: 'c1', name: 'shell', arguments: { cmd: 'pwd' } }] },
  { id: 't1', role: 'tool', tool_call_id: 'c1', content: 'success: /tmp' },
])
check('itemsFromHistory·工具状态回填终态', asst(mapped[1]) && asst(mapped[1]).tools[0] ? asst(mapped[1]).tools[0].status : '', 'done')
check('itemsFromHistory·工具预览回填', asst(mapped[1]) && asst(mapped[1]).tools[0] ? asst(mapped[1]).tools[0].preview : '', 'success: /tmp')
check('itemsFromHistory·思考被还原', asst(mapped[1]) ? asst(mapped[1]).reasoning : '', '思考')

if (failed === 0) {
  console.log('OK  ' + total + ' 个纯逻辑断言全部通过：流式就地追加 / 历史替换不丢尾部 / 排队标记 / 历史映射')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 个断言失败')
  process.exit(1)
}
