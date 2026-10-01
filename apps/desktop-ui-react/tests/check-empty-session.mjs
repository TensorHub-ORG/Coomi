#!/usr/bin/env node
/**
 * 「新建但还没发第一条消息」的空会话 + 空态轮换文案：纯逻辑断言（不需要浏览器、不需要引擎）。
 *
 * 覆盖这次改的两件事：
 *   ① 点「新建对话」时引擎那边立刻多出一条空记录，但左侧列表**不该**为它占一行
 *      （那行只会显示「未命名对话」）—— 发出第一条消息后才出现，并且是当前会话（列表按 id 高亮）；
 *      没发消息就切走 = 丢弃这条空会话，草稿桶（coomi.draft.v1.<id>）原样保留；
 *   ② 空态轮换文案池与开关（coomi.rotateCopy.v1，默认开，每 14 秒一组）。
 *
 * 运行（Node 22+ 直接跑 TS，靠原生类型擦除）：
 *   node apps/desktop-ui-react/tests/check-empty-session.mjs
 */
import {
  EMPTY_SESSIONS_KEY, firstMessageSummary, firstMessageTitle,
  readHiddenEmptySessions, splitHiddenSessions, writeHiddenEmptySessions,
} from '../src/lib/emptySession.ts'
import {
  ROTATE_COPY_KEY, ROTATE_COPY_MS, ROTATE_COPY_POOL, nextCopyIndex, parseRotateCopy, randomCopyIndex,
} from '../src/lib/rotateCopy.ts'

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
function ok(name, cond, detail = '') {
  total += 1
  if (!cond) { failed += 1; console.error('FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 假 storage：与 localStorage 的这两个方法同行为，另外把键留下来给断言看。 */
function fakeStore() {
  const mem = new Map()
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, v) },
    raw: mem,
  }
}

/* ① 新建未发：引擎列表里有它，界面也看不到它（＝ sessions 不增）。 */
const store = fakeStore()
const engineList = [
  { id: 'a', title: '老会话', preview: '老会话', cwd: 'C:/w' },
  // 刚点完「新建对话」：引擎已经落了空记录（title / preview 都是空串）。
  { id: 'new1', title: '', preview: '', cwd: 'C:/w' },
]
writeHiddenEmptySessions(store, ['new1'])
check('「未发名单」落盘可回读', readHiddenEmptySessions(store), ['new1'])
check('键名独立（不并进 prefs）', EMPTY_SESSIONS_KEY, 'coomi.emptySessions.v1')
const first = splitHiddenSessions(engineList, new Set(readHiddenEmptySessions(store)))
check('新建后 sessions 不增（空记录被滤掉）', first.visible.map((s) => s.id), ['a'])
check('自愈名单里没有它', first.healed, [])
// 引用不变的判据是「这一次没有任何东西被挡掉」——所以喂一份**没有空记录**的列表；
// engineList 里有 new1（空 title + 空 preview），新版规则会按内容挡掉它，自然不是同一个数组。
const solidList = [{ id: 'a', title: '老会话', preview: '老会话', cwd: 'C:/w' }]
ok('没有需要挡掉的项时原样返回同一个数组（不白重渲染）',
  splitHiddenSessions(solidList, new Set()).visible === solidList)

/* ② 发出第一条消息：sessions +1，标题取正文第一行（不是「未命名对话」）。 */
const entry = firstMessageSummary('new1', '帮我写一个 vite 插件\n第二行', 'C:/w', 1000)
check('标题取正文第一行', [entry.title, entry.preview], ['帮我写一个 vite 插件', '帮我写一个 vite 插件'])
check('超长截断到 42 字', firstMessageTitle('x'.repeat(80)).length, 42)
check('空正文兜底为空串', firstMessageTitle('   \n  '), '')
check('这一行落的是当前会话 id（列表据此高亮）', entry.id, 'new1')
const afterSend = new Set(readHiddenEmptySessions(store))
afterSend.delete('new1')
writeHiddenEmptySessions(store, afterSend)
// 发完首条后引擎会把这行写回 title/preview（这是它从此可见的依据，而不是靠本地名单放行）。
check('发送首条后 sessions +1（引擎回读也看得见它）',
  splitHiddenSessions(
    [...engineList.slice(0, 1), { id: 'new1', title: entry.title, preview: entry.preview }],
    new Set(readHiddenEmptySessions(store)),
  ).visible.length, 2)

/* ③ 没发消息就切走：这条空会话被丢弃（名单不动），草稿桶不归它管、一个字都不动。 */
check('切走后空会话仍然不进列表',
  splitHiddenSessions([{ id: 'new2', title: '', preview: '' }], new Set(['new2'])).visible, [])
check('名单过期也能自愈：引擎已经有标题就放出来',
  splitHiddenSessions([{ id: 'new3', title: '说过话了', preview: 'x' }], new Set(['new3'])).visible.length, 1)

/* ④ 空态轮换文案：池子、节奏、随机起点与开关。 */
check('池子七条、顺序固定', [ROTATE_COPY_POOL.length, ROTATE_COPY_POOL[0], ROTATE_COPY_POOL[6]],
  [7, '开始新对话', '先说清楚，再动手'])
check('轮换节奏 14 秒', ROTATE_COPY_MS, 14000)
ok('随机起点始终落在池内',
  [0, 0.5, 0.999, 1.5, -0.2].every((r) => { const i = randomCopyIndex(7, () => r); return i >= 0 && i < 7 }))
check('到底回头', [nextCopyIndex(6, 7), nextCopyIndex(0, 7)], [0, 1])
ok('默认开 / 只有显式 0 才是关',
  parseRotateCopy(null) === true && parseRotateCopy('1') === true && parseRotateCopy('0') === false)
check('开关键名独立', ROTATE_COPY_KEY, 'coomi.rotateCopy.v1')

console.log('')
if (failed) { console.error(failed + ' / ' + total + ' 条断言失败'); process.exit(1) }
console.log('全部通过：' + total + ' 条断言')
