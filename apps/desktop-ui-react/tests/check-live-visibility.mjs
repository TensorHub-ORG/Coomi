#!/usr/bin/env node
/**
 * 「AI 正在回复 / 刚回复完的那条在界面上直接消失」的纯逻辑断言（不需要浏览器、不需要引擎）。
 *
 * 跑的是**真实的那份纯逻辑**：lib/chat.ts 的单一消息数组管线（applyEventsToMessages /
 * itemsFromHistory / applyHistoryItems），加一层**逐毫秒时钟桩**把 stores/session.ts 的时序
 * （32ms 合批提交、turn_end 的 0/300ms/1s/2.5s 阶梯回读）推一遍：每推进 1ms 就按当月那一拍的
 * 状态重算一次界面内容，所以「空窗那一帧」是真的会出现在采样里的。
 *
 * 四条断言（对应三份硬规矩）：
 *   ① 桩历史落库延迟 2 秒 → 轮结束后 5 秒内该回复**始终可见**（没有一帧变空）；
 *   ② 流式中穿插工具 / 状态事件 → 正文长度时间轴**单调不减**；
 *   ③ 一轮没结束时插队再发一条 → 前一轮**已产出的正文不消失**；
 *   ④ 回读补齐 / 清空快照时渲染条目**不减少**、已出现的身份不丢。
 *
 * 运行（Node 22+ 直接跑 TS，靠原生类型擦除）：
 *   node tests/check-live-visibility.mjs
 */
import { applyEventsToMessages, applyHistoryItems, itemsFromHistory } from '../src/lib/chat.ts'

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

/* ── 逐毫秒时钟桩 ── */
class Clock {
  constructor() {
    this.now = 0
    this.queue = []
    this.seq = 0
    this.onFrame = null
    this.frames = 0
  }
  at(ms, fn) { this.seq += 1; this.queue.push({ at: this.now + ms, seq: this.seq, fn }); return this.seq }
  clear(id) { this.queue = this.queue.filter((t) => t.seq !== id) }
  advance(toMs, onFrame) {
    const frame = onFrame ?? this.onFrame
    while (this.now < toMs) {
      this.now += 1
      const due = this.queue.filter((t) => t.at <= this.now).sort((a, b) => a.at - b.at || a.seq - b.seq)
      this.queue = this.queue.filter((t) => t.at > this.now)
      for (const timer of due) timer.fn()
      if (frame) { this.frames += 1; frame(this.now) }
    }
  }
}

/* ── 引擎桩：历史是一份有序的对话，落库有延迟（默认 2 秒） ── */
class EngineStub {
  constructor() {
    this.history = []
    this.pending = []
    this.running = false
  }
  beginTurn(text) {
    this.history.push({ id: 'u' + this.history.length, role: 'user', content: text })
    this.running = true
  }
  endTurn(clock, { text, reasoning = '', toolIds = [], delayMs = 2000 } = {}) {
    const message = {
      id: 'a' + this.pending.length,
      role: 'assistant',
      content: text,
      tool_calls: toolIds.map((id) => ({ id, name: 'shell', arguments: {} })),
      ...(reasoning ? { reasoning } : {}),
    }
    this.pending.push(message)
    this.running = false
    clock.at(delayMs, () => {
      this.history.push(message)
      for (const id of toolIds) this.history.push({ id: 't' + id, role: 'tool', tool_call_id: id, content: 'success: ok' })
    })
  }
  snapshot() { return this.history.map((m) => ({ ...m })) }
}

const CHUNK_COMMIT_MS = 32
const TURN_READBACK_STEPS_MS = [0, 300, 1000, 2500]

