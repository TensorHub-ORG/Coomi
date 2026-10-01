#!/usr/bin/env node
/**
 * 「单一消息数组」对话渲染管线的回归断言（纯逻辑，node 直接跑 TS）。
 *
 * 跑的是**真实的那份纯逻辑**（lib/chat.ts，浏览器与回归脚本共用同一份）：
 *   · applyEventsToMessages —— 事件**就地追加**到当前这条消息（正文 / 思考 / 工具与顺序段）；
 *   · applyHistoryItems     —— 历史回读合并：覆盖部分换成历史权威版，本地尾部原样保留；
 *   · chatWindowTail        —— 窗口切片（默认最后 60 条 + 「加载更早」每次 +60）；
 *   · itemsFromHistory      —— 历史 → ChatItem 映射。
 *
 * 四条硬断言：
 *   ① 追加 chunk 使最后一条消息变长（不合并、不剪枝、不覆盖）；
 *   ② 历史替换不丢本地更新的尾部（回读滞后保留本地尾部；补齐后同正文认领不重复）；
 *   ③ tool 顺序段与事件顺序一致（正文 / 工具按事件先后交替）；
 *   ④ 窗口切片取最后 60 条、加更早后 120 条。
 *
 * 运行（Node 22+ 直接跑 TS，靠原生类型擦除）：
 *   node tests/check-chat-pipeline.mjs
 */
