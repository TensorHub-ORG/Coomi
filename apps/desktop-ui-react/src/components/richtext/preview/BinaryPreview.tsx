/**
 * 文件信息面板：认不出预览方式的二进制文件（以及超过体积闸的 xlsx / zip / docx）都用它兜底。
 *
 * 显示「图标 + 文件名 + 完整路径 + 大小 + 修改时间」，并把三个动作摆出来：
 * 用系统默认程序打开 / 在文件夹中打开 / 复制路径。
 * 它不读文件内容 —— 所以它是右侧栏里唯一对任意体积文件都安全的预览。
 */
import { ExternalLink, FileWarning, FolderOpen, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../ui/Button'
import { FileBadge } from '../../ui/FileBadge'
import { PreviewNote } from './common'
import { copyFilePath, formatSize, openFileWithSystem, revealFile, statSummary, useFileStat } from '../fileStore'

export interface FileInfoPanelProps {
  path: string
  name: string
  /** 为什么没做内容预览（体积超限 / 解析失败 / 类型不支持）。 */
  note?: string
  tone?: 'info' | 'warn'
}

export function FileInfoPanel({ path, name, note, tone = 'info' }: FileInfoPanelProps) {
  const entry = useFileStat(path)
  const size = entry?.state === 'file' ? formatSize(entry.size) : ''
  const modified = entry?.modified ? new Date(entry.modified).toLocaleString() : ''

  const run = (task: () => Promise<void>): void => {
    void task().catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
  }

  return (
    <div className='flex min-w-0 flex-col gap-2 px-2.5 py-2.5'>
      {note ? <PreviewNote tone={tone}>{note}</PreviewNote> : null}
      <div className='flex min-w-0 items-start gap-2 rounded-md border border-line bg-surface px-2.5 py-2 elev-1'>
        <span className='mt-[1px]'><FileBadge path={path || name} size='md' showExt={false} /></span>
        <div className='min-w-0 flex-1'>
          <p className='truncate text-12 font-medium text-ink' title={name}>{name}</p>
          <p className='mt-0.5 break-all font-mono text-11 leading-[1.5] text-ink-4'>{path || '(路径未解析)'}</p>
          <p className='mt-1 text-11 text-ink-4'>
            {statSummary(entry)}
            {size ? ' · ' + size : ''}
            {modified ? ' · 修改于 ' + modified : ''}
          </p>
        </div>
      </div>
      {path ? (
        <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
          <Button variant='secondary' size='sm' className='h-7 text-11' onClick={() => run(() => openFileWithSystem(path))}>
            <ExternalLink size={12} />用系统默认程序打开
          </Button>
          <Button variant='ghost' size='sm' className='h-7 text-11' onClick={() => run(() => revealFile(path))}>
            <FolderOpen size={12} />在文件夹中打开
          </Button>
          <Button variant='ghost' size='sm' className='h-7 text-11' onClick={() => run(() => copyFilePath(path))}>
            <Copy size={12} />复制路径
          </Button>
        </div>
      ) : (
        <PreviewNote tone='warn'>这个路径没能解析成绝对位置（相对路径需要先有会话工作目录）。</PreviewNote>
      )}
      <p className='flex items-start gap-1.5 text-11 leading-[1.6] text-ink-4'>
        <FileWarning size={12} className='mt-[3px] shrink-0' />
        <span>这类文件不做内联解析：交给系统默认程序打开最稳妥，也不会把大文件读进内存。</span>
      </p>
    </div>
  )
}
