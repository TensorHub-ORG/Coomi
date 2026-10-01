#!/usr/bin/env node
/**
 * 启动引导的回归断言：**空会话列表必须落到「新建会话」**。
 *
 * 现场（真机，全新安装）：引擎里没有任何有内容的会话 → 原来的四分支判断一个都不进 →
 * sessionId 一直是空串 → connect() 第一行就 return → 界面显示「与引擎的连接已断开」，
 * 而引擎/端口/IPC 全部正常。开发机上永远有会话，所以这个洞一直没被任何测试覆盖。
 *
 * 运行：node tests/check-bootstrap.mjs
 */
import { pickStartupSession } from '../src/lib/bootstrap.ts'

let failed = 0
let total = 0
function check(name, got, want) {
  total += 1
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed += 1
    console.error('FAIL ' + name + '\n  want=' + JSON.stringify(want) + '\n  got =' + JSON.stringify(got))
  }
}

const s = (id) => ({ id })
const noDraft = () => false
const withDraft = () => true

// ① 本次故障的正身：全新机器，零会话、无记忆、无草稿
check(
  '①·零会话 + 无记忆 → 必须新建会话（否则连接永远建立不起来）',
  pickStartupSession({ sessionId: '', sessions: [], remembered: null, hasDraft: noDraft }),
  { kind: 'new' },
)

// ② 零可见会话但记着上次的草稿：按原 id 恢复，不要另开一个新的
check(
  '②·零会话 + 有草稿 → 按原 id 恢复',
  pickStartupSession({ sessionId: '', sessions: [], remembered: 's1', hasDraft: withDraft }),
  { kind: 'resume', id: 's1' },
)

// ③ 有可见会话、无记忆：打开最近一条
check(
  '③·有会话 + 无记忆 → 打开最近一条',
  pickStartupSession({ sessionId: '', sessions: [s('a'), s('b')], remembered: null, hasDraft: noDraft }),
  { kind: 'open', id: 'a' },
)

// ④ 记忆里的会话还在列表里：优先恢复它
check(
  '④·记忆命中 → 打开记忆里的那条',
  pickStartupSession({ sessionId: '', sessions: [s('a'), s('b')], remembered: 'b', hasDraft: noDraft }),
  { kind: 'open', id: 'b' },
)

// ⑤ 记忆里的会话不在列表（内容被清空/删掉）但还有草稿 → 按原 id 恢复
check(
  '⑤·记忆未命中 + 有草稿 → 按原 id 恢复',
  pickStartupSession({ sessionId: '', sessions: [s('a')], remembered: 'zz', hasDraft: withDraft }),
  { kind: 'resume', id: 'zz' },
)

// ⑥ 记忆未命中且没草稿 → 回落到最近一条，而不是新建
check(
  '⑥·记忆未命中 + 无草稿 → 打开最近一条',
  pickStartupSession({ sessionId: '', sessions: [s('a')], remembered: 'zz', hasDraft: noDraft }),
  { kind: 'open', id: 'a' },
)

// ⑦ 已经有会话了：什么都不做（幂等，别把用户正在看的会话换掉）
check(
  '⑦·已有会话 → 保持不动',
  pickStartupSession({ sessionId: 'live', sessions: [s('a')], remembered: 'a', hasDraft: noDraft }),
  { kind: 'keep' },
)

// ⑧ 任何情况下都必须有明确动作：不允许出现"什么都不做"（这正是本次故障的形态）
const cases = [
  { sessionId: '', sessions: [], remembered: null, hasDraft: noDraft },
  { sessionId: '', sessions: [], remembered: 'x', hasDraft: withDraft },
  { sessionId: '', sessions: [s('a')], remembered: null, hasDraft: noDraft },
  { sessionId: 'live', sessions: [], remembered: null, hasDraft: noDraft },
]
check(
  '⑧·每种输入都返回合法动作',
  cases.map((input) => pickStartupSession(input).kind).filter((k) => ['keep', 'open', 'resume', 'new'].includes(k)).length,
  cases.length,
)

if (failed === 0) {
  console.log('OK  ' + total + ' 条断言全部通过（启动引导：零会话必建会话 / 记忆与草稿优先 / 已有会话不动）')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 条断言失败')
  process.exit(1)
}
