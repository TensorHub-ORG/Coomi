/**
 * Word 文档预览（docx）：Mammoth 把 document.xml 转成语义化 HTML，再**先清洗后内联**。
 *
 * 安全边界（这一段是重点，别省）：
 *   · Mammoth 的输出同样可能带 `javascript:` 链接与 `on*` 事件（docx 里的超链接关系是文件内容说了算），
 *     所以注入之前一律过一遍 sanitizeDocxHtml：
 *     删掉 script / iframe / object / embed / link / meta / base / form 整棵子树，
 *     摘掉所有 `on*` 属性与 `javascript:` / `vbscript:` 的 href / src。
 *   · 走的是 dangerouslySetInnerHTML，但内容已经过白名单式清洗；嵌入图片是 Mammoth 转的 data URI，不联网。
 *
 * 不可见不解析、超过 20MB 只给文件信息 —— 与其它预览器同一套闸。
 */
import { useEffect, useState } from 'react'
import mammoth from 'mammoth'
import { FileText, RotateCcw } from 'lucide-react'
import { Button } from '../../ui/Button'
import { PreviewLoading, PreviewNote, useInView } from './common'
import { OversizedFileError, readRawBuffer } from '../fileStore'
import { DOCX_MAX_BYTES, formatBytes } from '../fileTypes'
import { FileInfoPanel } from './BinaryPreview'

const BLOCKED_TAGS = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM'])
const BAD_PROTOCOL = /^\s*(javascript|vbscript|data:text\/html)/i

/** 白名单式清洗：整棵删危险子树，摘掉事件属性与危险协议。 */
export function sanitizeDocxHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return ''
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  scrub(parsed.body)
  return parsed.body.innerHTML
}

function scrub(node: Element): void {
  for (const child of Array.from(node.children)) {
    if (BLOCKED_TAGS.has(child.tagName)) { child.remove(); continue }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) { child.removeAttribute(attr.name); continue }
      if (name === 'href' || name === 'src' || name === 'xlink:href') {
        if (BAD_PROTOCOL.test(attr.value)) child.removeAttribute(attr.name)
      }
    }
    scrub(child)
  }
}

export function DocxPreview({ path, name }: { path: string; name: string }) {
  const { ref, inView } = useInView<HTMLDivElement>('300px')
  const [html, setHtml] = useState('')
  const [warnings, setWarnings] = useState(0)
  const [error, setError] = useState('')
  const [oversized, setOversized] = useState('')
  const [loading, setLoading] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!inView || !path) return
    let alive = true
    setLoading(true)
    setError('')
    setOversized('')
    setHtml('')
    void readRawBuffer(path, DOCX_MAX_BYTES).then(
      (buffer) => mammoth.convertToHtml({ arrayBuffer: buffer }).then((result) => {
        if (!alive) return
        setHtml(sanitizeDocxHtml(result.value))
        setWarnings(result.messages.length)
      }),
      (e) => { throw e },
    ).catch((e: unknown) => {
      if (!alive) return
      if (e instanceof OversizedFileError) setOversized(e.message)
      else setError(e instanceof Error ? e.message : String(e))
    }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [path, inView, reload])

  if (oversized) return <FileInfoPanel path={path} name={name} tone='warn' note={oversized + '（上限 ' + formatBytes(DOCX_MAX_BYTES) + '）。'} />
  if (error) return <FileInfoPanel path={path} name={name} tone='warn' note={'转换失败：' + error} />
  if (loading) {
    return <div ref={ref}>{inView ? <PreviewLoading label='转换 Word 文档…' /> : <div className='px-3 py-4 text-12 text-ink-4'>滚动到可见处才会转换文档。</div>}</div>
  }

  return (
    <div ref={ref} className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
      <div className='flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1'>
        <FileText size={12} className='shrink-0 text-ink-3' />
        <span className='min-w-0 flex-1 truncate text-11 text-ink-4'>Mammoth 转换 · 只读（版式按语义重建，不还原分页）</span>
        <Button variant='ghost' size='icon-sm' className='h-6 w-6' title='重新转换' onClick={() => setReload((v) => v + 1)}>
          <RotateCcw size={11} />
        </Button>
      </div>
      <div className='min-h-0 flex-1 overflow-auto px-3 py-2'>
        {html
          ? (
            <div
              className='docx-body min-w-0 selectable text-12 text-ink [&_a]:text-primary [&_a]:underline [&_em]:italic [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-18 [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-16 [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-14 [&_h3]:font-semibold [&_img]:max-w-full [&_li]:leading-[1.7] [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_p]:leading-[1.7] [&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_th]:border [&_th]:border-line [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5'
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )
          : <PreviewNote tone='info'>这份文档没有可显示的正文（可能全是图片或空文档）。</PreviewNote>}
      </div>
      {warnings > 0 ? (
        <div className='shrink-0 border-t border-line px-2 py-1'>
          <PreviewNote tone='info'>转换时有 {warnings} 条提示（不支持的样式 / 元素已被跳过）。</PreviewNote>
        </div>
      ) : null}
    </div>
  )
}