import {
  applyEventsToMessages, applyHistoryItems, chatWindowTail, collapseAssistantCopies, itemsFromHistory,
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

/* ══ ① 追加 chunk 使最后一条消息变长 ══ */
const streamed = applyEventsToMessages([], [
  { event_type: 'text_chunk', content: '第' },
  { event_type: 'reasoning_chunk', content: '想一下 ' },
  { event_type: 'text_chunk', content: '一段' },
  { event_type: 'reasoning_chunk', content: '再想' },
  { event_type: 'text_chunk', content: '正文' },
  { event_type: 'tool_start', call_id: 'c1', tool_name: 'read', arguments: { path: 'a.txt' } },
  { event_type: 'tool_done', call_id: 'c1', elapsed: 0.1, result_preview: 'ok' },
], 1)
check('①·多个 chunk 只产生一条助手消息', streamed.length, 1)
const s1 = asst(streamed[0])
check('①·正文就地追加（最后一条消息变长）', s1 ? s1.text : '', '第一段正文')
check('①·思考就地追加', s1 ? s1.reasoning : '', '想一下 再想')
check('①·正文开始后思考不再流式', s1 ? !!s1.reasoningStreaming : true, false)
check('①·工具写进同一条的 tools', s1 ? s1.tools.map((t) => t.callId) : [], ['c1'])
check('①·工具终态来自 tool_done', s1 && s1.tools[0] ? s1.tools[0].status : '', 'done')
check('①·工具结果预览被记下', s1 && s1.tools[0] ? s1.tools[0].preview : '', 'ok')
// 事件顺序 → 顺序段：正文先到（text 段），工具随后新起 tools 段（tool_done 只更新不新起段）。
const segKinds1 = s1 ? s1.segments.map((seg) => seg.kind) : []
check('①·顺序段与事件顺序一致', segKinds1, ['text', 'tools'])
check('①·顺序段的工具段含 c1', s1 ? (s1.segments.find((seg) => seg.kind === 'tools')?.callIds ?? []) : [], ['c1'])
// turn_end 收尾：streaming=false。
const ended = applyEventsToMessages(streamed, [{ event_type: 'turn_end' }], 99)
const e1 = asst(ended[ended.length - 1])
check('①·turn_end 收尾（streaming=false）', e1 ? e1.streaming : true, false)
// 引用稳定：没有内容变化的事件不换数组。
const same = applyEventsToMessages(streamed, [{ event_type: 'usage_update', usage: {} }], 99)
ok('①·无内容事件返回同一份数组（引用稳定）', same === streamed)

/* ══ ② 历史替换不丢本地更新的尾部 ══ */
// 本地：上一轮已落库 + 本轮刚发的乐观用户 + 还在流式的回复。
const local = [
  { kind: 'user', id: 'm1', msgId: 'm1', text: '第一问', at: 1 },
  { kind: 'assistant', id: 'm2', msgId: 'm2', text: '第一答', reasoning: '想了一轮', tools: [], streaming: false, at: 2 },
  { kind: 'user', id: 'u3', text: '第二问（还没落库）', at: 3 },
  { kind: 'assistant', id: 'e4', text: '第二答（流式中）', reasoning: '', tools: [], streaming: true, at: 4 },
]
// 回读滞后：历史只到上一轮 → 本地尾部必须原样保留（一条都不许丢）。
const lagging = [
  { kind: 'user', id: 'm1', msgId: 'm1', text: '第一问', at: 1 },
  { kind: 'assistant', id: 'm2', msgId: 'm2', text: '第一答', reasoning: '想了一轮', tools: [], streaming: false, at: 2 },
]
const afterLag = applyHistoryItems(local, lagging)
check('②·回读滞后：本地尾部不丢（条数不变）', afterLag.length, 4)
check('②·回读滞后：历史覆盖部分换成历史版本', afterLag[0].id, 'm1')
check('②·回读滞后：本地尾部顺序不变', afterLag.slice(2).map((i) => i.id), ['u3', 'e4'])
// 回读补齐：历史有了整轮 → 尾部按「同正文」认领成引擎真身，不重复成条。
const full = [
  { kind: 'user', id: 'm1', msgId: 'm1', text: '第一问', at: 1 },
  { kind: 'assistant', id: 'm2', msgId: 'm2', text: '第一答', reasoning: '想了一轮', tools: [], streaming: false, at: 2 },
  { kind: 'user', id: 'm3', msgId: 'm3', text: '第二问（还没落库）', at: 3 },
  { kind: 'assistant', id: 'm4', msgId: 'm4', text: '第二答（流式中）', reasoning: '又想了想', tools: [{ callId: 'c1', name: 'read', args: '{}', status: 'done' }], streaming: false, at: 4 },
]
const afterFull = applyHistoryItems(local, full)
check('②·回读补齐：条数不变（同正文认领，不重复渲染）', afterFull.length, 4)
// 认领之后 **id 保持本地那份**（React key 不变 → 行不重挂 → 入场动画不重播），
// 引擎 id 记进 msgId；正文/工具等仍以历史为准。这正是「回复变暗淡 / 我的消息消失」的根因修复。
check('②·回读补齐：id 保持稳定（不重挂）', afterFull[2].id, 'u3')
check('②·回读补齐：引擎 id 记进 msgId', afterFull[2].msgId, 'm3')
check('②·回读补齐：正文换成引擎版本', afterFull[2].text, '第二问（还没落库）')
// 本地那条流式助手（id 'e4'）被引擎版本接管：**id 依然是 e4**（行不重挂），引擎 id 进 msgId。
check('②·回读补齐：助手 id 保持稳定（不重挂）', afterFull[3].id, 'e4')
check('②·回读补齐：助手拿到引擎 msgId', afterFull[3].msgId, 'm4')
check('②·回读补齐：思考以历史为准', asst(afterFull[3]) ? asst(afterFull[3]).reasoning : '', '又想了想')
// 空快照 / 空本地两边的兜底。
check('②·读回空快照不清空本地', applyHistoryItems(local, []).length, 4)
check('②·空本地直接采用历史', applyHistoryItems([], full).length, 4)
// replace：引擎侧真的删过内容时完全以回读为准。
check('②·replace 完全以回读为准', applyHistoryItems(local, full, { replace: true }).length, 4)
check('②·replace 不保留旧尾部', applyHistoryItems(local, lagging, { replace: true }).length, 2)

/* ══ ③ tool 顺序段与事件顺序一致 ══ */
const events = [
  { event_type: 'tool_start', call_id: 'c1', tool_name: 'read', arguments: { path: '/a' } },
  { event_type: 'text_chunk', content: '先读' },
  { event_type: 'tool_done', call_id: 'c1', elapsed: 0.1, result_preview: 'ok' },
  { event_type: 'text_chunk', content: '后写' },
  { event_type: 'tool_start', call_id: 'c2', tool_name: 'write', arguments: { path: '/b' } },
  { event_type: 'tool_running', call_id: 'c2' },
  { event_type: 'tool_done', call_id: 'c2', elapsed: 0.2, result_preview: 'done' },
  { event_type: 'text_chunk', content: '收尾' },
]
const seq = applyEventsToMessages([], events, 1)
check('③·整串事件只产生一条助手消息', seq.length, 1)
const s3 = asst(seq[0])
const kinds3 = s3 ? s3.segments.map((seg) => seg.kind) : []
check('③·顺序段种类与事件先后一致', kinds3, ['tools', 'text', 'tools', 'text'])
const calls3 = s3 ? s3.segments.filter((seg) => seg.kind === 'tools').map((seg) => seg.callIds) : []
check('③·工具段 callId 顺序与事件一致', calls3, [['c1'], ['c2']])
const texts3 = s3 ? s3.segments.filter((seg) => seg.kind === 'text').map((seg) => seg.text) : []
check('③·正文段按事件到达分块', texts3, ['先读后写', '收尾'])
check('③·tools 数组顺序与事件一致', s3 ? s3.tools.map((t) => t.callId) : [], ['c1', 'c2'])

/* ══ ④ 窗口切片：最后 60 条 + 加更早后 120 条 ══ */
const many = Array.from({ length: 150 }, (_, i) => ({ kind: 'user', id: 'w' + i, text: '消息 ' + i }))
const tail60 = chatWindowTail(many, 60)
check('④·默认窗口取最后 60 条', tail60.length, 60)
check('④·窗口内容是最新的 60 条', tail60[0].id, 'w90')
check('④·窗口尾条是最后一条', tail60[tail60.length - 1].id, 'w149')
const tail120 = chatWindowTail(many, 120)
check('④·加载更早（+60）后 120 条', tail120.length, 120)
check('④·加更早后窗口从头开始（再 +60 才盖到 w0）', tail120[0].id, 'w30')
check('④·窗口不足时返回原数组（同一引用）', chatWindowTail(many, 200) === many, true)

/* ══ ⑤ 历史映射（itemsFromHistory）仍产出顺序段 ══ */
const histItems = itemsFromHistory([
  { id: 'u1', role: 'user', content: '跑一下', at_ms: 1 },
  { id: 'a1', role: 'assistant', content: '先看', reasoning: '想', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: '/x' } }] },
  { id: 't1', role: 'tool', tool_call_id: 'c1', content: 'success: ok' },
  { id: 'a2', role: 'assistant', content: '结果如上' },
])
check('⑤·历史映射条数与顺序', histItems.map((i) => i.id), ['u1', 'a1', 'a2'])
const h1 = asst(histItems[1])
check('⑤·历史里的工具状态回填终态', h1 && h1.tools[0] ? h1.tools[0].status : '', 'done')
check('⑤·历史里的工具预览回填', h1 && h1.tools[0] ? h1.tools[0].preview : '', 'success: ok')
check('⑤·历史里的思考被还原', h1 ? h1.reasoning : '', '想')
check('⑤·历史里的顺序段（正文 → 工具）', h1 && h1.segments ? h1.segments.map((seg) => seg.kind) : [], ['text', 'tools'])

