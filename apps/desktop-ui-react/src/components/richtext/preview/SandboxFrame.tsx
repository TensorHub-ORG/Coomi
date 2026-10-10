/**
 * 沙箱预览帧：一个 iframe + 控制台面板 + 5s 看门狗。
 *
 * 为什么要有看门狗：帧里跑的是 AI 给的代码，一个 while(true) 就能把那一帧冻住。
 * 帧被冻住时父页面（主界面）不受影响，所以 5s 内没收到帧的 idle 心跳就判定「可能死循环」，
 * 弹出提示并允许「强制关闭」——卸载 iframe 元素即销毁它的浏览上下文，循环随之终止。
 *
 * 不可见即卸载：调用方切回代码视图 / 收起侧栏时整个组件被卸载，iframe 连同定时器一起消失，
 * 不会有隐藏的预览在后台空转。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Ban, RotateCcw, Terminal, Trash2 } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { Button } from '../../ui/Button'
import { FRAME_KEY } from './frame'
import type { ConsoleEntry, ConsoleLevel, FrameEvent } from './frame'

const WATCHDOG_MS = 5000
const MAX_ENTRIES = 300

const LEVEL_CLASS: Record<ConsoleLevel, string> = {
  log: 'text-ink-2',
  info: 'text-ink-2',
  debug: 'text-ink-4',
  warn: 'text-warn',
  error: 'text-danger',
  system: 'text-ink-4',
}

export function SandboxFrame({ doc, token, title, reloadSignal = 0, height = 260, fill = false, className }: {
  /** srcdoc 全文（buildFrameDocument 生成）。 */
  doc: string
  /** 帧标识：父页面只认这个 token 的消息，多帧同时存在也不会串台。 */
  token: string
  title: string
  /** 外部「刷新」按钮：+1 即重建 iframe（doc 不变，重新跑一遍）。 */
  reloadSignal?: number
  height?: number
  fill?: boolean
  className?: string
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [reload, setReload] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ok' | 'timeout'>('loading')
  const [closed, setClosed] = useState(false)
  const [entries, setEntries] = useState<ConsoleEntry[]>([])
  const [showConsole, setShowConsole] = useState(false)
  const seq = useRef(0)
  const runKey = useMemo(() => token + ':' + reloadSignal + ':' + reload, [token, reloadSignal, reload])

  // 换一帧就重置状态：否则上一帧的控制台会挂在新帧下面。
  useEffect(() => {
    setStatus('loading')
    setClosed(false)
    setEntries([])
  }, [runKey, doc])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as FrameEvent | null
      if (!data || typeof data !== 'object' || data.k !== FRAME_KEY || data.token !== token) return
      if (data.type === 'idle') { setStatus('ok'); return }
      if (data.type === 'error') {
        seq.current += 1
        const entry: ConsoleEntry = { id: seq.current, level: 'error', text: data.text ?? '', at: Date.now() }
        setEntries((prev) => (prev.length >= MAX_ENTRIES ? [...prev.slice(1), entry] : [...prev, entry]))
        setShowConsole(true)
        return
      }
      if (data.type === 'log') {
        const level = (data.level ?? 'log') as ConsoleLevel
        seq.current += 1
        const entry: ConsoleEntry = { id: seq.current, level, text: data.text ?? '', at: Date.now() }
        setEntries((prev) => (prev.length >= MAX_ENTRIES ? [...prev.slice(1), entry] : [...prev, entry]))
        if (level === 'error') setShowConsole(true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [token])

  // 看门狗：只认帧自己报的 idle，超时就判定「没跑完」。
  useEffect(() => {
    if (closed) return
    const timer = window.setTimeout(() => {
      setStatus((prev) => (prev === 'loading' ? 'timeout' : prev))
    }, WATCHDOG_MS)
    return () => window.clearTimeout(timer)
  }, [runKey, doc, closed])

  const errorCount = entries.filter((entry) => entry.level === 'error').length
  const warnCount = entries.filter((entry) => entry.level === 'warn').length

  const restart = useCallback((): void => {
    setClosed(false)
    setReload((v) => v + 1)
  }, [])

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-col', fill && 'flex-1', className)}>
      <div className='flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-2'>
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full',
          status === 'ok' ? 'bg-ok' : status === 'timeout' ? 'bg-warn' : 'bg-ink-4')} />
        <span className='min-w-0 flex-1 truncate text-11 text-ink-4'>
          {closed ? '预览已关闭' : status === 'ok' ? '沙箱运行中（无联网 / 无同源权限）' : status === 'timeout' ? '等待响应…' : '加载中…'}
        </span>
        <button
          type='button'
          onClick={() => setShowConsole((v) => !v)}
          title='控制台'
          className={cn('flex h-6 items-center gap-1 rounded px-1.5 text-11',
            showConsole ? 'bg-selected text-ink' : 'text-ink-3 hover:bg-hover hover:text-ink-2')}
        >
          <Terminal size={12} />
          <span className='tabular-nums'>{entries.length}</span>
          {errorCount > 0 ? <span className='text-danger'>{errorCount}</span> : null}
          {warnCount > 0 ? <span className='text-warn'>{warnCount}</span> : null}
        </button>
        <Button variant='ghost' size='icon-sm' className='h-6 w-6' title='刷新' onClick={restart}><RotateCcw size={12} /></Button>
      </div>

      <div className='relative min-h-0 flex-1' style={fill ? undefined : { height, flex: 'none' }}>
        {closed ? (
          <div className='flex h-full flex-col items-center justify-center gap-2 text-12 text-ink-3'>
            <Ban size={16} />
            <p>预览已被强制关闭</p>
            <Button size='sm' variant='secondary' onClick={restart}>重新加载</Button>
          </div>
        ) : (
          <iframe
            key={runKey}
            ref={frameRef}
            title={title}
            // 只给 allow-scripts：不给 allow-same-origin，帧内拿不到父页面也拿不到存储。
            sandbox='allow-scripts'
            referrerPolicy='no-referrer'
            srcDoc={doc}
            className='h-full w-full border-0 bg-white'
          />
        )}
        {status === 'timeout' && !closed ? (
          <div className='absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-warn/40 bg-warn-soft px-2 py-1.5 text-11 text-warn'>
            <AlertTriangle size={12} className='shrink-0' />
            <span className='min-w-0 flex-1 leading-[1.5]'>超过 5 秒没有响应，可能是死循环或同步阻塞。预览帧已被判定为无响应。</span>
            <Button size='sm' variant='danger' className='h-6' onClick={() => setClosed(true)}>强制关闭</Button>
          </div>
        ) : null}
      </div>

      {showConsole ? (
        <div className='max-h-40 min-h-0 shrink-0 overflow-y-auto border-t border-line bg-sunken px-2 py-1.5'>
          <div className='mb-1 flex items-center gap-2'>
            <span className='flex-1 text-11 text-ink-4'>控制台（{entries.length} 条，最多留 300 条）</span>
            <Button variant='ghost' size='icon-sm' className='h-5 w-5' title='清空' onClick={() => setEntries([])}><Trash2 size={11} /></Button>
          </div>
          {entries.length === 0
            ? <p className='text-11 text-ink-4'>没有输出。console.log / 报错 / 未处理的 Promise 都会出现在这里。</p>
            : (
              <ul className='space-y-0.5'>
                {entries.map((entry) => (
                  <li key={entry.id} className={cn('flex gap-1.5 font-mono text-11 leading-[1.5]', LEVEL_CLASS[entry.level])}>
                    <span className='shrink-0 text-ink-4'>{entry.level}</span>
                    <span className='min-w-0 flex-1 whitespace-pre-wrap break-all'>{entry.text}</span>
                  </li>
                ))}
              </ul>
            )}
        </div>
      ) : null}
    </div>
  )
}
