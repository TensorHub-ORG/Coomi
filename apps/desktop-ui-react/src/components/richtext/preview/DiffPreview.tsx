/**
 * Diff 预览：并排（左右两栏）/ 统一（单栏）两种视图。
 *
 * 解析走最朴素但够用的路子：`diff --git` / `---` / `+++` 切文件，`@@` 切块，块内按首字符分类
 * （+ 新增、- 删除、其余上下文）。认不出任何 hunk 时（例如只是一段带 +/- 的文本）就整段按统一视图显示，
 * 不硬套结构，也不会因此报错。
 */
import { useMemo, useState } from 'react'
import { Columns2, Rows3 } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { Segmented } from '../../ui/Controls'
import { PreviewNote } from './common'
import type { RichBlock } from '../store'

type LineType = 'ctx' | 'add' | 'del'

interface DiffLine { type: LineType; text: string; oldNo: number | null; newNo: number | null }
interface DiffHunk { header: string; lines: DiffLine[] }
interface DiffFile { header: string; hunks: DiffHunk[] }

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseDiff(source: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  const ensureFile = (): DiffFile => {
    if (!file) { file = { header: '', hunks: [] }; files.push(file) }
    return file
  }

  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const hunkMatch = HUNK_HEAD.exec(raw)
    if (hunkMatch) {
      const target = ensureFile()
      oldNo = Number(hunkMatch[1] ?? 0)
      newNo = Number(hunkMatch[3] ?? 0)
      hunk = { header: raw, lines: [] }
      target.hunks.push(hunk)
      continue
    }
    if (/^diff --git /.test(raw)) {
      file = { header: raw, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (/^(---|\+\+\+) /.test(raw) && !hunk) {
      const target = ensureFile()
      target.header = target.header ? target.header + '\n' + raw : raw
      continue
    }
    if (!hunk) continue
    const marker = raw.charAt(0)
    if (marker === '+') { hunk.lines.push({ type: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ }); continue }
    if (marker === '-') { hunk.lines.push({ type: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null }); continue }
    if (marker === '\\') continue // \ No newline at end of file
    hunk.lines.push({ type: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ })
  }
  return files.filter((item) => item.hunks.length > 0)
}

const LINE_CLASS: Record<LineType, string> = {
  add: 'bg-[color-mix(in_srgb,var(--ok)_14%,transparent)]',
  del: 'bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]',
  ctx: '',
}
const MARK: Record<LineType, string> = { add: '+', del: '-', ctx: ' ' }

function numberCell(value: number | null): string {
  return value === null ? '' : String(value)
}

/** 并排视图：把块内连续的删/增配对成左右一行。 */
function splitRows(lines: DiffLine[]): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] as DiffLine
    if (line.type === 'ctx') { rows.push({ left: line, right: line }); index++; continue }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (index < lines.length && (lines[index] as DiffLine).type === 'del') { dels.push(lines[index] as DiffLine); index++ }
    while (index < lines.length && (lines[index] as DiffLine).type === 'add') { adds.push(lines[index] as DiffLine); index++ }
    const span = Math.max(dels.length, adds.length, 1)
    for (let i = 0; i < span; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
  }
  return rows
}

export function DiffPreview({ block }: { block: RichBlock }) {
  const [view, setView] = useState<'split' | 'unified'>('split')
  const files = useMemo(() => parseDiff(block.code), [block.code])

  if (!files.length) {
    return (
      <div className='px-3 py-3'>
        <PreviewNote tone='info'>没有解析出 diff 块（缺 @@ 标记），按统一视图原样显示。</PreviewNote>
        <pre className='mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-11 text-ink-2'>{block.code}</pre>
      </div>
    )
  }

  const stats = files.reduce((acc, file) => {
    for (const hunk of file.hunks) for (const line of hunk.lines) {
      if (line.type === 'add') acc.add++
      else if (line.type === 'del') acc.del++
    }
    return acc
  }, { add: 0, del: 0 })

  return (
    <div className='min-w-0'>
      <div className='flex items-center gap-2 border-b border-line px-2 py-1 text-11 text-ink-4'>
        <span className='min-w-0 flex-1 truncate'>
          {files.length} 个文件 · <span className='text-ok'>+{stats.add}</span> <span className='text-danger'>-{stats.del}</span>
        </span>
        <Segmented
          value={view}
          onChange={setView}
          ariaLabel='Diff 视图'
          options={[
            { value: 'split', label: <span className='flex items-center gap-1'><Columns2 size={11} />并排</span> },
            { value: 'unified', label: <span className='flex items-center gap-1'><Rows3 size={11} />统一</span> },
          ]}
        />
      </div>
      <div className='max-h-[560px] overflow-auto'>
        {files.map((file, fileIndex) => (
          <div key={fileIndex} className='min-w-0 border-b border-line-soft last:border-b-0'>
            {file.header ? (
              <div className='sticky top-0 z-[1] truncate border-b border-line bg-muted px-2 py-1 font-mono text-11 text-ink-3' title={file.header}>
                {file.header.split('\n')[0]}
              </div>
            ) : null}
            {file.hunks.map((hunk, hunkIndex) => (
              <div key={hunkIndex} className='min-w-0'>
                <div className='truncate bg-sunken px-2 py-0.5 font-mono text-11 text-ink-4'>{hunk.header}</div>
                {view === 'unified' ? (
                  <table className='w-full border-collapse font-mono text-11'>
                    <tbody>
                      {hunk.lines.map((line, lineIndex) => (
                        <tr key={lineIndex} className={LINE_CLASS[line.type]}>
                          <td className='w-10 select-none border-r border-line-soft px-1 text-right tabular-nums text-ink-4'>{numberCell(line.oldNo)}</td>
                          <td className='w-10 select-none border-r border-line-soft px-1 text-right tabular-nums text-ink-4'>{numberCell(line.newNo)}</td>
                          <td className={cn('w-3 select-none px-0.5 text-center', line.type === 'add' ? 'text-ok' : line.type === 'del' ? 'text-danger' : 'text-ink-4')}>{MARK[line.type]}</td>
                          <td className='whitespace-pre-wrap break-all px-1 text-ink-2'>{line.text || ' '}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className='w-full table-fixed border-collapse font-mono text-11'>
                    <tbody>
                      {splitRows(hunk.lines).map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          <td className={cn('w-9 select-none border-r border-line-soft px-1 text-right tabular-nums text-ink-4', row.left?.type === 'del' && LINE_CLASS.del)}>{numberCell(row.left?.oldNo ?? null)}</td>
                          <td className={cn('w-1/2 whitespace-pre-wrap break-all border-r border-line px-1.5 text-ink-2', row.left?.type === 'del' && LINE_CLASS.del)}>{row.left?.text ?? ''}</td>
                          <td className={cn('w-9 select-none border-r border-line-soft px-1 text-right tabular-nums text-ink-4', row.right?.type === 'add' && LINE_CLASS.add)}>{numberCell(row.right?.newNo ?? null)}</td>
                          <td className={cn('w-1/2 whitespace-pre-wrap break-all px-1.5 text-ink-2', row.right?.type === 'add' && LINE_CLASS.add)}>{row.right?.text ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