/* ══ ⑥ 同一条回复被画两遍 → 折叠（assistant 前缀副本） ══
   现场：界面出现两条「我是 Coomi」，一份是流式中间态（乱序/截断），一份是引擎落库版。
   两条之间没有用户消息才算「同一条」；两份正文毫无前缀关系 → 原样保留（那是两条真回复）。 */
const dup = collapseAssistantCopies([
  { kind: 'user', id: 'u1', text: '你好' },
  { kind: 'assistant', id: 'a1', text: '我是 Coomi', tools: [], segments: [], streaming: true, reasoningStreaming: false },
  { kind: 'assistant', id: 'a2', text: '我是 Coomi，本地助手', tools: [], segments: [], streaming: false, reasoningStreaming: false },
])
check('⑥·同一条回复的两份副本折叠成一条', dup.length, 2)
check('⑥·保留更长的那一份', dup[1].text, '我是 Coomi，本地助手')
check('⑥·折叠后不再有流式光标', dup[1].streaming, false)
const twoTurns = collapseAssistantCopies([
  { kind: 'user', id: 'u1', text: '问一' },
  { kind: 'assistant', id: 'a1', text: '答一', tools: [], segments: [], streaming: false, reasoningStreaming: false },
  { kind: 'user', id: 'u2', text: '问二' },
  { kind: 'assistant', id: 'a2', text: '答二', tools: [], segments: [], streaming: false, reasoningStreaming: false },
])
check('⑥·跨轮次的回复绝不折叠', twoTurns.length, 4)
const different = collapseAssistantCopies([
  { kind: 'user', id: 'u1', text: '问' },
  { kind: 'assistant', id: 'a1', text: '完全不同的答复', tools: [], segments: [], streaming: false, reasoningStreaming: false },
  { kind: 'assistant', id: 'a2', text: '另一条也不同的答复', tools: [], segments: [], streaming: false, reasoningStreaming: false },
])
check('⑥·正文无前缀关系时不折叠', different.length, 3)
check('⑥·无需折叠时返回原数组（同一引用）', collapseAssistantCopies(twoTurns) === twoTurns, true)

