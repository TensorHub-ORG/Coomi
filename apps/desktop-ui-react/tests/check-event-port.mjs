#!/usr/bin/env node
/**
 * 事件写入口（src/lib/eventPort.ts）与崩溃自救（src/lib/crashGuard.ts）的纯逻辑断言。
 *
 * 这一份是**白屏事故（切会话后整屏白、重启无效）的回归测试**，盯的就是两条老毛病：
 *   ① commitWith 以前会**主动 throw**（「只允许变短」「不允许清空」）。它被 stores/session.ts
 *      的每一次非整体替换写入调用，而传进去的是外部算好的 next —— 一旦 eventsBySession 缓存
 *      与写入口内部的 current 对不上（切会话 / 新会话 / prune 之后），next 比 current 长是常态，
 *      于是**每一次切会话都可能把异常抛进 React 渲染路径**：整棵树卸载 ＝ 整屏白。
 *      现在的契约是：越界**不抛错**，按 current 收敛（超长截断、清空补回）并记进 violations()。
 *   ② 启动自愈：短时间内崩过 >= 2 次，下一次启动直接进安全模式（见 lib/crashGuard.ts）。
 *
 * 运行（Node 22+ 直接跑 TS，靠原生类型擦除）：
 *   node apps/desktop-ui-react/tests/check-event-port.mjs
 */
import { createEventPort, runEventPortAudit } from '../src/lib/eventPort.ts'
import {
  CRASH_SELF_HEAL_AT, CRASH_WINDOW_MS, clearCrashRecord, describeComponentStack, describeError,
  readCrashRecord, recordCrash, shouldSelfHeal,
} from '../src/lib/crashGuard.ts'

let failed = 0
let total = 0
function check(name, got, want) {
  total += 1
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed += 1
    console.error('FAIL ' + name + '\n  want=' + JSON.stringify(want) + '\n  got =' + JSON.stringify(got))
  }
}
function ok(name, cond, detail = '') {
  total += 1
  if (!cond) {
    failed += 1
    console.error('FAIL ' + name + (detail ? '\n  ' + detail : ''))
  }
}

const ev = (id) => ({ event_type: 'text_chunk', content: 'c' + id })
const ids = (list) => list.map((e) => e.content)

/* ══ ① 越界输入不抛错，且结果落在合法范围（白屏事故的回归断言） ══
   合法范围：0 <= 结果长度 <= current 长度；current 非空时结果非空。 */
const growing = createEventPort([], 's1', { warn: null })
growing.commit([ev(1), ev(2)], 's1', '追加')
const cache = [ev(1), ev(2), ev(3), ev(4)] // 缓存比写入口的 current 长（切会话 / 别处更新过）
let growThrew = false
let grown = null
try {
  // 老实现：这里 throw '确认制清理只允许变短' → 异常进渲染路径 → 整屏白。
  grown = growing.commitWith(() => cache, 's1', '追加')
} catch (error) {
  growThrew = true
}
check('①·候选比 current 长时不抛错', growThrew, false)
check('①·越界结果收敛到合法范围（0 ≤ 长度 ≤ current，current 为准）', [ids(grown), grown === growing.events()], [['c1', 'c2'], true])
const growRecord = growing.violations()[0]
check('①·越界被记账（kind / 前后长度 / 未采纳的候选长度）',
  [growing.violations().length, growRecord.kind, growRecord.before, growRecord.candidate, growRecord.sessionId],
  [1, 'grow', 2, 4, 's1'])

const clearing = createEventPort([], 's2', { warn: null })
clearing.commit([ev(1)], 's2', '追加')
let clearThrew = false
let cleared = null
try {
  cleared = clearing.commitWith(() => [], 's2', '确认制清理')
} catch (error) {
  clearThrew = true
}
check('①·把非空清成空时不抛错', clearThrew, false)
check('①·清空被按 current 补回（原样留着，绝不落成空数组）', ids(cleared), ['c1'])
check('①·清空记为 clear 越界', [clearing.violations()[0].kind, clearing.violations()[0].candidate], ['clear', 0])

