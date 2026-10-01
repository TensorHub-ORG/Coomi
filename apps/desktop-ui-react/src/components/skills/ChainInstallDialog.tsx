/** 「一键装环境并安装」的两步进度卡：先装缺的运行环境，再装工具本身。
 *
 *  为什么合成一张卡：条目缺 npx/uvx 时，分成两个弹窗会让用户在两步之间迷失
 *  （环境装完还要回去再点一次安装）。这里一张卡走完两步，且：
 *   · 第二步只在第一步成功后自动开始（不用再点一次）；
 *   · 失败时明确写出是哪一步失败，并附上那一步的 stderr / 任务日志尾部；
 *   · 重试从失败的那一步开始（环境装好了就不重复装）。
 *
 *  第一步复用 RuntimeInstallPanel（确认卡 + 实时输出 + 取消），第二步的落点由调用方决定：
 *  远程条目 → install-remote；内置目录条目 → /api/catalog/mcp/install。 */
import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Package, RefreshCw, Wrench,
} from 'lucide-react'
import { m } from 'motion/react'
import NumberFlow from '@number-flow/react'
import { ThinkingOrb } from 'thinking-orbs'
import { cn } from '../../lib/cn'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Input'
import { Spinner } from '../ui/Controls'
import { RuntimeInstallPanel } from './RuntimeInstallPanel'
import { RestartPrompt } from './RestartPrompt'
import { useLibrary } from '../../stores/library'
import { runtimeLabel } from './runtimeMeta'

/** 第二步（装工具）的结果：由调用方把各自接口的返回折成这个形状。 */
export interface ToolInstallOutcome {
  ok: boolean
  /** 一句可读的失败原因。 */
  error: string
  /** stderr / 连接诊断的尾部。 */
  tail: string
  /** 已存在同名条目（409）：卡上给「覆盖安装」。 */
  conflict: boolean
  connected: boolean
  toolsCount: number
  message: string
}

export const EMPTY_TOOL_OUTCOME: ToolInstallOutcome = {
  ok: false, error: '', tail: '', conflict: false, connected: false, toolsCount: 0, message: '',
}

type Stage = 'runtime' | 'tool' | 'done' | 'failed'

/** 一步的状态行：编号 + 名称 + 右侧状态。 */
function StepRow({ index, title, detail, state, children }: {
  index: number
  title: string
  detail?: string
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  children?: React.ReactNode
}) {
  return (
    <div className={cn(
      'rounded-lg border p-3 transition-colors duration-[var(--motion-fast)]',
      state === 'running' ? 'border-primary/40 bg-primary-soft/40' : 'border-line bg-surface',
      state === 'failed' && 'border-danger/30 bg-danger-soft/40',
    )}>
      <div className='flex items-center gap-2'>
        <span className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-11 tabular-nums',
          state === 'done' ? 'border-ok/40 bg-ok-soft text-ok'
            : state === 'failed' ? 'border-danger/40 bg-danger-soft text-danger'
              : state === 'running' ? 'border-primary/40 bg-primary text-white'
                : 'border-line-strong bg-sunken text-ink-4',
        )}>
          {state === 'done' ? <CheckCircle2 size={12} /> : state === 'failed' ? <AlertTriangle size={12} /> : index}
        </span>
        <span className='min-w-0 flex-1 truncate text-12 font-medium text-ink'>{title}</span>
        {state === 'running' ? <Badge tone='primary'>进行中</Badge> : null}
        {state === 'done' ? <Badge tone='ok'>已完成</Badge> : null}
        {state === 'pending' ? <Badge tone='neutral'>等待上一步</Badge> : null}
        {detail ? <span className='shrink-0 text-11 text-ink-4'>{detail}</span> : null}
      </div>
      {children ? <div className='mt-3'>{children}</div> : null}
    </div>
  )
}

