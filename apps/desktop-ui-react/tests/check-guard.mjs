#!/usr/bin/env node
/**
 * 界面保险丝（src/lib/guard.ts）的纯逻辑断言：不需要浏览器、不需要引擎。
 *
 * 覆盖这三件事 —— 也正是「发消息就整屏卡死」的三条防线：
 *   ① 提交熔断：同一帧同一个 store 超过 5 次，多出来的当帧挡下；1 秒 > 60 次判风暴。
 *   ② 心跳判定：两次打点的间隔 > 3s 才算「刚刚卡过」，第一次打点与正好 3s 都不算。
 *   ③ 超时中断：折叠 / 合并超过 50ms 就放弃本次结果、退回上一拍，并记账。
 * 外加一条联动：心跳判到卡顿 → 自动进精简模式（提交窗口放宽到 100ms）+ 只提示一次。
 *
 * 断言用的是 guard.ts 里的纯函数（createCommitGate / createHeartbeat / createTaskRunner），
 * stores/session.ts 与 main.tsx 用的就是这三份单例；时间全部自己喂，不依赖真实时钟。
 *
 * 运行（Node 22+ 直接跑 TS，靠原生类型擦除）：
 *   node apps/desktop-ui-react/tests/check-guard.mjs
 */
import {
  COMMIT_LEAN_MS, COMMIT_MS, createCommitGate, createHeartbeat, createTaskRunner,
  commitWindowMs, heartbeat, isLean, leanReasonOf, overBudget, safeMode, setGuardNotice, setSafeMode,
} from '../src/lib/guard.ts'

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

/* ── ① 提交熔断：同帧同 store 第 6 次被挡下，换个帧立刻放行 ──
     时间片按 16ms 切（10000..10015 是同一帧），所以这 6 次提交确实落在同一帧里。 */
const gate = createCommitGate()
// 同帧上限已放宽到 8（0.9.9 起：流式 + 工具事件同帧到达是常态，5 太紧会误挡）。
const firstEight = [10000, 10001, 10002, 10003, 10004, 10005, 10006, 10007].map((t) => gate.report('session', t).allowed)
const ninth = gate.report('session', 10008)
check('熔断·同帧前 8 次放行、第 9 次挡下', [firstEight, ninth.allowed, ninth.blocked, ninth.frameCount],
  [[true, true, true, true, true, true, true, true], false, true, 9])
check('熔断·下一帧立刻放行（不会把 store 永久锁死）', gate.report('session', 10017).allowed, true)

/* ── ② 熔断记账：放行 / 挡下 / 单帧峰值，且不同 store 各算各的 ── */
const gate2 = createCommitGate()
for (let i = 0; i < 8; i += 1) gate2.report('session', 20000 + i)
const otherAllowed = gate2.report('other', 20000).allowed
const overBudgetFrame = gate2.report('session', 20000).allowed
const stats2 = gate2.stats()
check('熔断·账目与 store 隔离', [otherAllowed, overBudgetFrame, stats2.allowed, stats2.blocked, stats2.maxFrame],
  [true, false, 9, 1, 9])

/* ── ③ 提交风暴：1 秒内总提交越界只报一次（不是每次越界都报） ── */
let stormCalls = 0
const gate3 = createCommitGate({ onStorm: () => { stormCalls += 1 } })
// 每秒上限已放宽到 120（0.9.9 起：长输出 + 工具事件很容易贴近旧的 60，误降级比不降更糟）。
// 每次提交隔 8ms（各占一帧），前 121 次落在同一秒：越过 120 的那一下判风暴，之后不再重复回调。
for (let i = 0; i < 121; i += 1) gate3.report('session', 30000 + i * 8)
for (let i = 121; i < 126; i += 1) gate3.report('session', 30000 + i * 8)
check('风暴·越界那一秒只回调一次', [stormCalls, gate3.stats().storms, gate3.stats().blocked],
  [1, 1, 0])

/* ── ④ 关键提交：不受帧预算限制，但普通提交照样受限 ── */
const gate4 = createCommitGate({ perFrameMax: 2 })
const criticalAllowed = [0, 1, 2, 3].map((i) => gate4.report('session', 40000 + i, { critical: true }).allowed)
check('熔断·关键提交不挡、普通提交照样挡',
  [criticalAllowed, gate4.report('session', 40005).allowed, gate4.stats().blocked],
  [[true, true, true, true], false, 1])

