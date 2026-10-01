#!/usr/bin/env node
/**
 * 输入区「按会话分桶」的纯逻辑断言（不需要浏览器、不需要引擎）。
 *
 * 覆盖这次修的 bug：在会话 A 里加了附件 / 引用，切到会话 B 它们还在（甚至会被发进 B）。
 * 断言的就是这条路径本身：
 *   A 加附件与引用 → 切 B 必须为空 → 切回 A 仍然在 → 在 A 发送成功后 A 清空、B 不受影响
 *   → 删会话把三个桶一起清掉；另外确认历史回读的消息元数据不会灌进输入区。
 *
 * 运行（Node 22+ 直接跑 TS，靠原生类型擦除）：
 *   node apps/desktop-ui-react/tests/check-session-input.mjs
 */
import {
  ATTACHMENTS_PREFIX, DRAFT_PREFIX, INPUT_PREFIXES, QUOTES_PREFIX,
  bucketKey, clearInput, dropSessionBuckets, loadInput, readList, saveInput, writeList,
} from '../src/lib/sessionInput.ts'

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

/** 假 storage：行为与 localStorage 的这三个方法一致，另外把键留下来给断言看。 */
function fakeStore() {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    keys: () => [...map.keys()].sort(),
  }
}

const fileA = { path: 'G:/work/a.xlsx', name: 'a.xlsx', size: 2048 }
const quoteA = { id: 'q1', text: '引用 A 里的一段话', msgId: 'm-1', at: 1700000000000 }
const empty = { draft: '', quotes: [], attachments: [] }

const store = fakeStore()

/* ── ① 会话 A：加附件 + 引用（等同 Composer 里逐个 addAttachments / addQuote 的落盘） ── */
saveInput(store, 'A', { draft: '看看这个表', quotes: [quoteA], attachments: [fileA] })
check('A·桶写在了 A 的键上', store.keys(), [
  ATTACHMENTS_PREFIX + 'A',
  DRAFT_PREFIX + 'A',
  QUOTES_PREFIX + 'A',
].sort())

/* ── ② 切到会话 B：输入区必须是空的（这就是这次的 bug） ── */
check('切到 B·输入区为空', loadInput(store, 'B'), empty)

/* ── ③ 切回会话 A：附件与引用原样还在 ── */
check('切回 A·附件与引用仍在', loadInput(store, 'A'), {
  draft: '看看这个表',
  quotes: [quoteA],
  attachments: [fileA],
})

/* ── ④ 在 A 发送成功：只清 A 这一份，B 的待发送内容一个字不动 ── */
saveInput(store, 'B', { draft: 'B 的草稿', quotes: [], attachments: [{ path: 'G:/work/b.png' }] })
clearInput(store, 'A')
check('A 发送后·A 清空', loadInput(store, 'A'), empty)
check('A 发送后·B 不受影响', loadInput(store, 'B'), {
  draft: 'B 的草稿',
  quotes: [],
  attachments: [{ path: 'G:/work/b.png' }],
})
check('A 发送后·A 的三个键都删掉了', store.keys(), [ATTACHMENTS_PREFIX + 'B', DRAFT_PREFIX + 'B'].sort())

/* ── ⑤ 删会话 B：三个桶一起清（localStorage 不无限长） ── */
saveInput(store, 'B', { draft: 'B 的草稿', quotes: [quoteA], attachments: [{ path: 'G:/work/b.png' }] })
dropSessionBuckets(store, 'B')
check('删会话·桶清空', store.keys(), [])

/* ── ⑥ 边角：没有会话 id 时不写「没有归属的桶」 ── */
saveInput(store, '', { draft: '游离内容', quotes: [quoteA], attachments: [fileA] })
check('无会话 id·一个键都不写', store.keys(), [])
check('无会话 id·桶键为空串', bucketKey(ATTACHMENTS_PREFIX, ''), '')

/* ── ⑦ 边角：坏数据 / 空列表 ── */
store.setItem(QUOTES_PREFIX + 'C', '{不是数组}')
check('坏 JSON·当空数组', readList(store, QUOTES_PREFIX, 'C'), [])
writeList(store, ATTACHMENTS_PREFIX, 'C', [])
check('空列表·不落键', store.map.has(ATTACHMENTS_PREFIX + 'C'), false)

/* ── ⑧ 历史回读的结构化 attachments/quotes 属于消息元数据，不能灌进输入区 ── */
store.setItem('coomi.msgmeta.v1.C', JSON.stringify([
  { text: '历史里的问题', at: 1, attachments: [fileA], quotes: [quoteA] },
]))
check('历史元数据·输入区仍为空', loadInput(store, 'C'), empty)
check('历史元数据·前缀与输入区不重合', INPUT_PREFIXES.some((p) => 'coomi.msgmeta.v1.C'.startsWith(p)), false)

if (failed === 0) {
  console.log('OK  ' + total + ' 个纯逻辑断言全部通过（输入区按会话分桶 / 切会话不串味 / 发送只清当前会话）')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 个断言失败')
  process.exit(1)
}
