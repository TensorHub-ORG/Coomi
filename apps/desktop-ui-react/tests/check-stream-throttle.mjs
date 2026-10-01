#!/usr/bin/env node
/**
 * 流式提交节流的纯逻辑断言（不需要浏览器、不需要引擎）。
 *
 * 覆盖这次改的东西：text_chunk 的 state 提交从「每个动画帧一次」降到「每 32ms 一次（≈30fps）」。
 * 节流最容易踩的两个坑，就是这里断言的两件事：
 *   ① 合并不丢字 —— 窗口里攒下的 chunk 必须原样、按到达顺序并进事件数组；
 *   ② turn_end 刷干净 —— 最后一个 chunk 之后立刻 turn_end，那一帧也要一个字不少地落地。
 * 断言用的是 src/lib/streamCommit.ts 里那份纯函数（stores/session.ts 的 scheduleFlush /
 * flushChunks 用的就是它），时间线按 4ms 一个 chunk 走一遍。
 *
 * 运行（Node 22+ 直接跑 TS，靠原生类型擦除）：
 *   node apps/desktop-ui-react/tests/check-stream-throttle.mjs
 */
import { CHUNK_COMMIT_MS, chunkText, commitChunks, commitDelay, countChars } from '../src/lib/streamCommit.ts'

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

const chunk = (text) => ({ event_type: 'text_chunk', content: text })
const textOf = (events) => events.filter((e) => e.event_type === 'text_chunk').map((e) => e.content).join('')

/* ── ① 正文口径：三种字段名都认，字数在到达时就算得出来 ── */
check('正文口径·content', chunkText({ content: '甲' }), '甲')
check('正文口径·delta', chunkText({ delta: '乙' }), '乙')
check('正文口径·text', chunkText({ text: '丙' }), '丙')
check('正文口径·都没有时是空串', chunkText({}), '')
check('字数·只数非空白字符', countChars({ content: ' 你 好 \n 世界 ' }), 4)

/* ── ② 节流窗口：两次提交至少隔 CHUNK_COMMIT_MS ── */
check('窗口·刚刚提交过→要等满一个窗口', commitDelay(1000, 1000), CHUNK_COMMIT_MS)
check('窗口·过了 10ms→还差 22ms', commitDelay(1010, 1000), 22)
check('窗口·正好到点→可以提交', commitDelay(1000 + CHUNK_COMMIT_MS, 1000), 0)
check('窗口·早就过了→可以提交（不会被无限推后）', commitDelay(99999, 1000), 0)

/* ── ③ 提交合并：顺序不变、条数一条不少；空缓冲不换 state ── */
const base = [{ event_type: 'user_message' }]
check('提交·空缓冲返回原数组（同一个引用，不白换一份 state）', commitChunks(base, []) === base, true)
const mergedOnce = commitChunks(base, [chunk('a'), chunk('b'), chunk('c')])
check('提交·合批顺序不变', mergedOnce.map((e) => e.content ?? e.event_type), ['user_message', 'a', 'b', 'c'])
check('提交·原数组不被就地改（React 靠引用变化判断更新）', base.length, 1)

/* ── ④ 时间线模拟：引擎按 4ms 推 200 个 chunk，节流按 commitDelay 到点提交 ──
     照着 stores/session.ts 的时序走：到达时进缓冲 → 没有待提交的那一拍就排一拍
     （窗口已过并到下一帧 ≈ 16ms，未到就等剩余窗口）→ 到点一次性 set()；
     最后一次 arrivals 之后像 turn_end 那样**同步 flush** 收尾。 */
const CHUNKS = 200
const GAP_MS = 4
const FRAME_MS = 16
const all = []
for (let i = 0; i < CHUNKS; i += 1) all.push(chunk('字' + i))

let events = []
let buffer = []
let lastCommitAt = 0
let commits = 0
let pending = -1 // 排好的下一拍提交时刻（-1 ＝ 没有待提交的那一拍）

const fire = (at) => {
  events = commitChunks(events, buffer)
  buffer = []
  commits += 1
  lastCommitAt = at
  pending = -1
}

for (let i = 0; i < CHUNKS; i += 1) {
  const now = i * GAP_MS
  // 排好的那一拍到点了（定时器 / rAF 回调发生在两次到达之间）
  if (pending >= 0 && pending <= now) fire(pending)
  buffer.push(all[i])
  if (pending < 0) {
    const wait = commitDelay(now, lastCommitAt)
    pending = now + (wait === 0 ? FRAME_MS : wait)
  }
}
// 最后一个 chunk 之后立刻 turn_end：调用方先同步 flush（stores/session.ts 的 turn_end 分支）
events = commitChunks(events, buffer)
buffer = []
commits += 1
events.push({ event_type: 'turn_end' })

check('不丢字·最终正文与逐条拼接完全一致', textOf(events), textOf(all))
check('不丢字·chunk 条数一条不少', events.filter((e) => e.event_type === 'text_chunk').length, CHUNKS)
check('不丢字·顺序仍是到达顺序（首尾各抽查一条）',
  [events[0].content, events[events.length - 2].content], ['字0', '字' + (CHUNKS - 1)])
check('turn_end·最后一个 chunk 排在 turn_end 之前（flush 干净）', events[events.length - 2], all[CHUNKS - 1])
check('turn_end·flush 之后缓冲是空的（没有残文留给下一轮）', buffer.length, 0)
check('节流·提交次数 ≤ 总时长 / 窗口 + 2',
  commits <= Math.floor((CHUNKS * GAP_MS) / CHUNK_COMMIT_MS) + 2, true)
check('节流·提交次数远小于 chunk 数（确实是合批提交）', commits < CHUNKS / 4, true)

/* ── ⑤ 边角：一条 chunk 也得提交（不许「攒着不画」） ── */
check('边角·单条 chunk 照样提交', textOf(commitChunks([], [chunk('独苗')])), '独苗')

if (failed === 0) {
  console.log('OK  ' + total + ' 个纯逻辑断言全部通过（' + CHUNK_COMMIT_MS + 'ms 合批提交 / 不丢字 / turn_end 刷干净；'
    + CHUNKS + ' 个 chunk（每 ' + GAP_MS + 'ms 一个）合成 ' + commits + ' 次 state 提交）')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 个断言失败')
  process.exit(1)
}
