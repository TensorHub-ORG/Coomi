/**
 * 压缩包预览（zip）：列条目「名称 / 大小 / 压缩后 / 方式」，不落盘、不解压内容。
 *
 * 关键手法：fflate 的 `unzipSync` 支持 filter —— 在 filter 里把条目信息记下来并返回 false，
 * 于是**只读中央目录、一个字节都不解压**。这正是「列个目录」该有的成本。
 *
 * 两道闸：32MB（读原文件的上限）、5000 条（列出来的上限）；
 * DOM 上再分页（一次 300 条），几千条 zip 也不会把侧栏顶死。
 */
import { useEffect, useMemo, useState } from 'react'
import { unzipSync } from 'fflate'
import { Archive, Plus, RotateCcw, Search } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { Button } from '../../ui/Button'
import { PreviewLoading, PreviewNote, useInView } from './common'
import { formatSize, OversizedFileError, readRawBuffer } from '../fileStore'
import { ZIP_MAX_BYTES, ZIP_MAX_ENTRIES } from '../fileTypes'
import { FileInfoPanel } from './BinaryPreview'

interface ZipEntry {
  name: string
  size: number
  packed: number
  method: number
}

const PAGE = 300

/** 0 = 存储，8 = deflate；其余（bzip2 / lzma / zstd）fflate 读不了，标出来提醒。 */
function methodLabel(method: number): string {
  if (method === 0) return '存储'
  if (method === 8) return 'deflate'
  return '方式 ' + method
}

export function ZipPreview({ path, name }: { path: string; name: string }) {
  const { ref, inView } = useInView<HTMLDivElement>('300px')
  const [entries, setEntries] = useState<ZipEntry[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState('')
  const [oversized, setOversized] = useState('')
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(PAGE)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!inView || !path) return
    let alive = true
    setLoading(true)
    setError('')
    setOversized('')
    setEntries(null)
    void readRawBuffer(path, ZIP_MAX_BYTES).then(
      (buffer) => {
        if (!alive) return
        try {
          const list: ZipEntry[] = []
          let capped = false
          unzipSync(new Uint8Array(buffer), {
            filter: (file) => {
              if (list.length >= ZIP_MAX_ENTRIES) { capped = true; return false }
              list.push({ name: file.name, size: file.originalSize, packed: file.size, method: file.compression })
              return false
            },
          })
          list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
          setEntries(list)
          setTruncated(capped)
          setVisible(PAGE)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      },
      (e) => {
        if (!alive) return
        if (e instanceof OversizedFileError) setOversized(e.message)
        else setError(e instanceof Error ? e.message : String(e))
      },
    ).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [path, inView, reload])

  const filtered = useMemo(() => {
    const list = entries ?? []
    const needle = query.trim().toLowerCase()
    if (!needle) return list
    return list.filter((entry) => entry.name.toLowerCase().includes(needle))
  }, [entries, query])

  const totals = useMemo(() => {
    let raw = 0
    let packed = 0
    for (const entry of entries ?? []) { raw += entry.size; packed += entry.packed }
    return { raw, packed }
  }, [entries])

  if (oversized) return <FileInfoPanel path={path} name={name} tone='warn' note={oversized + '。大压缩包请在系统里用解压工具打开。'} />
  if (error) return <FileInfoPanel path={path} name={name} tone='warn' note={'不是可读的 zip：' + error} />
  if (loading || !entries) {
    return <div ref={ref}>{inView ? <PreviewLoading label='读取压缩包目录…' /> : <div className='px-3 py-4 text-12 text-ink-4'>滚动到可见处才会读取压缩包。</div>}</div>
  }

  const shown = filtered.slice(0, visible)

  return (
    <div ref={ref} className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
      <div className='flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1'>
        <Archive size={12} className='shrink-0 text-ink-3' />
        <span className='min-w-0 flex-1 truncate text-11 text-ink-4'>
          {entries.length} 个条目 · 解开后 {formatSize(totals.raw)} · 压缩后 {formatSize(totals.packed)}
          {query ? ' · 命中 ' + filtered.length : ''}
        </span>
        <Button variant='ghost' size='icon-sm' className='h-6 w-6' title='重新读取' onClick={() => setReload((v) => v + 1)}>
          <RotateCcw size={11} />
        </Button>
      </div>

      <div className='flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1'>
        <Search size={12} className='shrink-0 text-ink-4' />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setVisible(PAGE) }}
          placeholder='按名称过滤条目…'
          className='h-6 min-w-0 flex-1 rounded-md border border-line bg-control-2 px-2 text-11 text-ink outline-none placeholder:text-ink-4 focus:border-line-strong'
        />
      </div>

      <div className='min-h-0 flex-1 overflow-auto'>
        <table className='w-full border-collapse text-11'>
          <thead className='sticky top-0 z-[1] bg-muted'>
            <tr>
              <th className='border-b border-line px-2 py-1 text-left font-medium text-ink-2'>名称</th>
              <th className='w-[76px] border-b border-line px-2 py-1 text-right font-medium text-ink-2'>大小</th>
              <th className='w-[76px] border-b border-line px-2 py-1 text-right font-medium text-ink-2'>压缩后</th>
              <th className='w-[64px] border-b border-line px-2 py-1 text-left font-medium text-ink-2'>方式</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry, index) => (
              <tr key={entry.name + index} className='odd:bg-surface even:bg-muted/40 hover:bg-hover'>
                <td className='max-w-0 truncate border-b border-line-soft px-2 py-1 font-mono text-ink-2' title={entry.name}>
                  <span className={cn(entry.name.endsWith('/') && 'text-ink-3')}>{entry.name}</span>
                </td>
                <td className='border-b border-line-soft px-2 py-1 text-right tabular-nums text-ink-2'>{formatSize(entry.size)}</td>
                <td className='border-b border-line-soft px-2 py-1 text-right tabular-nums text-ink-4'>{formatSize(entry.packed)}</td>
                <td className='border-b border-line-soft px-2 py-1 text-ink-4'>{methodLabel(entry.method)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className='shrink-0 border-t border-line px-2 py-1'>
        {filtered.length > shown.length ? (
          <Button variant='ghost' size='sm' className='h-6 text-11' onClick={() => setVisible((v) => v + PAGE)}>
            <Plus size={11} />再显示 {Math.min(PAGE, filtered.length - shown.length)} 条（已显示 {shown.length} / {filtered.length}）
          </Button>
        ) : null}
        {truncated ? (
          <PreviewNote tone='info'>条目超过 {ZIP_MAX_ENTRIES} 条：只列出了前 {ZIP_MAX_ENTRIES} 条。</PreviewNote>
        ) : null}
      </div>
    </div>
  )
}
