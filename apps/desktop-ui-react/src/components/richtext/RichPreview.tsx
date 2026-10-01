/**
 * 富块预览分发器：按块类型挑预览实现，并负责「只渲染可见项、不可见就卸载」。
 *
 * 三道闸，从上到下：
 *   1) **安全模式**：开启后直接不出任何富预览（iframe 沙箱 / Mermaid / KaTeX / 内联 SVG 全部跳过），
 *      只留一行说明 —— 沙箱与 sanitize 那几道安全策略本身不变，这一道是让用户能整体关掉重内容；
 *   2) **长度闸**：内容超过识别上限的块（只可能来自右侧栏 / 产物这类外部登记）也不进预览，
 *      避免一个 20 万字符的块把 KaTeX / Mermaid 顶死；
 *   3) **可见性闸**：iframe / Mermaid / KaTeX 都是有状态的重东西，一旦滑出视口还在跑，
 *      主界面就会被拖慢。这里用 IntersectionObserver（提前 400px）守着，不可见时只渲染一行占位，
 *      可见时再真正挂载 —— 效果等同 display:none 不挂载，而且卸载是「真的卸载」（组件被移出树，
 *      定时器 / 帧 / 渲染器实例一起消失），不是把 DOM 藏起来。
 */
import { useInView, useRichSafeMode } from './preview/common'
import { HtmlPreview } from './preview/HtmlPreview'
import { ReactPreview } from './preview/ReactPreview'
import { SvgPreview } from './preview/SvgPreview'
import { MermaidPreview } from './preview/MermaidPreview'
import { JsonPreview } from './preview/JsonPreview'
import { CsvPreview } from './preview/CsvPreview'
import { DiffPreview } from './preview/DiffPreview'
import { MathPreview } from './preview/MathPreview'
import { KIND_LABEL } from './detect'
import { OVERSIZED_NOTE, RICH_RECOGNIZE_MAX_CHARS } from './limits'
import type { RichBlock } from './store'

export function RichPreview({ block, className }: { block: RichBlock; className?: string }) {
  const { ref, inView } = useInView<HTMLDivElement>()
  const safeMode = useRichSafeMode()
  const oversized = block.code.length > RICH_RECOGNIZE_MAX_CHARS
  // 安全模式 / 超长：整体不挂载下面的重组件（连元素都不创建）。
  const skipped = safeMode || oversized

  const body = (() => {
    switch (block.kind) {
      case 'html':
      case 'css':
      case 'js':
        return <HtmlPreview block={block} />
      case 'tsx':
        return <ReactPreview block={block} />
      case 'svg':
        return <SvgPreview block={block} />
      case 'mermaid':
        return <MermaidPreview block={block} />
      case 'json':
        return <JsonPreview block={block} />
      case 'csv':
        return <CsvPreview block={block} />
      case 'diff':
        return <DiffPreview block={block} />
      case 'math':
        return <MathPreview block={block} />
      default:
        return <div className='px-3 py-3 text-12 text-ink-3'>这一块没有预览方式，可以复制或下载源码。</div>
    }
  })()

  return (
    <div ref={ref} data-rich-kind={block.kind} data-rich-skipped={skipped ? '1' : undefined} className={className}>
      {skipped
        ? (
          <div className='px-3 py-3 text-12 text-ink-4'>
            {safeMode
              ? '安全模式已开启：' + KIND_LABEL[block.kind] + ' 富预览整体跳过（沙箱 / 渲染器都不会加载），可切回代码视图或复制源码。'
              : OVERSIZED_NOTE + '：' + KIND_LABEL[block.kind] + ' 富预览已跳过，可切回代码视图。'}
          </div>
        )
        : inView
          ? body
          : <div className='px-3 py-3 text-12 text-ink-4'>滚动到可见处才会渲染 {KIND_LABEL[block.kind]} 预览（不可见的预览已卸载，避免拖慢主界面）。</div>}
    </div>
  )
}
