/** 引擎日志查看器：直接读 GET /api/runtime/logs 的尾部，不做任何本地拼装。
 *  - 有日志：等宽显示最后 N 行，可刷新、复制全部、在文件夹中打开；
 *  - 404：引擎还没写过日志文件（正常启动不会写），显示可读空态而不是报错；
 *  - 引擎没就绪 / 其它错误：给出原因和重试。 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Copy, FileText, FolderOpen, RefreshCw } from 'lucide-react'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Controls'
import { Empty } from '../ui/Card'
import { ipc } from '../../lib/ipc'
import { shortPath } from '../../lib/format'
import { useEngine } from '../../stores/engine'
import { withDisplayName } from '../../lib/stormProbe'

const LOG_LINES = 300

interface LogPayload {
  path?: string
  lines?: string[]
  truncated?: boolean
}

export function EngineLogDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const api = useEngine((s) => s.api)
  const ready = useEngine((s) => s.ready)
  const [path, setPath] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  /// 404：引擎还没有日志文件。这是空态，不是错误。
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (!ready) {
      setLoading(false); setMissing(false); setError('引擎还没就绪，启动完成后再试')
      return
    }
    setLoading(true)
    try {
      const data = await api<LogPayload>('/api/runtime/logs?lines=' + LOG_LINES)
      setPath(data?.path ?? '')
      setLines(Array.isArray(data?.lines) ? data.lines : [])
      setTruncated(!!data?.truncated)
      setMissing(false)
      setError('')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const notFound = /HTTP 404/.test(message)
      setMissing(notFound)
      setError(notFound ? '' : message)
      setPath('')
      setLines([])
      setTruncated(false)
    } finally {
      setLoading(false)
    }
  }, [api, ready])

  useEffect(() => {
    if (open) void load()
    // 关掉再打开时重新拉一次；load 只依赖 api/ready，不会自激。
  }, [open, load])

  const copyAll = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      toast.success('已复制 ' + lines.length + ' 行日志')
    } catch {
      toast.error('复制失败：剪贴板不可用，可以手动选中文本')
    }
  }

  const openInFolder = async (): Promise<void> => {
    try {
      // 日志文件不存在时退回「引擎日志路径」：壳里点开的是所在目录（explorer 会选中该文件）。
      const target = path || (await ipc<string | null>('engine_log_path').catch(() => null)) || ''
      if (!target) { toast.error('还没有日志文件，没有可以打开的目录'); return }
      await ipc('open_path', { path: target })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打开失败')
    }
  }

  const hasContent = lines.length > 0

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title='引擎日志'
      description={'引擎运行日志的末尾 ' + LOG_LINES + ' 行；只读，不会改动任何文件。'}
      width={880}
      footer={
        <>
          <Button variant='ghost' size='sm' disabled={loading} onClick={() => void load()}>
            {loading ? <Spinner /> : <RefreshCw size={13} />} 刷新
          </Button>
          <Button variant='ghost' size='sm' disabled={!hasContent} onClick={() => void copyAll()}>
            <Copy size={13} /> 复制全部
          </Button>
          <Button variant='secondary' size='sm' onClick={() => void openInFolder()}>
            <FolderOpen size={13} /> 在文件夹中打开
          </Button>
          <Button variant='primary' size='sm' onClick={() => onOpenChange(false)}>关闭</Button>
        </>
      }
    >
      {error ? (
        <div className='flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-12 text-danger'>
          <AlertTriangle size={13} className='mt-0.5 shrink-0' />
          <span className='min-w-0 flex-1'>读取日志失败：{error}</span>
          <Button variant='ghost' size='sm' className='shrink-0' onClick={() => void load()}>重试</Button>
        </div>
      ) : missing ? (
        <Empty
          icon={<FileText size={22} />}
          title='引擎还没有生成日志文件'
          description='引擎一切正常时不会写日志；等出现启动失败或崩溃后再回来看，这里就会有内容。'
          action={<Button variant='secondary' size='sm' onClick={() => void load()}><RefreshCw size={13} /> 重新检查</Button>}
        />
      ) : loading && !hasContent ? (
        <div className='flex items-center justify-center gap-2 py-14 text-12 text-ink-3'>
          <Spinner /> 正在读取日志…
        </div>
      ) : !hasContent ? (
        <Empty
          icon={<FileText size={22} />}
          title='日志文件是空的'
          description='文件已经创建，但还没有写入任何内容。'
          action={<Button variant='secondary' size='sm' onClick={() => void load()}><RefreshCw size={13} /> 刷新</Button>}
        />
      ) : (
        <div className='flex flex-col gap-2'>
          <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-11 text-ink-3'>
            <span className='min-w-0 truncate font-mono' title={path}>{path ? shortPath(path, 70) : '—'}</span>
            <span className='shrink-0 rounded bg-sunken px-1.5 py-0.5'>{lines.length} 行</span>
            {truncated ? <span className='shrink-0 rounded bg-warn-soft px-1.5 py-0.5 text-warn'>仅显示末尾 {LOG_LINES} 行</span> : null}
          </div>
          <pre className='sel-text max-h-[46vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-code px-3 py-2 font-mono text-11 leading-[1.65] text-code-fg'>
            {lines.join('\n')}
          </pre>
        </div>
      )}
    </Dialog>
  )
}

/* #185 的报错栈里显示真名（生产构建会压掉函数名） */
withDisplayName(EngineLogDialog, 'EngineLogDialog')
