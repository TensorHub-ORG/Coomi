#!/usr/bin/env node
/**
 * 提交闸门顺延「值补丁」的丢消息回归测试。
 *
 * 根因（session.ts 提交闸门 + 值补丁的组合缺陷）：
 *   session.ts 的 set()（src/stores/session.ts:694-698）在提交闸门判定同帧超预算时，
 *   把本次补丁**顺延**进 deferred 队列，16ms 后由 flushDeferred()（行 678-692）合并提交。
 *   合并时**函数补丁**按「当时的最新 state」依次求值（见行 687：`one({ ...state, ...patch })`），
 *   永远不旧；而**值补丁**（`{ messages: nextMessages }` 这类预先算好的数组）是调用方在
 *   **调用时刻**用 get().messages 算出来的快照（见行 810/1927 的
 *   `applyEventsToMessages(get().messages, [ev], ...)`）。
 *   —— 一旦被顺延，晚一拍 flush 时就会用这份旧快照整体覆盖掉期间新增的条目
 *   （刚发出去的乐观用户消息 / 还在流式的正文），表现为「我发的消息被吞了」，
 *   且整条 messages 数组引用被换掉 → 列表整段重渲染（用户看到的「闪烁一下」）。
 *
 * 两条断言（修复前红、修复后绿）：
 *   ① 来源不变量：session.ts 里任何走节流 set() 的补丁都**不得携带预先算好的 messages 数组**
 *      —— messages 变更必须走函数补丁，在应用 / 合并那一刻基于最新 state 求值。
 *      修复前：src/stores/session.ts:817 与 :1930 违反；修复后全部通过。
 *   ② 机制复现：用真实的 createCommitGate（src/lib/guard.ts）+ 与 session.ts 行 674-698
 *      逐字一致的队列模型，按当前源码里实际存在的补丁形态（值补丁 / 函数补丁）模拟
 *      「乐观用户消息入队 + messages 补丁顺延」的两条时序，断言用户消息一条不丢。
 *      修复前（值补丁形态）失败；修复后（函数补丁形态）通过。
 *
 * 运行（Node 22+ 直接跑 TS，靠原生类型擦除）：
 *   node tests/check-deferred-clobber.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCommitGate } from '../src/lib/guard.ts'
import { applyEventsToMessages } from '../src/lib/chat.ts'

const SESSION_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/stores/session.ts')

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

function lineOf(src, idx) {
  let n = 1
  for (let i = 0; i < idx && i < src.length; i += 1) if (src[i] === '\n') n += 1
  return n
}

/** 数组型状态：这些键的任何变更都必须是函数补丁或 commitCritical（见下方不变量②）。 */
const ARRAY_KEYS = ['messages', 'quotes', 'attachments', 'sessions']

/** 扫 session.ts：走节流 set() 且带**数组型状态键**的**值补丁**（函数补丁不算；
 *  字面量数组是幂等的、不会用旧快照覆盖，放行）。 */
