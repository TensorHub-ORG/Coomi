/**
 * HTML 文件预览：复用**已有**的沙箱帧（SandboxFrame + buildFrameDocument），不另起一套。
 *
 * 与代码块预览同一套边界：sandbox='allow-scripts'（无 allow-same-origin）、CSP default-src 'none'、
 * connect-src 'none' —— 帧内的脚本照常跑，但联不了网、拿不到父页面、也读不到磁盘。
 * 代价要写清楚：页面里 <link> / <img> 引用的**同目录资源不会被加载**（它们都是网络请求），
 * 所以外链样式与图片会缺失，本地文件预览只保证「结构与内联样式」正确。
 */
import { useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '../../ui/Button'
import { PreviewLoading, PreviewNote, useInView } from './common'
import { SandboxFrame } from './SandboxFrame'
import { buildFrameDocument, splitHtmlDocument } from './frame'
import { OversizedFileError, readRawBuffer } from '../fileStore'
import { HTML_MAX_BYTES, formatBytes } from '../fileTypes'
import { FileInfoPanel } from './BinaryPreview'

export function HtmlFilePreview({ path, name }: { path: string; name: string }) {
  const { ref, inView } = useInView<HTMLDivElement>('300px')
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  const [oversized, setOversized] = useState('')
  const [loading, setLoading] = useState(false)
  const [reload, setReload] = useState(0)
  const token = useMemo(() => 'filehtml-' + path.length.toString(36) + '-' + Math.random().toString(36).slice(2, 8), [path])

  useEffect(() => {
    if (!inView || !path) return
    let alive = true
    setLoading(true)
    setError('')
    setOversized('')
    setSource('')
    void readRawBuffer(path, HTML_MAX_BYTES).then(
      (buffer) => { if (alive) setSource(new TextDecoder('utf-8').decode(buffer)) },
      (e) => {
        if (!alive) return
        if (e instanceof OversizedFileError) setOversized(e.message)
        else setError(e instanceof Error ? e.message : String(e))
      },
    ).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [path, inView, reload])

  const doc = useMemo(() => {
    if (!source) return ''
    const parts = splitHtmlDocument(source)
    return buildFrameDocument({ token, title: name || 'HTML 预览', headHtml: parts.headHtml, bodyHtml: parts.bodyHtml })
  }, [source, token, name])

  if (oversized) return <FileInfoPanel path={path} name={name} tone='warn' note={oversized + '（上限 ' + formatBytes(HTML_MAX_BYTES) + '）。'} />
  if (error) return <FileInfoPanel path={path} name={name} tone='warn' note={'读取失败：' + error} />
  if (loading) {
    return <div ref={ref}>{inView ? <PreviewLoading label='读取 HTML…' /> : <div className='px-3 py-4 text-12 text-ink-4'>滚动到可见处才会加载页面。</div>}</div>
  }

  return (
    <div ref={ref} className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
      <div className='flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1'>
        <span className='min-w-0 flex-1 truncate text-11 text-ink-4'>沙箱预览（无同源、无联网、无顶层跳转）</span>
        <Button variant='ghost' size='icon-sm' className='h-6 w-6' title='重新运行' onClick={() => setReload((v) => v + 1)}>
          <RotateCcw size={11} />
        </Button>
      </div>
      <SandboxFrame doc={doc} token={token} title={name || 'HTML 预览'} height={520} />
      <div className='shrink-0 border-t border-line px-2 py-1'>
        <PreviewNote tone='info'>外链样式 / 图片 / 脚本属于网络请求，已被沙箱挡掉；页面里的内联样式与脚本正常执行。</PreviewNote>
      </div>
    </div>
  )
}