/* ══ ② updater 自己炸了 / 没返回数组：同样只收敛不抛错 ══ */
const boom = createEventPort([], 's3', { warn: null })
boom.commit([ev(1)], 's3', '追加')
let boomThrew = false
let afterBoom = null
try {
  afterBoom = boom.commitWith(() => { throw new TypeError('折叠函数炸了') }, 's3', '确认制清理')
} catch (error) {
  boomThrew = true
}
check('②·updater 抛错时不把异常甩出去', boomThrew, false)
check('②·updater 抛错后状态原样保留', ids(afterBoom), ['c1'])
ok('②·updater 抛错被记成 threw 且带上原因',
  boom.violations()[0].kind === 'threw' && boom.violations()[0].detail.includes('折叠函数炸了'),
  JSON.stringify(boom.violations()[0]))

const notArray = createEventPort([], 's4', { warn: null })
notArray.commit([ev(1)], 's4', '追加')
let notArrayThrew = false
let afterNotArray = null
try {
  afterNotArray = notArray.commitWith(() => undefined, 's4', '确认制清理')
} catch (error) {
  notArrayThrew = true
}
check('②·updater 返回 undefined 时不抛错、状态原样',
  [notArrayThrew, ids(afterNotArray), notArray.violations()[0].kind], [false, ['c1'], 'invalid'])

/* ══ ③ 合法的确认制清理照旧生效（收敛不能把正常路径一起废掉） ══ */
const legal = createEventPort([], 's5', { warn: null })
legal.commit([ev(1), ev(2), ev(3)], 's5', '追加')
const kept = legal.commitWith((current) => current.filter((e) => e.content !== 'c2'), 's5', '确认制清理')
check('③·合法清理（只变短、不清空）照旧落库', [ids(kept), legal.violations().length], [['c1', 'c3'], 0])
check('③·写入口的事件数组就是唯一真值', ids(legal.events()), ['c1', 'c3'])
check('③·sessionId() 跟着写入走', legal.sessionId(), 's5')

/* ══ ④ 越界的两个出口：回调每次都有，日志每个 label 只完整报一次 ══ */
const seen = []
const logged = []
const noisy = createEventPort([ev(1)], 's6', {
  onViolation: (v) => seen.push(v.kind),
  warn: (message, v) => logged.push(v.label + '|' + message.includes('已按当前状态收敛')),
})
noisy.commitWith(() => [ev(1), ev(2)], 's6', '追加')
noisy.commitWith(() => [], 's6', '追加')
noisy.commitWith(() => [ev(1), ev(2)], 's6', '确认制清理')
check('④·onViolation 每次越界都回调', seen, ['grow', 'clear', 'grow'])
check('④·日志按 label 去重（同一个 label 只完整报一次）', logged, ['追加|true', '确认制清理|true'])

/* ══ ⑤ 审计照旧：收敛掉的越界不落成写入，流水仍然连续、append 只增、replace 只有两条合法路径 ══ */
const auditPort = createEventPort([], 'live', { onWrite: null, warn: null })
const observed = []
// 直接换成带观测的入口，按真实时序跑一遍：换缓存 → 追加 → 越界（收敛）→ 确认制清理
const timed = createEventPort([], 'live', { warn: null, onWrite: (o) => observed.push(o) })
timed.replace([], 'live', '换缓存')
timed.commit([ev(1)], 'live', '追加')
timed.commitWith(() => [ev(1), ev(2), ev(3)], 'live', '追加') // 越界：收敛，不落写入
timed.commit([ev(2)], 'live', '追加')
timed.commitWith((current) => current.slice(0, 1), 'live', '确认制清理')
const audit = runEventPortAudit(observed)
ok('⑤·审计全绿（收敛掉的越界没有污染写入流水）', audit.ok, audit.reasons.join(' | '))
check('⑤·写入条数 = 4（越界那一次没落库）', [timed.writes().length, observed.length], [4, 4])
check('⑤·审计能抓出中途乱替换（规则没被放宽）',
  runEventPortAudit([{ write: { id: 1, sessionId: 'x', stage: 'replace', label: '随便换掉', size: 0 }, before: 3, after: [] }]).ok,
  false)
