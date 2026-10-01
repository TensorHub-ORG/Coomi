import { chunkSettled, scanFenceBlocks, splitSettled } from '../src/components/richtext/parse'
const F = '```'
const steps = ['# 标题一\n', '\n第一段：甲 乙 丙\n', '\n\n' + F + 'ts\n', 'const a = 1\n', F + '\n', '\n| A | B |\n', '| --- | --- |\n', '| 1 | 2 |\n', '\n- 列表一\n', '\n' + F + 'js\n', 'const b = 2\n', F + '\n', '\n末段。\n']
let text = ''
let prev = 0
let ok = true
for (const s of steps) {
  text += s
  const split = splitSettled(text)
  const back = split.settled.length < prev
  if (back) ok = false
  // 安全不变量：前缀必须是原文前缀、拼接无损、前缀内没有未闭合围栏
  if (!text.startsWith(split.settled)) { console.log('!! 不是前缀'); ok = false }
  if (split.settled + split.tail !== text) { console.log('!! 拼接有损'); ok = false }
  const pre = scanFenceBlocks(split.settled)
  const unclosed = pre.some(b => !b.closed)
  if (unclosed) { console.log('!! 前缀里有未闭合围栏'); ok = false }
  console.log('settled=' + split.settled.length + (back ? '  <== 后退!!' : ''), 'prefix=' + JSON.stringify(split.settled), 'tail=' + JSON.stringify(split.tail.slice(0, 50)))
  prev = split.settled.length
}
console.log('chunks', JSON.stringify(chunkSettled(splitSettled(text).settled).map(c => c.text)))
console.log(ok ? '单调 + 安全：通过' : '失败')