export function ChainInstallDialog({ open, onOpenChange, runtimeId, runtimeName, toolName, onInstallTool, onRecheck, onInstalled }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 第一步要装的运行时（npx / uvx …）。 */
  runtimeId: string
  /** 运行时的展示名（可选，默认取 runtimeMeta 的兜底表）。 */
  runtimeName?: string
  /** 第二步要装的工具名（卡片标题 / 文案用）。 */
  toolName: string
  /** 第二步：真正把工具装上。overwrite=true 表示用户选了「覆盖安装」。 */
  onInstallTool: (overwrite: boolean) => Promise<ToolInstallOutcome>
  onRecheck?: () => void | Promise<void>
  /** 两步都成功：调用方据此刷新两条链路并回显「已连接 · N 个工具」。 */
  onInstalled?: (outcome: ToolInstallOutcome) => void
}) {
  const key = runtimeId.trim().toLowerCase()
  const progress = useLibrary((s) => (key ? s.runtimeInstalls[key] : undefined))
  const prepareRuntimeInstall = useLibrary((s) => s.prepareRuntimeInstall)
  const runRuntimeInstall = useLibrary((s) => s.runRuntimeInstall)
  const cancelRuntimeInstall = useLibrary((s) => s.cancelRuntimeInstall)

  const [stage, setStage] = useState<Stage>('runtime')
  const [failedAt, setFailedAt] = useState<'' | 'runtime' | 'tool'>('')
  const [outcome, setOutcome] = useState<ToolInstallOutcome | null>(null)
  const [busy, setBusy] = useState(false)
  const prepared = useRef('')
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) { wasOpen.current = false; return }
    // 每次打开都从第二步的干净状态开始（第一步的进度由 store 幂等地保留）；
    // 同一次打开里重复渲染不会重置，否则用户在卡上的选择会被自己抹掉。
    if (wasOpen.current && prepared.current === key) return
    wasOpen.current = true
    prepared.current = key
    setStage('runtime')
    setFailedAt('')
    setOutcome(null)
    void prepareRuntimeInstall(key, runtimeName)
  }, [open, key, runtimeName, prepareRuntimeInstall])

  const total = 2
  const doneSteps = stage === 'done' ? 2 : stage === 'tool' ? 1 : stage === 'failed' ? (failedAt === 'tool' ? 1 : 0) : 0
  const label = progress?.label || runtimeName || runtimeLabel(key)

  /** 第二步：装工具本身。 */
  const runToolStep = async (overwrite = false): Promise<void> => {
    setStage('tool')
    setFailedAt('')
    const result = await onInstallTool(overwrite)
    setOutcome(result)
    if (result.ok) {
      setStage('done')
      onInstalled?.(result)
      return
    }
    setStage('failed')
    setFailedAt('tool')
  }

  /** 完整两步：环境 → 工具。 */
  const runChain = async (): Promise<void> => {
    setBusy(true)
    try {
      setFailedAt('')
      setOutcome(null)
      setStage('runtime')
      const runtime = await runRuntimeInstall(key)
      if (runtime.phase === 'unsupported' || runtime.phase === 'guided') {
        // 引擎不支持一键装 / 这项必须人工装：停在第一步，卡片自己会给出降级文案。
        setStage('runtime')
        return
      }
      if (runtime.phase !== 'done') {
        setStage('failed')
        setFailedAt('runtime')
        return
      }
      await runToolStep()
    } finally {
      setBusy(false)
    }
  }

  const retry = async (): Promise<void> => {
    if (failedAt === 'tool') {
      setBusy(true)
      try { await runToolStep() } finally { setBusy(false) }
      return
    }
    await runChain()
  }

  const runtimeRunning = progress?.phase === 'running' || stage === 'runtime' && busy
  const runtimeState: 'pending' | 'running' | 'done' | 'failed' =
    stage === 'runtime' ? (progress?.phase === 'done' ? 'done' : 'running')
      : failedAt === 'runtime' ? 'failed'
        : 'done'

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={'安装 ' + toolName}
      description={'这条要用 ' + label + ' 拉起，本机还没检测到它：先装环境，再装工具，共 ' + total + ' 步。'}
      width={640}
      footer={
        <div className='flex w-full items-center gap-2'>
          <span className='flex-1 text-11 text-ink-4'>第 {Math.min(total, doneSteps + 1)} / {total} 步</span>
          <Button variant='ghost' size='sm' onClick={() => onOpenChange(false)}>{stage === 'done' ? '完成' : '关闭'}</Button>
        </div>
      }
    >
      <div className='flex flex-col gap-3'>
        {/* 进度条：两步的完成度，动的是 transform（domAnimation 够用） */}
        <div className='h-1 w-full overflow-hidden rounded-full bg-sunken'>
          <m.div
            className='h-full rounded-full bg-primary'
            initial={false}
            animate={{ width: (doneSteps / total) * 100 + '%' }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          />
        </div>

        <StepRow index={1} title={'安装运行环境：' + label} state={runtimeState}
          detail={runtimeRunning && progress?.status ? '安装中' : undefined}>
          {!key ? <p className='text-12 text-ink-3'>没有认出这条要用哪个运行时，请用「怎么装」按步骤手动安装。</p>
            : !progress ? <div className='flex items-center gap-2 text-12 text-ink-3'><Spinner /> 正在取安装计划…</div>
              : stage === 'runtime' || (stage === 'failed' && failedAt === 'runtime') ? (
                <RuntimeInstallPanel
                  progress={progress}
                  onConfirm={() => runChain()}
                  onCancel={async () => { await cancelRuntimeInstall(key) }}
                  onRetry={() => runChain()}
                  onRecheck={onRecheck}
                />
              ) : (
                <div className='flex flex-wrap items-center gap-2 text-11 text-ink-3'>
                  <CheckCircle2 size={12} className='text-ok' /> 已就绪
                  {progress.after?.version ? <span className='font-mono text-ink-4'>{progress.after.version}</span> : null}
                </div>
              )}
        </StepRow>

        <StepRow index={2} title={'安装工具：' + toolName} state={
          stage === 'done' ? 'done' : stage === 'tool' ? 'running' : failedAt === 'tool' ? 'failed' : 'pending'
        }>
          {stage === 'tool' ? (
            <div className='flex items-center gap-2 text-12 text-ink-3'>
              <ThinkingOrb state='weaving' size={20} />
              正在写入配置并热重载引擎…
            </div>
          ) : stage === 'done' && outcome?.ok ? (
            <div className='flex flex-wrap items-center gap-2 text-12 text-ink-2'>
              <CheckCircle2 size={13} className='text-ok' />
              <span>已连接</span>
              <span className='text-ink-4'>·</span>
              <span className='flex items-baseline gap-1'>
                <NumberFlow value={outcome.toolsCount} className='text-13 font-medium tabular-nums text-ink' />
                <span>个工具</span>
              </span>
            </div>
          ) : stage === 'failed' && failedAt === 'tool' && outcome ? (
            <div className='flex flex-col gap-2'>
              <div className={cn(
                'flex items-start gap-2 rounded-lg border px-3 py-2 text-12 leading-[1.6]',
                outcome.conflict ? 'border-warn/40 bg-warn-soft text-ink-2' : 'border-danger/30 bg-danger-soft text-danger',
              )}>
                <AlertTriangle size={13} className='mt-0.5 shrink-0' />
                <div className='min-w-0'>
                  <div className='font-medium'>第 2 步失败：{outcome.conflict ? '已存在同名条目' : '工具没有装成功'}</div>
                  <div className='mt-0.5 break-all text-11'>{outcome.error || '引擎没有返回原因'}</div>
                  {outcome.tail ? (
                    <pre className='mt-1.5 max-h-[120px] overflow-auto whitespace-pre-wrap break-all font-mono text-11 leading-[1.6] opacity-90'>{outcome.tail}</pre>
                  ) : null}
                </div>
              </div>
              <div className='flex flex-wrap items-center gap-2'>
                {outcome.conflict ? (
                  <Button variant='primary' size='sm' disabled={busy} onClick={() => void runToolStep(true)}>
                    <Package size={13} /> 覆盖安装
                  </Button>
                ) : null}
                <Button variant='secondary' size='sm' disabled={busy} onClick={() => void retry()}>
                  <RefreshCw size={13} /> 重试第 2 步
                </Button>
              </div>
            </div>
          ) : (
            <div className='flex items-center gap-2 text-11 text-ink-4'>
              <Wrench size={12} /> 环境装好后会自动开始，不用再点一次。
            </div>
          )}
        </StepRow>

        {stage === 'failed' && failedAt === 'runtime' ? (
          <p className='text-11 leading-[1.6] text-ink-4'>
            第 1 步没成功，所以还没有开始装工具。上面的「重试」会从第 1 步重来；重试只影响这一次安装，不会动已经装好的其它环境。
          </p>
        ) : null}

        {/* 两步卡的重启区：整整两步都成了就展开提示（装的是运行环境 + MCP 条目 → 重启应用最稳）；
            第 1 步已经装好、只有第 2 步失败时也给一组按钮（PATH 已经变了，重试之前先重启更省事）。 */}
        {stage === 'done' ? (
          <RestartPrompt scenario='runtime' auto detail={'已装好 ' + label + '，并写入 ' + toolName} />
        ) : null}
        {stage === 'failed' && failedAt === 'tool' ? (
          <RestartPrompt scenario='runtime' detail={'第 1 步已装好 ' + label + '（PATH 已变化），只有第 2 步失败'} />
        ) : null}
      </div>
    </Dialog>
  )
}