/* ══ ⑦ 回合级对账：引擎已落库的那一轮，本地流式副本（可能错序）必须被作废 ══
   实测现场：本地累积出「收到 ✓ 输入法。测试 484 已送达」，引擎落库是「收到 ✓ 输入法测试 484 已送达。」
   —— 错序导致正文比对必然失败，两份都留下 = 界面上同一条回复画两遍（一份乱码）。 */
const garbledLocal = [
  { kind: 'user', id: 'u1', text: '输入法测试484', at: 1 },
  { kind: 'assistant', id: 'e9', text: '收到 ✓ 输入法。测试 484 已送达', tools: [], segments: [], streaming: false, reasoningStreaming: false },
]
const goodHistory = [
  { kind: 'user', id: 'h1', msgId: 'h1', text: '输入法测试484', at: 1 },
  { kind: 'assistant', id: 'h2', msgId: 'h2', text: '收到 ✓ 输入法测试 484 已送达。', tools: [], segments: [], streaming: false, reasoningStreaming: false },
]
const fixed = applyHistoryItems(garbledLocal, goodHistory)
check('⑦·错序的本地流式副本被作废（不再画两遍）', fixed.length, 2)
check('⑦·留下的是引擎的权威正文', fixed[1].text, '收到 ✓ 输入法测试 484 已送达。')
check('⑦·用户消息不会被重复补回', fixed.filter((i) => i.kind === 'user').length, 1)

// 引擎还没把这一轮写完（历史里只有用户消息）：本地流式内容必须原样保留，绝不提前作废。
const notYet = applyHistoryItems(garbledLocal, [{ kind: 'user', id: 'h1', msgId: 'h1', text: '输入法测试484', at: 1 }])
check('⑦·引擎还没落库这一轮时，本地流式副本保留', notYet.length, 2)
check('⑦·未落库时正文原样', notYet[1].text, '收到 ✓ 输入法。测试 484 已送达')

// 历史里这一轮的助手是空的（引擎写了条空消息）：不作废，宁可保留本地看到的内容。
const emptyHist = applyHistoryItems(garbledLocal, [
  { kind: 'user', id: 'h1', msgId: 'h1', text: '输入法测试484', at: 1 },
  { kind: 'assistant', id: 'h2', msgId: 'h2', text: '', tools: [], segments: [], streaming: false, reasoningStreaming: false },
])
check('⑦·历史助手为空时保留本地正文', emptyHist.length, 2)

