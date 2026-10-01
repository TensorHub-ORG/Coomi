#!/usr/bin/env node
/**
 * 渲染层引用稳定性的纯逻辑断言（不需要浏览器、不需要引擎）。
 *
 * 症状：visibleEntries / composeChatItems 每次返回新数组 → 下游 setState 每帧落地一次，
 * 转成渲染风暴（React #185）。新管线没有那套「已展示记忆」，但同一份引用稳定性规矩
 * 必须继续由纯函数守住：
 *   · 没有内容变化的事件 / 空批次 → 返回**原数组引用**；
 *   · 历史读回空快照 → 不清空、引用不变；
 *   · 窗口装得下全部 → 返回原数组引用。
 * 这保证「这一拍没有新东西」时一次 setState 都不发。
 *
 * 运行（Node 22+ 直接跑 TS，靠原生类型擦除）：
 *   node tests/check-render-stability.mjs
 */
import {
  applyEventsToMessages, applyHistoryItems, chatWindowTail,
} from '../src/lib/chat.ts'

let failed = 0
let total = 0
function truthy(name, condition, detail) {
  total += 1
  if (condition) return
  failed += 1
  console.error('FAIL ' + name + (detail === undefined ? '' : '\n  ' + detail))
}

const USER = { kind: 'user', id: 'u1', text: '你好', at: 1 }
const ASST = { kind: 'assistant', id: 'a1', text: '答', reasoning: '', tools: [], streaming: false, at: 2 }
const HISTORY = [USER, ASST]
const EVENTS = [
  { event_type: 'text_chunk', content: '第一段' },
  { event_type: 'text_chunk', content: '第二段' },
]

/* ══ ① 空批次 / 无内容事件：引用不变 ══ */
const base = applyEventsToMessages([], EVENTS, 1)
truthy('回归·空批次返回同一份数组', applyEventsToMessages(base, []) === base)
truthy('回归·无内容事件（usage_update）返回同一份数组', applyEventsToMessages(base, [{ event_type: 'usage_update', usage: {} }], 99) === base)
truthy('回归·无内容事件（agent_cancelled）返回同一份数组', applyEventsToMessages(base, [{ event_type: 'agent_cancelled' }], 99) === base)

/* ══ ② 历史回读：空快照不清空、引用不变 ══ */
truthy('回归·读回空快照返回同一份数组', applyHistoryItems(HISTORY, []) === HISTORY)
truthy('回归·空本地直接采用历史（同一引用）', applyHistoryItems([], HISTORY) === HISTORY)
const merged = applyHistoryItems(HISTORY, HISTORY)
truthy('回归·内容一致的读回仍是历史那份内容', merged.length === HISTORY.length && merged[0].text === '你好')

/* ══ ③ 窗口切片：装得下就返回原数组 ══ */
truthy('回归·窗口大于条数返回原数组', chatWindowTail(HISTORY, 60) === HISTORY)
truthy('回归·窗口恰好等于条数返回原数组', chatWindowTail(HISTORY, HISTORY.length) === HISTORY)

/* ══ ④ 就地追加不换整棵树：同一批事件反复应用结果等价 ══ */
const again = applyEventsToMessages([], EVENTS, 1)
truthy('回归·同一批事件两次应用结果一致（正文 / 条数）',
  again.length === base.length
  && again[0].kind === 'assistant' && base[0].kind === 'assistant'
  && again[0].text === base[0].text)

/* ══ ⑤ 事件就地追加：同一条消息变长，而不是新增条目 ══ */
const grown = applyEventsToMessages(base, [{ event_type: 'text_chunk', content: '第三段' }], 9)
truthy('回归·追加 chunk 不新增条目', grown.length === base.length)
truthy('回归·追加 chunk 使最后一条消息变长',
  grown[0].kind === 'assistant' && grown[0].text === '第一段第二段第三段',
  JSON.stringify(grown))

if (failed === 0) {
  console.log('OK  ' + total + ' 个纯逻辑断言全部通过：空批次引用不变 / 回读不清空 / 窗口原样返回 / 就地追加')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 个断言失败')
  process.exit(1)
}
