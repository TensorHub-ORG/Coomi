/** 运行环境一键安装的进度卡：确认 → 装 → 结果，一张卡走完全程。
 *
 *  这张卡只负责「把 store 里的进度画出来」，所有动作都通过回调交回调用方
 *  （RuntimeInstallDialog 单装一个运行时；ChainInstallDialog 把它当两步卡的第一步）。
 *
 *  四件事必须在卡上看得见：
 *   · 将要执行的完整命令（与引擎实际执行的同源）+「允许一键安装」开关状态；
 *   · 装的时候的实时输出（任务日志尾部，900ms 刷新）与一个能随时按的「取消安装」；
 *   · 失败时指出是哪一步失败，并附上 stderr 尾部与「重试」；
 *   · 引擎没有一键安装接口（404）时降级成「复制命令」，并明确写出「引擎暂不支持一键安装」。
 *
 *  动效走 motion 的按需入口（m + domAnimation，Provider 由 App 根的 LazyMotion 单独挂一份）：
 *  只做位移与淡入，不用 layout 动画（domAnimation 不含）。
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle, CheckCircle2, ClipboardCopy, ExternalLink, Info, RefreshCw, ShieldCheck, Square, Terminal,
} from 'lucide-react'
import { m } from 'motion/react'
import { ThinkingOrb } from 'thinking-orbs'
import { cn } from '../../lib/cn'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Input'
import { Spinner, Switch } from '../ui/Controls'
import { secondNow, useStableTick } from '../ui/stableTick'
import { copyText } from './clipboard'
import { RestartPrompt } from './RestartPrompt'
import type { RuntimeInstallProgress } from '../../stores/library'
import { runtimeTaskLabel } from './installClient'
import { runtimeHint } from './runtimeMeta'

/** 计时：装 winget 包通常几十秒到几分钟，有个走字的时间才不像卡死。
 *  读数按秒量化，且不活跃时一条调度都不建 —— 静止时零提交（原来是每秒无条件 setNow）。 */
function useElapsed(active: boolean, since: number): number {
  const now = useStableTick(active, 1000, secondNow, secondNow())
  return active && since ? Math.max(0, Math.round((now - since) / 1000)) : 0
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return seconds + ' 秒'
  const minutes = Math.floor(seconds / 60)
  return minutes + ' 分 ' + String(seconds % 60).padStart(2, '0') + ' 秒'
}

function CommandBlock({ command, hint }: { command: string; hint: string }) {
  return (
    <div className='rounded-lg border border-line bg-muted p-3'>
      <div className='flex items-center gap-1.5 text-11 text-ink-4'>
        <Terminal size={12} /> {hint}
      </div>
      <div className='mt-2 break-all font-mono text-11 leading-[1.7] text-ink-2'>{command || '（引擎没有给出命令）'}</div>
    </div>
  )
}