check('⑤·审计能抓出「拿旧快照覆盖」造成的变短',
  runEventPortAudit([
    { write: { id: 1, sessionId: 'x', stage: 'append', label: '追加', size: 3 }, before: 0, after: [ev(1), ev(2), ev(3)] },
    { write: { id: 2, sessionId: 'x', stage: 'append', label: '追加', size: 2 }, before: 3, after: [ev(1), ev(2)] },
  ]).ok,
  false)
check('⑤·reset() 把写入账与越界账一起清零',
  (() => { auditPort.commit([ev(1)], 'live'); auditPort.commitWith(() => [ev(1), ev(2)], 'live'); auditPort.reset()
    return [auditPort.writes().length, auditPort.violations().length] })(),
  [0, 0])

/* ══ ⑥ 崩溃摘要：用户看到的必须是一句人话（任意抛出物都不许显示 undefined） ══ */
ok('⑥·Error 摘要带名字与信息', describeError(new TypeError('x is not a function')).title === 'TypeError：x is not a function')
ok('⑥·字符串抛出物也能读', describeError('引擎挂了').title === 'Error：引擎挂了')
ok('⑥·undefined 也有兜底文案', describeError(undefined).title.includes('undefined') && describeError(undefined).detail.length > 0,
  JSON.stringify(describeError(undefined)))
const cyclic = {}; cyclic.self = cyclic
ok('⑥·循环引用不会让摘要自己炸掉', describeError(cyclic).title.length > 0)
check('⑥·组件栈只留头几行', describeComponentStack({ componentStack: '\n  at A\n  at B\n  at C\n  at D\n  at E\n' }).split(' ← ').length, 4)
check('⑥·没有组件栈时给空串（不是 undefined）', describeComponentStack(undefined), '')

/* ══ ⑦ 启动自愈：崩两次 → 下一次启动进安全模式；账过了窗口就作废 ══ */
const store = new Map()
const storage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, v) },
  removeItem: (k) => { store.delete(k) },
}
const T0 = 1_000_000
check('⑦·没崩过 → 不自愈', shouldSelfHeal(T0, storage), false)
const first = recordCrash('root', new Error('第一次'), T0, storage)
check('⑦·第一次崩溃只记一次、不触发自愈', [first.count, shouldSelfHeal(T0 + 1000, storage)], [1, false])
// 同一次崩溃会被 StrictMode / 内外两层边界重复上报：5 秒内同 scope 同标题只算一次
recordCrash('root', new Error('第一次'), T0 + 200, storage)
check('⑦·重复上报（StrictMode）不重复计数', readCrashRecord(storage).count, 1)
const second = recordCrash('root', new Error('第二次'), T0 + 2000, storage)
check('⑦·第二次崩溃累加', second.count, 2)
check('⑦·崩到阈值 → 下一次启动自愈（进安全模式）', [CRASH_SELF_HEAL_AT, shouldSelfHeal(T0 + 3000, storage)], [2, true])
// 账上的 lastAt 是 T0+2000：超过窗口之后再来问，这一次故障就算过去了。
check('⑦·窗口之外的旧账不算数', shouldSelfHeal(T0 + 2000 + CRASH_WINDOW_MS + 1, storage), false)
recordCrash('root', new Error('很久以后'), T0 + 2000 + CRASH_WINDOW_MS + 2, storage)
check('⑦·窗口外的第一笔重新从 1 记起', readCrashRecord(storage).count, 1)
clearCrashRecord(storage)
check('⑦·清账之后不自愈', [readCrashRecord(storage), shouldSelfHeal(T0 + 2000 + CRASH_WINDOW_MS + 3, storage)], [null, false])
storage.setItem('coomi.crash.v1', '{半个坏 JSON')
check('⑦·半个坏 JSON 不会让启动路径跟着崩', [readCrashRecord(storage), shouldSelfHeal(T0, storage)], [null, false])

if (failed === 0) {
  console.log('OK  ' + total + ' 个纯逻辑断言全部通过（越界不抛错并按 current 收敛 / 审计流水仍然连续 / 崩溃自愈判据）')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 个断言失败')
  process.exit(1)
}