/** 一台「会话界面」：唯一一份 messages + 事件就地追加 + 回读合并，与 stores/session.ts 同构。 */
function createSession(clock, engine) {
  const state = { messages: [], streaming: false, turnSeq: 0, chunkBuf: [], chunkTimer: null, seq: 0 }
  let items = []
  const frames = []

  const render = () => {
    items = state.messages
    frames.push({ at: clock.now, items })
    return items
  }

  const flushChunks = () => {
    if (state.chunkTimer !== null) { clock.clear(state.chunkTimer); state.chunkTimer = null }
    if (!state.chunkBuf.length) return
    const buffered = state.chunkBuf
    state.chunkBuf = []
    state.messages = applyEventsToMessages(state.messages, buffered, state.seq)
    state.seq += buffered.length
    render()
  }

  const onEvent = (ev) => {
    const type = ev.event_type
    if (type === 'text_chunk' || type === 'reasoning_chunk') {
      state.streaming = true
      state.chunkBuf.push(ev)
      if (state.chunkTimer === null) {
        state.chunkTimer = clock.at(CHUNK_COMMIT_MS, () => { state.chunkTimer = null; flushChunks() })
      }
      render()
      return
    }
    // 其它事件先 flush 再就地追加：顺序不会乱（工具行不会插到还没提交的正文前面）。
    flushChunks()
    state.messages = applyEventsToMessages(state.messages, [ev], state.seq++)
    render()
  }

  /** 发一轮：轮次序号 +1。 */
  const send = (text) => {
    flushChunks()
    state.turnSeq += 1
    const seq = state.turnSeq
    engine.beginTurn(text)
    state.messages = [...state.messages, { kind: 'user', id: 'u' + (state.seq++), text, at: clock.now }]
    state.streaming = true
    render()
    return seq
  }

  /** 运行中插话：只追加一条带「排队中」标记的乐观用户消息，不动本轮消息与 streaming。 */
  const insertQueued = (text) => {
    flushChunks()
    state.messages = [...state.messages, { kind: 'user', id: 'u' + (state.seq++), text, at: clock.now, queued: true }]
    render()
  }

  /** turn_end：先 flush 再就地收尾，然后按 0/300ms/1s/2.5s 阶梯回读（每一步都过轮次校验）。 */
  const endTurn = (seq, { delayMs = 2000 } = {}) => {
    flushChunks()
    const text = state.messages.filter((i) => i.kind === 'assistant').map((i) => i.text).join('')
    const reasoning = state.messages.filter((i) => i.kind === 'assistant').map((i) => i.reasoning).join('')
    const toolIds = state.messages.filter((i) => i.kind === 'assistant').flatMap((i) => i.tools.map((t) => t.callId))
    state.messages = applyEventsToMessages(state.messages, [{ event_type: 'turn_end' }], state.seq++)
    state.streaming = false
    render()
    engine.endTurn(clock, { text, reasoning, toolIds, delayMs })
    for (const delay of TURN_READBACK_STEPS_MS) {
      clock.at(delay, () => {
        // 轮次序号校验：这一轮已经过去了就整段作废。
        if (state.turnSeq !== seq) return
        // 回读合并：被历史覆盖的换成权威版，历史还没有的本地尾部原样保留 —— 任何快照都不丢内容。
        state.messages = applyHistoryItems(state.messages, itemsFromHistory(engine.snapshot()))
        render()
      })
    }
  }

  return {
    state, frames, render, onEvent, send, insertQueued, endTurn,
    items: () => items,
  }
}

const assistantTexts = (items) => items.filter((i) => i.kind === 'assistant').map((i) => i.text)
const userTexts = (items) => items.filter((i) => i.kind === 'user').map((i) => i.text)
const containsReply = (items, reply) => assistantTexts(items).some((text) => text.includes(reply))

/* ══ ① 落库延迟 2 秒：轮结束后 5 秒内该回复始终可见（无一帧空窗） ══ */
const REPLY = '这是本轮回答的正文，落库要两秒，界面上一秒都不许空。'
const clockA = new Clock()
const engineA = new EngineStub()
const sessionA = createSession(clockA, engineA)
clockA.onFrame = () => sessionA.render()
const seqA = sessionA.send('写一段回复')
const PIECES_A = ['这是本轮回答', '的正文，', '落库要两秒，', '界面上一秒都不许空。']
for (const piece of PIECES_A) {
  sessionA.onEvent({ event_type: 'text_chunk', content: piece })
  clockA.advance(clockA.now + 7)
}
const endedAtA = clockA.now
sessionA.endTurn(seqA)
check('①·轮结束那一帧就看得见完整回复', containsReply(sessionA.items(), REPLY), true)