// 本地尾部的提问卡必须留着（引擎可能还没落库它）。
const withAsk = applyHistoryItems([
  { kind: 'user', id: 'u1', text: '输入法测试484', at: 1 },
  { kind: 'assistant', id: 'e9', text: '收到 ✓ 输入法。测试 484 已送达', tools: [], segments: [], streaming: false, reasoningStreaming: false },
  { kind: 'ask', id: 'ask:q1', callId: 'q1', prompt: '接下来做什么？', questions: [], answer: null, pending: false },
], goodHistory)
check('⑦·提问卡不被连坐删掉', withAsk.filter((i) => i.kind === 'ask').length, 1)
check('⑦·提问卡在权威回复之后', withAsk[withAsk.length - 1].kind, 'ask')

// 已带引擎 msgId 的本地条目走正常覆盖规则，不在这里作废。
const withMsgId = applyHistoryItems([
  { kind: 'user', id: 'u1', text: '输入法测试484', at: 1 },
  { kind: 'assistant', id: 'h2', msgId: 'h2', text: '前半段', tools: [], segments: [], streaming: false, reasoningStreaming: false },
], goodHistory)
check('⑦·带 msgId 的条目不在此处作废', withMsgId.length, 2)
// 用户重复发同一句话：历史里能匹配到**上一轮**那句同样的用户消息，但那不是这一轮 —— 
// 相似度闸门必须保住新一轮刚流出来的回复（内容是错的也不许丢）。
const repeated = applyHistoryItems([
  { kind: 'user', id: 'u9', text: '继续', at: 9 },
  { kind: 'assistant', id: 'e9', text: '这一轮刚刚流出来的新回复，内容和上一轮完全不同', tools: [], segments: [], streaming: false, reasoningStreaming: false },
], [
  { kind: 'user', id: 'h1', msgId: 'h1', text: '继续', at: 1 },
  { kind: 'assistant', id: 'h2', msgId: 'h2', text: '上一轮的回答：好的，我继续处理那件事。', tools: [], segments: [], streaming: false, reasoningStreaming: false },
])
check('⑦·重复的相同提问不会误删新一轮回复', repeated.filter((i) => i.kind === 'assistant').length, 2)
check('⑦·新一轮回复正文原样保留', repeated[repeated.length - 1].text, '这一轮刚刚流出来的新回复，内容和上一轮完全不同')
/* ══ ⑧ 认领后 id 稳定：反复回读不得让行重挂（入场动画重播 = 消息变透明/暗淡） ══ */
const localTailItems = [
  { kind: 'user', id: 'u7', text: '你好', at: 1 },
  { kind: 'assistant', id: 'e8', text: '你好！', tools: [], segments: [], streaming: true, reasoningStreaming: false },
]
const histOnce = [
  { kind: 'user', id: 'h-uuid-1', msgId: 'h-uuid-1', text: '你好', at: 1 },
  { kind: 'assistant', id: 'h-uuid-2', msgId: 'h-uuid-2', text: '你好！', tools: [], segments: [], streaming: false, reasoningStreaming: false },
]
const merged1 = applyHistoryItems(localTailItems, histOnce)
check('⑧·认领后第一份的 id 不变', merged1.map((i) => i.id), ['u7', 'e8'])
check('⑧·认领后拿到引擎 msgId', merged1.map((i) => i.msgId), ['h-uuid-1', 'h-uuid-2'])
// 第二次回读（引擎那边英文名/id 全一样）：id 必须还是 u7 / e8，一次都不能变。
const merged2 = applyHistoryItems(merged1, histOnce)
check('⑧·再次回读 id 依然不变（幂等）', merged2.map((i) => i.id), ['u7', 'e8'])
// 增量的历史（助手正文变长）：id 照旧不动。
const histLonger = [
  histOnce[0],
  { ...histOnce[1], text: '你好！有什么可以帮你的？' },
]
const merged3 = applyHistoryItems(merged2, histLonger)
check('⑧·历史正文变长也不换 id', merged3.map((i) => i.id), ['u7', 'e8'])
check('⑧·历史正文变长会更新正文', merged3[1].text, '你好！有什么可以帮你的？')

if (failed === 0) {
  console.log('OK  ' + total + ' 个纯逻辑断言全部通过：就地追加 / 历史替换不丢本地尾部 / 工具顺序段 / 窗口切片 / 重复回复折叠 / 回合级对账')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 个断言失败')
  process.exit(1)
}
