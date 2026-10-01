/**
 * PDF 预览：直接内嵌 iframe，交给 WebView 自带的阅读器渲染（不引 pdf.js —— 那要多背 1MB+ 与一个 worker）。
 *
 * 为什么不加 sandbox：PDF 不是可执行文档，而加了 sandbox 之后 Chromium 的内置阅读器会被挡掉，
 * 只剩一个空白框。这里的边界靠另外三件事守住：URL 只指向本机引擎、内容来自用户自己的磁盘、
 * 顶部还有「用系统默认程序打开」这条退路。
 *
 * 不可见就不挂 iframe：IntersectionObserver 说不在了就整个卸载，阅读器不会在后台占着内存。
 */
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../ui/Button'
import { Tip } from '../../ui/Overlay'
import { PreviewNote, useInView } from './common'
import { fileRawUrl, openFileWithSystem, useFileStat } from '../fileStore'

export function PdfPreview({ path, name }: { path: string; name: string }) {
  const { ref, inView } = useInView<HTMLDivElement>('400px')
  const entry = useFileStat(path)

  return (
    <div ref={ref} className='flex min-h-0 min-w-0 flex-1 flex-col'>
      <div className='flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1'>
        <span className='min-w-0 flex-1 truncate text-11 text-ink-4'>
          内嵌 PDF 阅读器（应用内只读）{entry?.state === 'missing' ? ' · 文件不存在' : ''}
        </span>
        <Tip label='用系统默认程序打开'>
          <Button
            variant='ghost'
            size='icon-sm'
            className='h-6 w-6'
            onClick={() => { void openFileWithSystem(path).catch((e) => toast.error(e instanceof Error ? e.message : String(e))) }}
          >
            <ExternalLink size={12} />
          </Button>
        </Tip>
      </div>
      {inView ? (
        <iframe
          key={path}
          src={fileRawUrl(path)}
          title={name || 'PDF 预览'}
          className='min-h-[420px] w-full flex-1 border-0 bg-canvas'
        />
      ) : (
        <div className='px-3 py-4 text-12 text-ink-4'>滚动到可见处才会挂载 PDF 阅读器（不可见的预览不占内存）。</div>
      )}
      <div className='shrink-0 border-t border-line px-2 py-1'>
        <PreviewNote tone='info'>
          阅读器由 WebView 自带的 PDF 组件提供；打不开时可以点右上角交给系统默认程序。
        </PreviewNote>
      </div>
    </div>
  )
}