let missingFrames = 0
let emptyFrames = 0
let firstVisibleAt = -1
clockA.advance(endedAtA + 5000, (now) => {
  const items = sessionA.items()
  if (!containsReply(items, REPLY)) missingFrames += 1
  else if (firstVisibleAt < 0) firstVisibleAt = now
  if (!items.length) emptyFrames += 1
})
check('①·5 秒窗口里回复消失的帧数（桩落库延迟 2000ms）', missingFrames, 0)
check('①·5 秒窗口里界面为空的帧数', emptyFrames, 0)
ok('①·回复从第一帧起就可见（先消失再回来不算）', firstVisibleAt - endedAtA <= 1, firstVisibleAt - endedAtA)
clockA.advance(endedAtA + 6000)
const atEndA = sessionA.items()
check('①·历史落库后回复仍在（只被等价内容替换）', containsReply(atEndA, REPLY), true)
check('①·落库后不重复渲染（助手条目恰好一条）', assistantTexts(atEndA).length, 1)

/* ══ ② 流式中穿插工具 / 状态事件：正文长度时间轴单调不减 ══ */
const clockB = new Clock()
const engineB = new EngineStub()
const sessionB = createSession(clockB, engineB)
let expected = ''
let monotonic = true
let regression = null
let best = 0
const watchGrowth = () => {
  const longest = assistantTexts(sessionB.items()).reduce((max, text) => Math.max(max, text.length), 0)
  if (longest < best) { monotonic = false; regression = { at: clockB.now, was: best, now: longest } }
  best = Math.max(best, longest)
}
clockB.onFrame = () => { sessionB.render(); watchGrowth() }
const seqB = sessionB.send('跑个命令')
for (let i = 0; i < 12; i += 1) {
  expected += '第' + i + '段正文。'
  sessionB.onEvent({ event_type: 'reasoning_chunk', content: '想一下 ' + i })
  sessionB.onEvent({ event_type: 'text_chunk', content: '第' + i + '段正文。' })
  sessionB.onEvent({ event_type: 'usage_update', usage: { total_tokens: i } })
  if (i === 5) {
    sessionB.onEvent({ event_type: 'tool_start', call_id: 'c1', tool_name: 'shell' })
    sessionB.onEvent({ event_type: 'tool_running', call_id: 'c1' })
    sessionB.onEvent({ event_type: 'tool_done', call_id: 'c1', elapsed: 0.2, result_preview: 'ok' })
  }
  clockB.advance(clockB.now + 11)
}
sessionB.endTurn(seqB, { delayMs: 2000 })
clockB.advance(clockB.now + 3000)
clockB.advance(clockB.now + 4000)
ok('②·正文长度时间轴单调不减', monotonic, regression ? JSON.stringify(regression) : '')
ok('②·正文一个字都没丢', assistantTexts(sessionB.items()).join('').includes(expected),
  JSON.stringify(assistantTexts(sessionB.items()).join('').slice(-80)))
ok('②·工具行仍在（没有被后续正文挤掉）',
  sessionB.items().some((i) => i.kind === 'assistant' && i.tools.some((t) => t.callId === 'c1')), true)
ok('②·思考内容没有被正文顶掉', sessionB.items().some((i) => i.kind === 'assistant' && i.reasoning.includes('想一下 0')), true)
ok('②·正文不重复渲染（助手条目不超过 2 条：工具前后各一段）',
  assistantTexts(sessionB.items()).length <= 2,
  JSON.stringify(sessionB.items().map((i) => i.kind === 'assistant'
    ? { id: i.id, msgId: i.msgId, t: i.text.slice(0, 8), r: i.reasoning.slice(0, 6), tools: i.tools.map((x) => x.callId) }
    : i.kind)))