/* ── ⑤ 心跳判定：正常间隔不算卡；>3s 算一次；正好 3s 不算（阈值是「超过」） ── */
const beat = createHeartbeat()
const b1 = beat.beat(1000)
const b2 = beat.beat(2000)
const b3 = beat.beat(6500)
const b4 = beat.beat(9500)
check('心跳·正常间隔与超时间隔的判定', [b1.stalled, b2.gap, b3.stalled, b3.stalls, b4.stalled],
  [false, 1000, true, 1, false])
// 隐藏页面里定时器被浏览器节流（可能一分钟才醒一次）：那不是卡顿，rebase 只挪基准不判定。
const rebased = createHeartbeat()
rebased.beat(1000)
const rebaseVerdict = rebased.rebase(60000)
check('心跳·页面挂起后的 rebase 不算卡、下一次间隔照常算',
  [rebaseVerdict.stalled, rebased.beat(61000).gap, rebased.stats().stalls],
  [false, 1000, 0])

const beatAtZero = createHeartbeat()
const firstAtZero = beatAtZero.beat(0)
const nextAtThree = beatAtZero.beat(3000)
check('心跳·时刻 0 的第一次打点不算卡，下一次正好 3s 也不算',
  [firstAtZero.stalled, firstAtZero.gap, nextAtThree.gap, nextAtThree.stalled],
  [false, 0, 3000, false])

/* ── ⑥ 超时中断：折叠超过预算就放弃本次结果、退回上一拍，并记账 ── */
let clock = 0
const tasks = createTaskRunner({ budgetMs: 50, clock: () => clock })
const slow = tasks.run('fold', () => { clock += 80; return '算完了但太慢' }, '上一拍')
const fast = tasks.run('fold', () => { clock += 10; return '算完了' }, '上一拍')
const taskStats = tasks.stats()
check('超时·超预算放弃、没超就采纳', [slow, fast, taskStats.timeouts, taskStats.runs, taskStats.maxMs],
  ['上一拍', '算完了', 1, 1, 80])

/* ── ⑦ 超时中断的另外两条路：deadline 自己收手、函数抛异常也退回上一拍 ── */
const tasks2 = createTaskRunner({ budgetMs: 20, clock: () => clock })
// 超预算的那一次结果一律丢掉（返回上一拍），所以「deadline 有没有生效」要从函数内部看。
let sawExpired = null
const discarded = tasks2.run('fold', (deadline) => { clock += 21; sawExpired = deadline.expired(); return '算完了' }, '上一拍')
const threw = tasks2.run('fold', () => { throw new Error('boom') }, '兜底')
check('超时·deadline 中途收手 + 异常兜底',
  [sawExpired, discarded, tasks2.stats().timeouts, threw, tasks2.stats().failures],
  [true, '上一拍', 1, '兜底', 1])
check('纯函数·overBudget 的边界', [overBudget(0, 50, 50), overBudget(0, 51, 50)], [false, true])

/* ── ⑧ 联动：心跳判到卡顿 → 自动进精简模式 + 只提示一次；安全模式开关同一条路 ── */
let notices = []
setGuardNotice((notice) => notices.push(notice))
const beforeLean = commitWindowMs()
heartbeat(1000)
heartbeat(2000)
const verdict = heartbeat(9000) // 7000ms 的空档＝这中间主线程被占住过
// 规格已改（用户明确要求）：**卡顿也不再自动降级** —— 动画与渲染质量保持不变，只记日志。
check('联动·卡顿后不自动降级（提交窗口仍是 32ms）',
  [verdict.stalled, isLean(), leanReasonOf(), beforeLean, commitWindowMs()],
  [true, false, null, COMMIT_MS, COMMIT_MS])
heartbeat(20000) // 再卡一次：依然不降级、也不提示
check('联动·不再自动提示降级', [notices.length, notices[0]?.key ?? null], [0, null])
setSafeMode(true)
const onSafe = [isLean(), leanReasonOf(), safeMode()]
setSafeMode(false)
check('安全模式·开启即精简、关掉即退出', [onSafe, isLean(), leanReasonOf(), safeMode(), commitWindowMs()],
  [[true, 'safe-mode', true], false, null, false, COMMIT_MS])

if (failed === 0) {
  console.log('OK  ' + total + ' 条断言全部通过（熔断 ' + COMMIT_MS + 'ms/帧 5 次 · 1 秒 60 次 · 心跳 3s · 折叠预算 50ms · 精简窗口 '
    + COMMIT_LEAN_MS + 'ms）')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 条断言失败')
  process.exit(1)
}
