/**
 * CSV 预览：表格 + 点击表头排序 + 导出。
 * 解析支持引号包裹、引号内换行与转义双引号；分隔符在逗号 / 制表符 / 分号 / 竖线里按表头出现次数投票。
 * 行数超过 500 只渲染前 500 行（导出仍按当前排序导出全部），避免大表把主界面顶死。
 */
import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Download, Table2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../ui/Button'
import { PreviewNote } from './common'
import { copyText, downloadText } from '../actions'
import type { RichBlock } from '../store'

const MAX_ROWS = 500

export interface ParsedCsv { rows: string[][]; delimiter: string }

export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const head = clean.split('\n')[0] ?? ''
  const candidates = [',', '\t', ';', '|']
  let delimiter = ','
  let best = -1
  for (const candidate of candidates) {
    const count = head.split(candidate).length - 1
    if (count > best) { best = count; delimiter = candidate }
  }

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i] ?? ''
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === delimiter) { row.push(field); field = ''; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += ch
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return { rows: rows.filter((item) => item.some((cell) => cell.trim().length > 0)), delimiter }
}

export function serializeCsv(rows: string[][], delimiter: string): string {
  return rows.map((row) => row.map((cell) => {
    const value = cell ?? ''
    return /["\n\r]|^\s|\s$/.test(value) || value.includes(delimiter) ? '"' + value.replace(/"/g, '""') + '"' : value
  }).join(delimiter)).join('\n')
}

export function CsvPreview({ block }: { block: RichBlock }) {
  const parsed = useMemo(() => parseCsv(block.code), [block.code])
  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null)

  const header = parsed.rows[0] ?? []
  const body = parsed.rows.slice(1)
  const sorted = useMemo(() => {
    if (!sort) return body
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...body].sort((a, b) => {
      const left = a[sort.col] ?? ''
      const right = b[sort.col] ?? ''
      const ln = Number(left)
      const rn = Number(right)
      if (left.trim() !== '' && right.trim() !== '' && Number.isFinite(ln) && Number.isFinite(rn)) return (ln - rn) * factor
      return left.localeCompare(right, 'zh-Hans-CN') * factor
    })
  }, [body, sort])

  const clickHeader = (col: number): void => {
    setSort((prev) => (prev?.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }))
  }

  const shown = sorted.slice(0, MAX_ROWS)
  const exportRows = [header, ...sorted]

  if (!header.length) {
    return <div className='px-3 py-3'><PreviewNote tone='warn'>没有解析出任何列，已按源码显示。</PreviewNote>
      <pre className='mt-2 whitespace-pre-wrap break-all font-mono text-11 text-ink-2'>{block.code}</pre></div>
  }

  return (
    <div className='min-w-0'>
      <div className='flex items-center gap-1.5 border-b border-line px-2 py-1 text-11 text-ink-4'>
        <Table2 size={12} />
        <span className='flex-1 min-w-0 truncate'>
          {header.length} 列 · {body.length} 行 · 分隔符「{parsed.delimiter === '\t' ? 'Tab' : parsed.delimiter}」{sort ? ' · 已按第 ' + (sort.col + 1) + ' 列' + (sort.dir === 'asc' ? '升序' : '降序') : ''}
        </span>
        <Button variant='ghost' size='sm' className='h-6 text-11' onClick={() => void copyText(JSON.stringify(exportRows, null, 0)).then((ok) => (ok ? toast.success('已复制为 JSON 数组') : toast.error('复制失败')))}>
          复制 JSON
        </Button>
        <Button variant='ghost' size='sm' className='h-6 text-11' onClick={() => downloadText('coomi-csv-' + Date.now() + '.csv', serializeCsv(exportRows, parsed.delimiter), 'text/csv')}>
          <Download size={11} />导出 CSV
        </Button>
      </div>
      <div className='max-h-[520px] min-w-0 overflow-auto'>
        <table className='w-full border-collapse text-11'>
          <thead className='sticky top-0 z-[1] bg-muted'>
            <tr>
              <th className='border-b border-line px-2 py-1 text-right font-normal text-ink-4'>#</th>
              {header.map((cell, index) => (
                <th key={index} className='border-b border-line px-2 py-1 text-left font-medium text-ink-2'>
                  <button type='button' className='flex items-center gap-1 whitespace-nowrap' onClick={() => clickHeader(index)} title='点击排序'>
                    <span className='max-w-[220px] truncate'>{cell || '(空列名)'}</span>
                    {sort?.col === index ? (sort.dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, rowIndex) => (
              <tr key={rowIndex} className='odd:bg-surface even:bg-muted/40 hover:bg-hover'>
                <td className='border-b border-line-soft px-2 py-1 text-right tabular-nums text-ink-4'>{rowIndex + 1}</td>
                {header.map((_, colIndex) => (
                  <td key={colIndex} className='max-w-[280px] truncate border-b border-line-soft px-2 py-1 text-ink-2' title={row[colIndex] ?? ''}>
                    {row[colIndex] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > MAX_ROWS ? (
        <div className='border-t border-line px-2 py-1'>
          <PreviewNote tone='info'>表里有 {sorted.length} 行，表格只渲染前 {MAX_ROWS} 行；导出与复制仍是全部行。</PreviewNote>
        </div>
      ) : null}
    </div>
  )
}
