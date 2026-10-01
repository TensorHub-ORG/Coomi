/**
 * 「哪一块代码块还在流式」的判定：以**围栏是否闭合**为准，不看外层的 streaming 标志。
 *
 * 为什么不信 streaming：流结束标志（消息停止输出）与文本到达不是同一拍，靠它判定会让
 * 收尾时又重排一次；而「围栏闭合」是文本自身的事实 —— 闭合了就永远闭合，判定单调、不会来回翻。
 *
 * 匹配方式：解析出的代码块在气泡里的源码形如 ```lang\n内容\n```，
 * 与「已闭合围栏清单（语言 + 内容）」按顺序比对，命中即说明这块已经定型（可以高亮），
 * 剩下的那一个就是还在长的尾巴块（不高亮）。
 *
 * 每次整条消息解析前调用 beginSettlePass 重置一遍；清单为空表示没有未闭合围栏，全部按已定型处理。
 *
 * 【已与渲染管线脱钩，别再往渲染期接回去】2026 版的卡死复盘：Markdown.tsx / CodeBlock.tsx 曾在**渲染期**调用
 * primeSettle + settleOnce（还会顺手经 scanFenceBlocks 全量重扫整条消息），文本越长、chunk 越密，一帧就越跑不完。
 * 现在流式期间只画纯文本、轮结束才整段解析一次（见 chat/streamText.ts 的说明与 chat/Markdown.tsx），
 * 这两个函数只保留给单测 / 探测脚本（scripts/smoke-*.ts）当纯分析工具，**渲染路径里一次都不许调**。
 *
 * 长度闸：比对 key 要把内容拼进字符串再 indexOf，超长块（> RICH_RECOGNIZE_MAX_CHARS）一律判成
 * 「不定型」——渲染期不再为它做任何长串操作，代价只是这一块不高亮（本来就超过高亮上限）。
 */
import { RICH_RECOGNIZE_MAX_CHARS } from './limits'

let settleCursor = 0
let settleKeys: string[] = []
let settleMemo = new Map<string, boolean>()

function settleKey(lang: string, code: string): string {
  return (lang || 'text') + '\u0000' + code
}

/** 解析前调用：算出本轮「已闭合」的代码块清单（含语言与内容），供渲染期按顺序消费。 */
export function beginSettlePass(keys: string[]): void {
  settleKeys = keys
  settleCursor = 0
  settleMemo = new Map()
}

/** 这一个块是否已经定型（围栏闭合）：只有 true 才允许做语法高亮。 */
export function settleOnce(lang: string, code: string): boolean {
  if (code.length > RICH_RECOGNIZE_MAX_CHARS) return false
  const memoKey = lang + '\u0000' + code
  const cached = settleMemo.get(memoKey)
  if (cached !== undefined) return cached
  const index = settleKeys.indexOf(settleKey(lang, code), settleCursor)
  const settled = index >= 0
  if (settled) settleCursor = index + 1
  // 缓存上限给得很小：它只服务「当前这一遍解析」，下一遍会整体重置。
  if (settleMemo.size > 200) settleMemo = new Map()
  settleMemo.set(memoKey, settled)
  return settled
}
