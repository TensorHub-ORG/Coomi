/**
 * 对话正文的 Markdown 渲染：**流式期间只画纯文本，轮结束才解析一次**。
 *
 * 三层口径（宁可少花哨，也要绝不卡死）：
 *   1) streaming = true：正文走 <div class="whitespace-pre-wrap"> 纯文本 —— 保留换行、可选中、带流式光标；
 *      **完全不调用 Markdown 解析、不做语法高亮、不做任何正则扫描 / 哈希 / 分块**。
 *      每次 text_chunk 提交的渲染成本因此是常数级（React 只改那个文本节点的 data），
 *      与「消息有多长、已经来了多少 chunk」无关 —— 正文一长就卡死的那条路被整条拆掉了。
 *   2) streaming = false（轮结束 / 历史消息）：整段一次性解析 + 代码块高亮（高亮仍跑在空闲期，见 CodeBlock）。
 *      2026 版的教训：绝不能再在渲染期做「每次都重算」的全量扫描（splitSettled / scanFenceBlocks /
 *      chunkHash / settleOnce 都在这里，它们是 O(长度) 起步、叠加 chunk 数量就是 O(长度²)），
 *      所以这几个函数与 Markdown.tsx 彻底脱钩；richtext/parse.ts 只留作纯分析工具（单测 / 探测脚本用）。
 *   3) 超长正文（> PLAIN_STREAM_MAX_CHARS）：连非流式那一次解析也不做，永久纯文本渲染。
 *
 * 光标与段落动画全是纯 CSS（.md-body[data-caret] 的伪元素 + base.css 的 @starting-style），
 * 这里没有任何每帧 setState。
 */
import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import { cn } from '../../lib/cn'
import { hasSettledTable, isPlainTooLong, isStreaming } from './streamText'
import { FileChipEnabled, FileLinkAnchor } from './FileChip'
import { ReactMarkdown, markdownComponents, remarkGfm } from './markdownComponents'
import { filePathFromHref, remarkFilePaths } from '../richtext/fileLink'
import { SEC_FAST } from '../ui/motion'

/** 流式光标：流停之后还要再留 160ms（够 120ms 的收束淡出播完）再摘掉，
 *  否则光标会「啪」地消失，比不显示还生硬。 */
function useStreamCaret(streaming: boolean): 'in' | 'out' | undefined {
  const [caret, setCaret] = useState<'in' | 'out' | undefined>(streaming ? 'in' : undefined)
  const everStreamed = useRef(false)

  useEffect(() => {
    if (streaming) {
      everStreamed.current = true
      setCaret('in')
      return
    }
    if (!everStreamed.current) return
    everStreamed.current = false
    setCaret('out')
    // 等 .stream-caret 的 caret-out 播完（--motion-fast）再摘掉这一层：留一点余量，
    // 时长与 theme.css 的 --motion-fast 对齐（SEC_FAST 就是它的秒数形式）。
    const timer = window.setTimeout(() => setCaret(undefined), SEC_FAST * 1000 + 20)
    return () => window.clearTimeout(timer)
  }, [streaming])

  return caret
}

export function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  const caret = useStreamCaret(!!streaming)
  // 降级渲染：只在「要解析」的那条路上用（流式期间是纯文本，没有任何需要让路的解析工作）。
  const deferred = useDeferredValue(text)

  // 流式中一律纯文本；非流式只有超长正文继续纯文本（不解析、不高亮）。
  // 流式期间默认纯文本（砍 O(长度²) 重解析），但**已写完的表格**例外：
  // 表格行到齐后再等就是「先代码框、后表格」的闪烁，而解析一张定型的表不随长度变贵。
  const plain = streaming ? (isStreaming() && !hasSettledTable(text)) : isPlainTooLong(text)
  const shown = plain ? text : deferred
  /* 首部空行折叠（2026-09-28「工具卡与正文之间有奇怪空行」的根因）：
     模型在工具调用前后输出的 \n\n 在 pre-wrap 纯文本下会**按字面**渲染成空行；
     而同一段正文在轮结束后走 Markdown 解析，块间空行又被折叠掉 ——
     于是「一会儿有空行、一会儿没有」。Markdown 语义里首部空行本来就没有意义，
     所以在这里一刀切掉；**尾部保留**：流式光标挂在最后一个文本节点行尾。 */
  const body = shown.replace(/^[ \t]*\n+/, '')

  // 光标（caret-pulse）在 .md-body 的 ::after 上：属性挂不到伪元素，所以标记本体，
  // base.css 用 html[data-nav-busy] [data-loop-anim] > :last-child::after 这一条停它。
  return (
    <div data-caret={caret} data-loop-anim className={cn('md-body selectable text-13 text-ink', className)}>
      {plain
        // 纯文本：pre-wrap 保住换行与缩进（选中复制拿到的是原文），光标由 .md-body[data-caret] 的伪元素挂在最后一个子节点行尾。
        ? <div className='whitespace-pre-wrap break-words'>{body}</div>
        : <FullBody text={body} enabled={!streaming} />}
    </div>
  )
}

/* ── 路径芯片的接入口 ──
   三条都只作用在「已经要解析」的那条路上，流式期间一个字节都不跑：

   1) remarkFilePaths（richtext/fileLink）：把正文 / 列表 / 表格单元格里的绝对路径与相对路径
      切成链接节点。代码块（code）与行内代码（inlineCode）是别的节点类型，天然不被识别。
   2) urlTransform：react-markdown 默认只放行 http/https/mailto 这类协议，
      芯片链接的 `coomi-file:` 会在转换阶段被清成空串，所以这里显式放行它，其余仍走默认策略。
   3) components：在共用表（markdownComponents）之上只覆盖一个 `a` ——
      芯片链接换成 FileChip，普通链接保持原样。共用表本身不动（冒烟脚本也读它）。 */
const FILE_COMPONENTS: Components = { ...markdownComponents(), a: FileLinkAnchor }
const FILE_URL_TRANSFORM: UrlTransform = (url: string): string =>
  (filePathFromHref(url) ? url : defaultUrlTransform(url))

/** 非流式（历史消息 / 流已结束）：整段一次性解析。
 *  这一段解析是「每个 text 值一次」而不是「每个 chunk 一次」，所以它的成本只付一次。 */
function FullBody({ text, enabled }: { text: string; enabled: boolean }) {
  return (
    // 芯片在流式期间不可点：正文此时本来就是纯文本，这层 context 只是兜底。
    <FileChipEnabled enabled={enabled}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFilePaths]}
        urlTransform={FILE_URL_TRANSFORM}
        components={FILE_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </FileChipEnabled>
  )
}
