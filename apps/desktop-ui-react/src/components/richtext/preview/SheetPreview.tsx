/**
 * 表格预览（xlsx / xls / xlsm / xlsb / ods / csv / tsv）：SheetJS 只读解析 + 多 sheet 切换 + 导出 CSV。
 *
 * 四道闸，从上到下：
 *   1) **不可见不解析**：IntersectionObserver 说不在视口里就一行字，SheetJS 一个字节都不跑；
 *   2) **体积闸 5MB**：超了直接换成「文件信息 + 用系统打开」，绝不把大表读进内存；
 *   3) **行数闸 5 万行**：sheetRows 交给 SheetJS，解析阶段就截断（不是解析完再切）；
 *   4) **DOM 闸**：一次只往表格里塞 200 行，底下「再显示 200 行」按需加 ——
 *      5 万行一次性进 DOM 会把侧栏顶死，而用户真正会看的永远只有开头那几百行。
 *
 * 全部只读：SheetJS 在这里只做 read / sheet_to_json / sheet_to_csv，不写回任何文件。
 */
import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { Download, Plus, RotateCcw, Table2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../../lib/cn'
import { Button } from '../../ui/Button'
import { PreviewLoading, PreviewNote, useInView } from './common'
import { downloadText } from '../actions'
import { OversizedFileError, readRawBuffer } from '../fileStore'
import { SHEET_MAX_BYTES, SHEET_MAX_ROWS, SHEET_PAGE_ROWS } from '../fileTypes'
import { FileInfoPanel } from './BinaryPreview'

/** 一次最多渲染多少列：几千列的表在 400px 宽的侧栏里本来也没法看。 */
const MAX_COLUMNS = 60

type Loaded = { book: XLSX.WorkBook; truncatedRows: boolean }

export function SheetPreview({ path, name }: { path: string; name: string }) {
  const { ref, inView } = useInView<HTMLDivElement>('300px')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [oversized, setOversized] = useState('')
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const [visible, setVisible] = useState(SHEET_PAGE_ROWS)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!inView || !path) return
    let alive = true
    setLoading(true)
    setError('')
    setOversized('')
    setLoaded(null)
    void readRawBuffer(path, SHEET_MAX_BYTES).then(
      (buffer) => {
        if (!alive) return
        try {
          // sheetRows：让 SheetJS 在解析阶段就只认前 5 万行，而不是解析完再切片。
          const book = XLSX.read(new Uint8Array(buffer), {
            type: 'array',
            dense: true,
            sheetRows: SHEET_MAX_ROWS + 1,
            cellDates: false,
            cellText: true,
          })
          if (!book.SheetNames.length) throw new Error('这个文件里没有工作表')
          // 截断判定：SheetJS 会把 sheetRows 当成硬上限，行数顶格说明原表更长。
          const first = book.Sheets[book.SheetNames[0] as string]
          const rows = first ? XLSX.utils.sheet_to_json<unknown[]>(first, { header: 1, blankrows: false }) : []
          if (alive) { setLoaded({ book, truncatedRows: rows.length > SHEET_MAX_ROWS }); setActive(0); setVisible(SHEET_PAGE_ROWS) }
        } catch (e) {
          if (alive) setError(e instanceof Error ? e.message : String(e))
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

  const sheetName = loaded ? loaded.book.SheetNames[active] ?? '' : ''
  const sheet = loaded && sheetName ? loaded.book.Sheets[sheetName] : undefined

  const rows = useMemo<unknown[][]>(() => {
    if (!sheet) return []
    try {
      return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, blankrows: false, defval: '' })
    } catch {
      return []
    }
  }, [sheet])

  const header = rows[0] ?? []
  const body = rows.slice(1)
  const columns = Math.min(MAX_COLUMNS, Math.max(header.length, ...body.slice(0, 50).map((r) => r.length), 0))
  const shown = body.slice(0, visible)

  if (oversized) return <FileInfoPanel path={path} name={name} tone='warn' note={oversized + '。大表请在系统里用 Excel / WPS 打开。'} />
  if (error) return <FileInfoPanel path={path} name={name} tone='warn' note={'解析失败：' + error} />
  if (loading || !loaded) {
    return <div ref={ref}>{inView ? <PreviewLoading label='读取并解析表格…' /> : <div className='px-3 py-4 text-12 text-ink-4'>滚动到可见处才会解析表格。</div>}</div>
  }

  return (
    <div ref={ref} className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
      <div className='flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1'>
        <Table2 size={12} className='shrink-0 text-ink-3' />
        <span className='min-w-0 flex-1 truncate text-11 text-ink-4'>
          {loaded.book.SheetNames.length} 个工作表 · 当前「{sheetName}」{body.length} 行{header.length > MAX_COLUMNS ? ' · 只显示前 ' + MAX_COLUMNS + ' 列' : ''}
        </span>
        <Button
          variant='ghost'
          size='sm'
          className='h-6 text-11'
          onClick={() => {
            if (!sheet) return
            try {
              downloadText((name.replace(/\.[^.]+$/, '') || 'sheet') + '-' + sheetName + '.csv', XLSX.utils.sheet_to_csv(sheet), 'text/csv')
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          <Download size={11} />导出当前表 CSV
        </Button>
        <Button variant='ghost' size='icon-sm' className='h-6 w-6' title='重新读取' onClick={() => setReload((v) => v + 1)}>
          <RotateCcw size={11} />
        </Button>
      </div>

      {loaded.book.SheetNames.length > 1 ? (
        <div className='flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-1'>
          {loaded.book.SheetNames.map((label, index) => (
            <button
              key={label + index}
              type='button'
              onClick={() => { setActive(index); setVisible(SHEET_PAGE_ROWS) }}
              className={cn(
                'shrink-0 rounded-md px-2 py-0.5 text-11 transition-colors duration-[var(--motion-fast)]',
                index === active ? 'bg-selected text-ink' : 'text-ink-3 hover:bg-hover hover:text-ink-2',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className='px-3 py-4'><PreviewNote tone='info'>这个工作表是空的。</PreviewNote></div>
      ) : null}

      <div className='min-h-0 flex-1 overflow-auto'>
        <table className='w-full border-collapse text-11'>
          <thead className='sticky top-0 z-[1] bg-muted'>
            <tr>
              <th className='border-b border-line px-2 py-1 text-right font-normal text-ink-4'>#</th>
              {Array.from({ length: columns }, (_, index) => (
                <th key={index} className='max-w-[240px] truncate border-b border-line px-2 py-1 text-left font-medium text-ink-2' title={cellText(header[index])}>
                  {cellText(header[index]) || '(空列名)'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, rowIndex) => (
              <tr key={rowIndex} className='odd:bg-surface even:bg-muted/40 hover:bg-hover'>
                <td className='border-b border-line-soft px-2 py-1 text-right tabular-nums text-ink-4'>{rowIndex + 1}</td>
                {Array.from({ length: columns }, (_, colIndex) => (
                  <td key={colIndex} className='max-w-[240px] truncate border-b border-line-soft px-2 py-1 text-ink-2' title={cellText(row[colIndex])}>
                    {cellText(row[colIndex])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className='shrink-0 border-t border-line px-2 py-1'>
        {body.length > shown.length ? (
          <Button variant='ghost' size='sm' className='h-6 text-11' onClick={() => setVisible((v) => v + SHEET_PAGE_ROWS)}>
            <Plus size={11} />再显示 {Math.min(SHEET_PAGE_ROWS, body.length - shown.length)} 行（已显示 {shown.length} / {body.length}）
          </Button>
        ) : null}
        {loaded.truncatedRows ? (
          <PreviewNote tone='info'>原表超过 {SHEET_MAX_ROWS.toLocaleString()} 行：只解析了前 {SHEET_MAX_ROWS.toLocaleString()} 行（导出也是这一段）。</PreviewNote>
        ) : null}
      </div>
    </div>
  )
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return text.length > 400 ? text.slice(0, 400) + '…' : text
}