/* ══ ③ 一轮没结束时插队再发一条：前一轮已产出的正文不消失 ══ */
const INSERT_REPLY = '第一轮的正文还在流式里的时候用户插话'
const clockC = new Clock()
const engineC = new EngineStub()
const sessionC = createSession(clockC, engineC)
clockC.onFrame = () => sessionC.render()
const seqC = sessionC.send('第一轮')
for (const piece of ['第一轮的正文', '还在流式里', '的时候用户插话']) sessionC.onEvent({ event_type: 'text_chunk', content: piece })
// 插话**就发生在本轮还在跑、正文还在流式里的时候**（用户按下发送的那一刻）。
sessionC.insertQueued('插一句')
clockC.advance(clockC.now + 40)
const afterInsert = sessionC.items()
ok('③·插话时第一轮正文没有消失', containsReply(afterInsert, INSERT_REPLY), JSON.stringify(assistantTexts(afterInsert)))
ok('③·插话后第一轮的正文一字不差', assistantTexts(afterInsert).some((t) => t === INSERT_REPLY), true)
ok('③·插话那条自己是独立一条用户消息', userTexts(afterInsert).includes('插一句'), true)
check('③·插话后条目数只增不减', afterInsert.length, 3)
// 插话之后本轮才结束：落库要 1.5 秒，这段空窗里第一轮的正文同样不许消失。
sessionC.endTurn(seqC, { delayMs: 1500 })
const beforeEmpty = sessionC.items().length
let insertMissing = 0
let insertShrank = 0
clockC.advance(clockC.now + 1200, () => {
  if (!containsReply(sessionC.items(), INSERT_REPLY)) insertMissing += 1
  if (sessionC.items().length < beforeEmpty) insertShrank += 1
})
check('③·落库前的空窗里第一轮正文消失的帧数', insertMissing, 0)
check('③·落库前的空窗里条目数减少的帧数', insertShrank, 0)
clockC.advance(clockC.now + 3000)
check('③·落库后第一轮正文仍在且只有一条',
  assistantTexts(sessionC.items()).filter((t) => t.includes('第一轮的正文')).length, 1)
ok('③·落库后插话那条也还在', userTexts(sessionC.items()).includes('插一句'), JSON.stringify(userTexts(sessionC.items())))

/* ══ ④ 回读补齐 / 空快照：渲染条目不减少、已出现的身份不丢 ══ */
const CLEAN_REPLY = '清理前的正文要被确认掉但界面不许变少'
const clockD = new Clock()
const engineD = new EngineStub()
const sessionD = createSession(clockD, engineD)
clockD.onFrame = () => sessionD.render()
const seqD = sessionD.send('清理这一轮')
for (const piece of ['清理前的正文', '要被确认掉', '但界面不许变少']) {
  sessionD.onEvent({ event_type: 'text_chunk', content: piece })
  clockD.advance(clockD.now + 7)
}
sessionD.onEvent({ event_type: 'tool_start', call_id: 'c9', tool_name: 'shell' })
sessionD.onEvent({ event_type: 'tool_done', call_id: 'c9', elapsed: 0.1, result_preview: 'ok' })
const beforeCleanup = sessionD.items().length
sessionD.endTurn(seqD, { delayMs: 600 })
// 条目身份：有内容的条目按正文认（用户 / 助手都一样）；回读只允许替换为等价内容，绝不允许某条内容整个消失。
const identities = (items) => new Set(items.filter((i) => i.text.trim()).map((i) => i.kind + '|' + i.text.trim()))
const settledIds = identities(sessionD.items())
let lostIdentities = 0
let shrank = 0
let lostText = 0
clockD.advance(clockD.now + 4000, () => {
  const now = identities(sessionD.items())
  if (now.size < settledIds.size) shrank += 1
  for (const id of settledIds) if (!now.has(id)) { lostIdentities += 1; break }
  if (!assistantTexts(sessionD.items()).some((t) => t.includes(CLEAN_REPLY))) lostText += 1
})
check('④·整个回读过程里条目身份丢失的帧数', lostIdentities, 0)
check('④·整个回读过程里「有内容的条目」变少的帧数', shrank, 0)
check('④·整个回读过程里正文丢失的帧数', lostText, 0)
ok('④·回读后「有内容的条目」不减少', identities(sessionD.items()).size >= settledIds.size,
  settledIds.size + ' → ' + identities(sessionD.items()).size)
ok('④·回读后每一条已出现的身份都还在', [...settledIds].every((id) => identities(sessionD.items()).has(id)),
  JSON.stringify([...settledIds]))
ok('④·回读后正文一条不少', assistantTexts(sessionD.items()).some((t) => t.includes(CLEAN_REPLY)),
  JSON.stringify(assistantTexts(sessionD.items())))
ok('④·回读后工具行还在（历史里那条工具调用认得回来）',
  sessionD.items().some((i) => i.kind === 'assistant' && i.tools.some((t) => t.callId === 'c9')), true)

if (failed === 0) {
  console.log('OK  ' + total + ' 个纯逻辑断言全部通过（时钟共 ' + (clockA.frames + clockB.frames + clockC.frames + clockD.frames)
    + ' 帧）：落库延迟 2 秒下回复始终可见 / 正文单调不减 / 插话不丢前一轮 / 回读不丢身份')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 个断言失败')
  process.exit(1)
}