export function RuntimeInstallPanel({ progress, onConfirm, onCancel, onRetry, onRecheck, className }: {
  progress: RuntimeInstallProgress
  /** 用户在确认卡上按下「开始安装」（开关已打开）。 */
  onConfirm: () => void | Promise<void>
  onCancel?: () => void | Promise<void>
  onRetry?: () => void | Promise<void>
  onRecheck?: () => void | Promise<void>
  className?: string
}) {
  const allowedByEngine = progress.plan?.allowed !== false
  const [allow, setAllow] = useState(allowedByEngine)
  const [busy, setBusy] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const elapsed = useElapsed(progress.phase === 'running', progress.startedAt)

  // 换了一条运行时 / 引擎开关变了：开关状态跟着重置，别把上一条的选择带过来。
  useEffect(() => { setAllow(allowedByEngine) }, [progress.id, allowedByEngine, progress.plan?.command])

  // 实时输出贴着底部：新行在下面，用户不必手动往下拖。
  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [progress.log.length])

  const fallbackCommand = progress.command || runtimeHint(progress.id).winget
  const hint = runtimeHint(progress.id)

  const copy = async (command: string): Promise<void> => {
    if (!command) { toast.error('这条没有可复制的命令，请点「官网」按步骤安装'); return }
    const ok = await copyText(command)
    if (ok) toast.success('安装命令已复制，粘到 PowerShell 里回车即可')
    else toast.error('复制失败：剪贴板不可用，可以手动选中命令')
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    try { await onConfirm() } finally { setBusy(false) }
  }

  const cancel = async (): Promise<void> => {
    if (!onCancel) return
    setBusy(true)
    try { await onCancel() } finally { setBusy(false) }
  }

  const retry = async (): Promise<void> => {
    if (!onRetry) return
    setBusy(true)
    try { await onRetry() } finally { setBusy(false) }
  }

  const recheck = async (): Promise<void> => {
    if (!onRecheck) return
    setRechecking(true)
    try { await onRecheck() } finally { setRechecking(false) }
  }

  /* ── 取计划 ── */
  if (progress.phase === 'planning') {
    return (
      <div className={cn('flex items-center gap-2 rounded-lg border border-line bg-muted px-3 py-3 text-12 text-ink-3', className)}>
        <Spinner /> 正在向引擎确认 {progress.label} 的安装计划…
      </div>
    )
  }

  /* ── 引擎没有这个接口：降级成复制命令 ── */
  if (progress.phase === 'unsupported') {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <div className='flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2.5 text-12 leading-[1.7] text-ink-2'>
          <AlertTriangle size={14} className='mt-0.5 shrink-0 text-warn' />
          <span>引擎暂不支持一键安装（没有 /api/runtime/install-plan 接口）。已切回「复制命令」模式：命令来自 Coomi 内置指引，粘到 PowerShell 里执行即可。</span>
        </div>
        <CommandBlock command={fallbackCommand} hint='在 PowerShell 里执行（Windows 一键安装）' />
        <div className='flex flex-wrap items-center gap-2'>
          <Button variant='secondary' size='sm' onClick={() => void copy(fallbackCommand)}>
            <ClipboardCopy size={13} /> 复制命令
          </Button>
          {hint.url ? (
            <Button variant='ghost' size='sm' onClick={() => window.open(hint.url, '_blank', 'noopener,noreferrer')}>
              <ExternalLink size={13} /> 官网下载页
            </Button>
          ) : null}
          {onRecheck ? (
            <Button variant='ghost' size='sm' disabled={rechecking} onClick={() => void recheck()}>
              {rechecking ? <Spinner /> : <RefreshCw size={13} />} 我已装好，重新检测
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  /* ── 引擎不代装（Docker 这类）：只给人工引导 ── */
  if (progress.phase === 'guided') {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <div className='flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2.5 text-12 leading-[1.7] text-ink-2'>
          <Info size={14} className='mt-0.5 shrink-0 text-warn' />
          <span>{progress.guidance || '这一项需要人工安装并首次启动，引擎不会替你装。'}</span>
        </div>
        <CommandBlock command={progress.command || hint.winget} hint='手动执行（引擎不会代跑）' />
        <div className='flex flex-wrap items-center gap-2'>
          <Button variant='secondary' size='sm' onClick={() => void copy(progress.command || hint.winget)}>
            <ClipboardCopy size={13} /> 复制命令
          </Button>
          {onRecheck ? (
            <Button variant='ghost' size='sm' disabled={rechecking} onClick={() => void recheck()}>
              {rechecking ? <Spinner /> : <RefreshCw size={13} />} 我已装好，重新检测
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  /* ── 正在装：实时输出 + 取消 ── */
  if (progress.phase === 'running') {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <div className='flex flex-wrap items-center gap-2'>
          <ThinkingOrb state='connecting' size={20} />
          <span className='text-13 text-ink'>正在安装 {progress.label}</span>
          <Badge tone='primary'>{runtimeTaskLabel(progress.status)}</Badge>
          {elapsed ? <span className='text-11 tabular-nums text-ink-4'>已用时 {formatDuration(elapsed)}</span> : null}
          <span className='flex-1' />
          <span className='text-11 text-ink-4'>
            {progress.source === 'task-log' ? '实时输出 · 任务日志' : progress.source === 'install-status' ? '实时输出 · 安装任务' : '正在连接任务输出…'}
          </span>
        </div>
        <CommandBlock command={progress.command} hint='引擎正在执行的命令（--scope user，不弹 UAC）' />
        <pre
          ref={logRef}
          className='max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-[var(--code-bg,var(--surface-sunken))] p-3 font-mono text-11 leading-[1.7] text-ink-2'
        >
          {progress.log.length ? progress.log.join('\n') : '（还没有输出，winget 正在解析源与包…）'}
        </pre>
        <div className='flex items-center gap-2'>
          <Button variant='secondary' size='sm' disabled={busy} onClick={() => void cancel()}>
            <Square size={13} /> 取消安装
          </Button>
          <span className='text-11 text-ink-4'>取消会终止 winget 并把已下载的临时文件交回系统处理。</span>
        </div>
      </div>
    )
  }

  /* ── 装好了 ── */
  if (progress.phase === 'done') {
    const after = progress.after ?? progress.before
    return (
      <m.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className={cn('flex flex-col gap-3', className)}
      >
        <div className='flex items-start gap-2 rounded-lg border border-ok/30 bg-ok-soft px-3 py-2.5 text-12 leading-[1.7] text-ink-2'>
          <CheckCircle2 size={14} className='mt-0.5 shrink-0 text-ok' />
          <div>
            <div className='font-medium text-ink'>{progress.label} 已就绪</div>
            {after?.version ? <div className='mt-0.5 font-mono text-11 text-ink-3'>{after.version}</div> : null}
            {progress.notice ? <div className='mt-0.5 text-11 text-warn'>{progress.notice}</div> : null}
          </div>
        </div>
        {after?.path ? <div className='break-all font-mono text-11 text-ink-4'>{after.path}</div> : null}
        {onRecheck ? (
          <div className='flex items-center gap-2'>
            <Button variant='secondary' size='sm' disabled={rechecking} onClick={() => void recheck()}>
              {rechecking ? <Spinner /> : <RefreshCw size={13} />} 重新检测
            </Button>
            <span className='text-11 text-ink-4'>装完的东西要新进程才会被读到，下面可以直接重启。</span>
          </div>
        ) : null}
        {/* 装完运行环境：PATH 变了，重启应用才会被所有子进程读到；「本次不再提示」防止连续装时反复展开。 */}
        <RestartPrompt scenario='runtime' auto detail={'刚装好 ' + progress.label} />
      </m.div>
    )
  }

  /* ── 已取消 ── */
  if (progress.phase === 'cancelled') {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <div className='flex items-start gap-2 rounded-lg border border-line bg-muted px-3 py-2.5 text-12 text-ink-3'>
          <Info size={14} className='mt-0.5 shrink-0 text-ink-4' />
          <span>已取消 {progress.label} 的安装。可以随时重来一次。</span>
        </div>
        {onRetry ? (
          <Button variant='primary' size='sm' className='self-start' disabled={busy} onClick={() => void retry()}>
            重新安装
          </Button>
        ) : null}
      </div>
    )
  }

  /* ── 失败：指出哪一步 + stderr 尾部 + 重试 ── */
  if (progress.phase === 'failed') {
    const tail = progress.log.slice(-6)
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <div className='flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-12 leading-[1.7] text-danger'>
          <AlertTriangle size={14} className='mt-0.5 shrink-0' />
          <div className='min-w-0'>
            <div className='font-medium'>安装 {progress.label} 失败</div>
            <div className='mt-0.5 break-all text-11'>{progress.error || '引擎没有返回失败原因'}</div>
          </div>
        </div>
        {tail.length ? (
          <div className='rounded-lg border border-line bg-muted p-3'>
            <div className='text-11 text-ink-4'>任务日志尾部（winget / 工具自己的原话）</div>
            <pre className='mt-1.5 max-h-[160px] overflow-auto whitespace-pre-wrap break-all font-mono text-11 leading-[1.7] text-ink-2'>{tail.join('\n')}</pre>
          </div>
        ) : null}
        <div className='flex flex-wrap items-center gap-2'>
          {onRetry ? (
            <Button variant='primary' size='sm' disabled={busy} onClick={() => void retry()}>
              <RefreshCw size={13} /> 重试
            </Button>
          ) : null}
          <Button variant='secondary' size='sm' onClick={() => void copy(fallbackCommand)}>
            <ClipboardCopy size={13} /> 复制命令手动装
          </Button>
          {hint.url ? (
            <Button variant='ghost' size='sm' onClick={() => window.open(hint.url, '_blank', 'noopener,noreferrer')}>
              <ExternalLink size={13} /> 官网
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  /* ── 确认卡：完整命令 + 「允许一键安装」开关 ── */
  const plan = progress.plan
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className='flex items-center gap-2'>
        <span className='text-13 font-medium text-ink'>{progress.label}</span>
        {plan?.alreadyInstalled ? <Badge tone='neutral'>本机已检测到</Badge> : <Badge tone='warn'>本机未检测到</Badge>}
        {plan?.wingetAvailable === false ? <Badge tone='danger'>缺少 winget</Badge> : null}
      </div>
      {plan?.note ? <p className='text-12 leading-[1.7] text-ink-3'>{plan.note}</p> : null}
      <CommandBlock command={progress.command} hint='点「开始安装」后引擎执行的完整命令' />
      {(plan?.steps ?? []).length ? (
        <ol className='flex list-decimal flex-col gap-1 pl-5 text-11 leading-[1.7] text-ink-3'>
          {(plan?.steps ?? []).map((step) => <li key={step}>{step}</li>)}
        </ol>
      ) : null}
      <div className='flex flex-wrap items-center gap-3 rounded-lg border border-line p-3'>
        <div className='flex min-w-0 flex-1 items-center gap-2'>
          <ShieldCheck size={14} className={cn('shrink-0', allow ? 'text-primary' : 'text-ink-4')} />
          <div className='min-w-0'>
            <div className='text-12 text-ink'>允许一键安装</div>
            <div className='text-11 leading-[1.5] text-ink-4'>
              {allowedByEngine
                ? '引擎会以当前用户身份装到用户目录（--scope user，不弹 UAC），可以随时取消。'
                : '引擎设置里关闭了「允许一键安装运行时」：请到设置页打开，或用下面的复制命令手动安装。'}
            </div>
          </div>
        </div>
        <Switch checked={allow} disabled={!allowedByEngine || busy} aria-label='允许一键安装' onCheckedChange={setAllow} />
      </div>
      <div className='flex flex-wrap items-center gap-2'>
        <Button variant='primary' size='sm' disabled={busy || !allow} onClick={() => void confirm()}>
          {busy ? <Spinner /> : null} 开始安装
        </Button>
        <Button variant='secondary' size='sm' onClick={() => void copy(progress.command || hint.winget)}>
          <ClipboardCopy size={13} /> 复制命令
        </Button>
        {plan?.url || hint.url ? (
          <Button variant='ghost' size='sm' onClick={() => window.open(plan?.url || hint.url, '_blank', 'noopener,noreferrer')}>
            <ExternalLink size={13} /> 官网
          </Button>
        ) : null}
      </div>
    </div>
  )
}