function valuePatchMessages(src) {
  const re = /(^|[^A-Za-z0-9_$])(set|commitCritical)\(/g
  const hits = []
  let m
  while ((m = re.exec(src))) {
    const callName = m[2]
    if (callName !== 'set') continue
    const openParen = re.lastIndex - 1
    let depth = 0
    let end = -1
    for (let i = openParen; i < src.length; i += 1) {
      const c = src[i]
      if (c === '(') depth += 1
      else if (c === ')') { depth -= 1; if (depth === 0) { end = i; break } }
    }
    if (end < 0) continue
    const arg = src.slice(openParen + 1, end)
    if (/^\s*\(/.test(arg)) continue // 函数补丁：(s) => ...
    for (const key of ARRAY_KEYS) {
      // 命中 `key:` 且值不是数组/对象字面量（字面量幂等，没有旧快照可言）。
      const km = new RegExp('(^|[^A-Za-z0-9_$])' + key + '\\s*:\\s*([^,}\n]+)').exec(arg)
      if (!km) continue
      const value = km[2].trim()
      if (value.startsWith('[') || value.startsWith('{')) continue
      hits.push({ line: lineOf(src, openParen), arg: key + ': ' + value.slice(0, 50) })
    }
  }
  return hits
}

/* ── ① 来源不变量：messages 变更不得走「预先算好的值补丁」 ── */
const sessionSrc = readFileSync(SESSION_SRC, 'utf8')
const risky = valuePatchMessages(sessionSrc)
check('不变量·节流 set() 不得携带预先算好的 messages 数组（值补丁）',
  risky.map((r) => r.line), [])
if (risky.length) {
  console.error('      违反位置：' + risky.map((r) => '行 ' + r.line + ' `' + r.arg + '`').join('；'))
}

/* ── ② 机制复现：按当前源码实际形态（值/函数补丁）跑队列模型 ── */
/**
 * 与 session.ts 行 674-698 逐字一致的队列模型：
 *   let deferred: SessionPatch[] = []
 *   const flushDeferred = () => { ... }
 *   const set = (patch) => { if (reportCommit('session')) { applyPatch(patch); return } deferred.push(patch); ... }
 * 唯一差异：时间用注入的假时钟（gate 的帧判定喂假时刻），flush 由测试手动触发（模拟定时器到期 / 迟到）。
 */
function runStorm(messagesPatchForm) {
  const gate = createCommitGate()
  let now = 0
  let state = { messages: [] }
  let deferred = []
  let seq = 0
  const clock = () => now

  const flushDeferred = () => {
    if (!deferred.length) return
    const queued = deferred
    deferred = []
    gate.report('session', clock(), { critical: true }) // 镜像 reportCommit('session', true)
    let patch = {}
    for (const one of queued) {
      const part = typeof one === 'function' ? one({ ...state, ...patch }) : one
      patch = { ...patch, ...part }
    }
    state = { ...state, ...patch }
  }
  const set = (patch) => {
    if (gate.report('session', clock(), {}).allowed) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
      return
    }
    deferred.push(patch)
  }

  // 场景底料：已有一条用户消息，随后引擎故障事件到达（agent_error）。
  const u1 = { kind: 'user', id: 'u1', text: '你好', at: 1 }
  const u2 = { kind: 'user', id: 'u2', text: '第二条（乐观条目）', at: 2 }
  const errEv = { event_type: 'agent_error', message: '引擎暂时无响应，本轮已中断。', code: 'engine_gone' }
  state.messages = [u1]

  // 帧 N：8 次普通提交烧完本帧预算（工具/用量/状态事件齐到的常态）。
  now = 1000
  for (let i = 0; i < 8; i += 1) set({ runState: i % 2 ? 'executing' : 'thinking' })

  // 第 9 次：用户发消息 → 乐观条目入队（函数补丁，先入队）。
  set((s) => ({ messages: [...s.messages, u2] }))

  // 第 10 次：看门狗 / 断连路径的 messages 补丁，按当前源码形态生成：
  //   · value 形态（修复前：session.ts:810/1927 预先算好数组）→ 快照缺 u2；
  //   · fn 形态（修复后）→ 合并那一刻基于最新 state 求值。
  let survivedSameBatch
  if (messagesPatchForm === 'value') {
    const stale = applyEventsToMessages(state.messages, [errEv], seq += 1) // 快照：此刻不含 u2
    set({ linkError: '', interrupted: true, messages: stale })
  } else {
    set((s) => ({ linkError: '', interrupted: true, messages: applyEventsToMessages(s.messages, [errEv], seq += 1) }))
  }
  now = 1016
  flushDeferred()
  survivedSameBatch = state.messages.some((m) => m.id === 'u2')

  // 场景二（跨帧 + 迟到 flush）：messages 补丁先被顺延；下一帧用户又发一条，乐观条目
  // 直接命中（预算已重置）；随后熔断 flush 才到（主线程被提交风暴占住 → 定时器迟到）。
  {
    const gate2 = createCommitGate()
    let now2 = 2000
    let state2 = { messages: [u1] }
    let deferred2 = []
    let seq2 = 0
    const clock2 = () => now2
    const flush2 = () => {
      if (!deferred2.length) return
      const queued = deferred2
      deferred2 = []
      gate2.report('session', clock2(), { critical: true })
      let patch = {}
      for (const one of queued) {
        const part = typeof one === 'function' ? one({ ...state2, ...patch }) : one
        patch = { ...patch, ...part }
      }
      state2 = { ...state2, ...patch }
    }
    const set2 = (patch) => {
      if (gate2.report('session', clock2(), {}).allowed) {
        state2 = { ...state2, ...(typeof patch === 'function' ? patch(state2) : patch) }
        return
      }
      deferred2.push(patch)
    }
    for (let i = 0; i < 8; i += 1) set2({ runState: 'thinking' })
    if (messagesPatchForm === 'value') {
      const stale = applyEventsToMessages(state2.messages, [errEv], seq2 += 1)
      set2({ linkError: '', interrupted: true, messages: stale })
    } else {
      set2((s) => ({ linkError: '', interrupted: true, messages: applyEventsToMessages(s.messages, [errEv], seq2 += 1) }))
    }
    now2 = 2017 // 下一帧：预算重置
    set2((s) => ({ messages: [...s.messages, u2] })) // 直接命中（非顺延）
    now2 = 2030
    flush2() // 迟到的熔断 flush：值补丁会用旧快照覆盖 u2
    return survivedSameBatch && state2.messages.some((m) => m.id === 'u2')
  }
}

const pattern = risky.length ? 'value' : 'fn'
const stormOk = runStorm(pattern)
check('机制·顺延风暴后乐观用户消息一条不丢（当前源码形态=' + pattern + '）', stormOk, true)
if (!stormOk) {
  console.error('      复现：值补丁（' + risky.map((r) => '行 ' + r.line).join('、')
    + '）被闸门顺延后，用旧快照覆盖了刚发出去的乐观用户消息 → 消息被吞。')
}

if (failed === 0) {
  console.log('OK  ' + total + ' 条断言全部通过（闸门顺延不再吞消息）')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 条断言失败')
  process.exit(1)
}
