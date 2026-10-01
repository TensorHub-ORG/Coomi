/**
 * 流式正文的渲染口径：**流式期间只画纯文本**。纯函数，不碰 React / DOM / 正则，方便冒烟。
 *
 * 为什么把「流式 Markdown」整条路砍掉（这版界面卡死的根因）：
 *   老实现每来一个 text_chunk 就把整条消息重跑一遍 splitSettled / chunkSettled / scanFenceBlocks，
 *   再按块算 chunkHash 并重解析尾巴。这些函数都是**与文本长度线性**的，而 chunk 数量也与长度线性 ——
 *   于是「一条长消息」的代价是 O(长度²)，而且全部发生在渲染期（主线程）。更糟的是渲染期还会
 *   调 primeSettle 触发结算、调 settleOnce 比对「语言 + 整块代码」的拼接串（长块上是又一次线性扫描），
 *   同时往模块级 Map 里写渲染缓存。文本越长、chunk 越密，一帧就越可能跑不完 —— 表现就是「一开始输出正文就卡死」。
 *
 * 现在的口径（ChatGPT 一类产品的通行做法，宁可少花哨也要绝不卡死）：
 *   - streaming = true：正文走 whitespace-pre-wrap 纯文本，**不做任何解析、扫描、高亮、哈希**；
 *     单次提交的渲染成本 = 一次字符串拼接级别的 O(1)（React 只改一个文本节点的 data），
 *     所以「1 万个 chunk」与「10 个 chunk」的每帧成本几乎没有差别；
 *   - streaming = false（轮结束 / 历史消息）：整段一次性 Markdown 解析 + 代码块高亮（跑在渲染之外的空闲期）。
 *     这条路上没有任何「每次提交都重算」的东西，代价只付一次。
 *
 * 下面两个函数就是这条口径的**唯一判定点**，Markdown.tsx 直接用它们：
 *   isStreaming()      —— 流式中一律纯文本，与文本长度无关（长度闸只是写出来让「大文本」显式可见，
 *                         不是「短文本才享受纯文本」的意思：流式永远纯文本，绝不会退回解析）；
 *   isPlainTooLong()   —— 超过 PLAIN_STREAM_MAX_CHARS 的正文，连非流式那一次解析也不做，
 *                         永久纯文本渲染（与 richtext/limits.ts 的 10 万字符识别闸同一套口径）。
 *
 * 注意：这里**不提供任何增量/分块能力**。将来若要重新加回「已定型块缓存」，只能作为默认关闭的
 * 可选增强，并且必须自带 8ms 时间上限 + 长度上限 + 迭代上限 + 线性化正则（见仓库历史的教训）。
 */

/** 纯文本硬上限（字符）：超过它就永远不回 Markdown 解析 —— 与 RICH_RECOGNIZE_MAX_CHARS = 10 万同一套口径。 */
export const PLAIN_STREAM_MAX_CHARS = 100_000

/** 流式中一律纯文本：与文本长度无关，永远是 true。 */
export function isStreaming(): boolean {
  return true
}

/** 正文是否超过纯文本上限（超过就永久纯文本渲染，不再做任何解析 / 高亮 / 扫描）。 */
export function isPlainTooLong(text: string, max: number = PLAIN_STREAM_MAX_CHARS): boolean {
  return text.length > max
}

/**
 * 「这一拍要不要走纯文本」：流式中恒为 true，非流式只有超长正文才继续走纯文本。
 * 冒烟脚本直接断言这个函数的输出 —— 它是「绝不卡死」这条口径的可测入口。
 */
export function shouldUsePlainText(text: string, streaming: boolean, max: number = PLAIN_STREAM_MAX_CHARS): boolean {
  if (streaming) return true
  return isPlainTooLong(text, max)
}
