/** 装完之后的重启提示：两个按钮 + 「稍后」+「本次不再提示」。
 *
 *  为什么需要它：装运行环境（Node / npx / uv / winget 这类）改的是 **PATH**，而 PATH 是进程启动时
 *  读一次的——引擎进程自己都还是老环境，新装的命令自然找不到。只有重启进程才会重新读：
 *   · 装了运行环境 → 重启**应用**最稳妥（引擎跟着一起重启，PATH 全刷新）；
 *   · 只写了 MCP 条目 → 配置已经热重载，重启**引擎**就够，不用打断整个应用。
 *
 *  「大量连续安装时不要每次弹」：连续装十个条目要是每次都弹一张卡，用户会被烦到关掉不看。
 *  所以「本次不再提示」是**进程内**的一份开关（应用一重启就自然复位）：勾一次，这一次运行里
 *  后面所有安装完成卡都不再自动展开提示，但两个按钮仍然留在原地，随时能点。
 *  「稍后」只收起**这一张**卡（同一次安装的那张），别的卡不受影响。
 *
 *  按钮走 Tauri IPC：engine_restart（壳重启引擎，前端 store 会重新握手）与 app_restart（壳退出并
 *  重新拉起自己）。壳还没有 app_restart 时会**如实报错**并给出替代做法，不假装成功。
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Info, RotateCw, Sparkles } from 'lucide-react'
import { useSession } from '../../stores/session'
import { create } from 'zustand'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Controls'
import { cn } from '../../lib/cn'
import { hasIpc, ipc } from '../../lib/ipc'
import { useEngine } from '../../stores/engine'
import { useLibrary } from '../../stores/library'

/* ── 「本次不再提示」的开关（进程内，退出应用即复位） ── */
interface RestartPromptPref {
  suppressed: boolean
  suppress: () => void
  restore: () => void
}

export const useRestartPromptPref = create<RestartPromptPref>((set) => ({
  suppressed: false,
  suppress: () => set({ suppressed: true }),
  restore: () => set({ suppressed: false }),
}))

/** 提示的场景：决定「该重启谁」的文案与推荐按钮。 */
export type RestartScenario =
  /** 刚装了运行环境（Node / uv / winget…）：PATH 变了，重启应用最稳妥。 */
  | 'runtime'
  /** 只写了 MCP 条目：重启引擎就够。 */
  | 'engine'
  /** 手动入口（设置页 / 开发者面板）：不推荐哪一档，两个按钮平权。 */
  | 'manual'

const WHY: Record<RestartScenario, { title: string; why: string; short: string }> = {
  manual: {
    title: '重启引擎 / 重启应用',
    why: '引擎重启只重启后台进程：当前会话会自动恢复，界面不用关。重启应用会退出并重新打开 Coomi：'
      + '改过 PATH 的安装（Node / uv / winget 这类）必须有新进程才会被读到，所以装完运行环境要用这一档。',
    short: '引擎 = 只重启后台进程（会话自动恢复）；应用 = 退出重开（新装的 Node / uv 才会被 PATH 认出来）。',
  },
  runtime: {
    title: '装完了，建议重启一次',
    why: '刚装的是本机运行环境（Node / npx / uv / winget 这类），它们改的是 PATH，而 PATH 只在进程启动时读一次：'
      + '引擎还是老环境，就会「明明装好了却找不到命令」。重启应用最稳妥（引擎跟着一起重启）；只重启引擎不会刷新 PATH。',
    short: '装了运行环境：重启应用才会重新读 PATH；只重启引擎不够。',
  },
  engine: {
    title: '装完了，需要时重启一下',
    why: '这次只写了 MCP 条目，配置已经热重载，通常不用重启。要是工具列表没刷新，重启引擎就够——'
      + '不用中断整个应用。',
    short: '只装了 MCP 条目：一般不用重启；工具列表没刷新时重启引擎即可。',
  },
}

/** 重启引擎：走壳的 engine_restart，并让 store 重新握手（拿新的 port / token）。 */
export async function restartEngineNow(): Promise<boolean> {
  if (!hasIpc()) {
    toast.error('桌面壳未就绪：当前不在 Coomi 桌面端里运行，重启引擎要回到桌面端操作')
    return false
  }
  // **任务进行中绝不重启**：引擎正在跑长工具/生成时，任何来源的重启都会把活干一半杀断
  // （用户遇到的「引擎反复崩溃」绝大多数是这类：装完环境弹「建议重启」，一点引擎就没了）。
  const running = useSession.getState()
  if (running.streaming || running.runState !== 'idle' || !!running.approval || !!running.question) {
    toast.error('当前有任务正在执行（生成/工具/审批），请等它结束后再重启引擎')
    return false
  }
  // store.restart() 内部走 ipc('engine_restart') 并重新 init；它把壳的报错记在 lastError 里。
  await useEngine.getState().restart()
  const next = useEngine.getState()
  if (next.status === 'running' && next.ready) {
    // 重启过了：把「建议重启」的待办清掉（重启应用是整进程重来，这份状态本来就会归零）。
    useLibrary.getState().setRestartHint(null)
    toast.success('引擎已重启，当前会话会自动恢复')
    return true
  }
  toast.error('重启引擎失败：' + (next.lastError || '引擎没有在预期时间内就绪'), {
    description: '可以再看一眼设置页「引擎与诊断 → 引擎日志」，或复制诊断信息反馈。',
  })
  return false
}

/** 重启应用：走壳的 app_restart；壳还没有这个命令时把壳的原话带出来，并给出替代做法。 */
export async function restartAppNow(): Promise<boolean> {
  if (!hasIpc()) {
    toast.error('桌面壳未就绪：当前不在 Coomi 桌面端里运行，请手动退出再打开')
    return false
  }
  try {
    await ipc('app_restart')
    toast.success('正在重启应用：窗口会重新打开，没发出去的输入会保留草稿')
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    toast.error('重启应用失败：' + message, {
      description: '可以先点「重启引擎」，或手动完全退出 Coomi 再打开——新装的 Node / uv / winget 要有新进程才会被 PATH 认出来。',
    })
    return false
  }
}

export function RestartPrompt({ scenario, auto = false, className, detail }: {
  /** 提示场景；缺省按「装了运行环境」处理（更保守的那一档文案）。 */
  scenario?: RestartScenario
  /** 安装刚完成：默认展开提示（「本次不再提示」被勾上后不再展开）。 */
  auto?: boolean
  className?: string
  /** 额外的一句上下文（例如「已装 2 项：node、uv」）。 */
  detail?: string
}) {
  const kind: RestartScenario = scenario ?? 'runtime'
  const text = WHY[kind]
  const suppressed = useRestartPromptPref((s) => s.suppressed)
  const suppress = useRestartPromptPref((s) => s.suppress)
  const restore = useRestartPromptPref((s) => s.restore)
  /** 首帧就决定要不要展开：勾过「本次不再提示」的这一次运行里，新的卡片直接是收起态。 */
  const [expanded, setExpanded] = useState(() => auto && !useRestartPromptPref.getState().suppressed)
  const [busy, setBusy] = useState<'' | 'engine' | 'app'>('')

  const doEngineRestart = async (): Promise<void> => {
    setBusy('engine')
    try { await restartEngineNow() } finally { setBusy('') }
  }

  const doAppRestart = async (): Promise<void> => {
    setBusy('app')
    try { await restartAppNow() } finally { setBusy('') }
  }

  const buttons = (
    <>
      <Button variant={kind === 'runtime' ? 'primary' : 'secondary'} size='sm' loading={busy === 'app'} disabled={busy !== ''} onClick={() => void doAppRestart()}>
        <RotateCw size={13} /> 重启应用
      </Button>
      <Button variant={kind === 'runtime' ? 'secondary' : kind === 'engine' ? 'primary' : 'secondary'} size='sm' loading={busy === 'engine'} disabled={busy !== ''} onClick={() => void doEngineRestart()}>
        <Sparkles size={13} /> 重启引擎
      </Button>
    </>
  )

  if (!expanded) {
    return (
      <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5', className)} data-testid='restart-actions'>
        <span className='flex min-w-0 items-start gap-1.5 text-11 leading-[1.6] text-ink-4'>
          <Info size={12} className='mt-0.5 shrink-0' />
          <span className='min-w-0'>{detail ? detail + ' ' : ''}{text.short}</span>
        </span>
        <span className='flex shrink-0 items-center gap-1.5'>{buttons}</span>
        <Button variant='ghost' size='sm' className='shrink-0' onClick={() => setExpanded(true)}>说明</Button>
      </div>
    )
  }

  return (
    <div
      className={cn('flex min-w-0 flex-col gap-2 rounded-lg border border-primary/25 bg-primary-soft px-3 py-3', className)}
      data-testid='restart-prompt'
    >
      <div className='flex min-w-0 flex-wrap items-center gap-2'>
        <RotateCw size={14} className='shrink-0 text-primary' />
        <span className='text-12 font-medium text-ink'>{text.title}</span>
        {detail ? <span className='min-w-0 text-11 text-ink-3'>{detail}</span> : null}
      </div>
      <p className='text-11 leading-[1.7] text-ink-2'>{text.why}</p>
      <p className='text-11 leading-[1.7] text-ink-4'>
        重启应用 = 退出并重新打开 Coomi（引擎一起重启，未发送的输入会保留草稿）；
        重启引擎 = 只重启后台进程，当前会话会自动恢复，界面不用关。
      </p>
      <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2'>
        {buttons}
        <Button variant='ghost' size='sm' disabled={busy !== ''} onClick={() => setExpanded(false)}>稍后</Button>
        <label className='ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 text-11 text-ink-3'>
          <Switch
            checked={suppressed}
            onCheckedChange={(value) => { if (value) suppress(); else restore() }}
            aria-label='本次不再提示'
          />
          本次不再提示
        </label>
      </div>
      <p className='text-11 leading-[1.6] text-ink-4'>
        {suppressed
          ? '已记下：这次运行里后面的安装完成卡不再自动展开提示，两个按钮仍然在卡片上，随时能点。'
          : '「稍后」只收起这一张卡；连续装多个条目时勾「本次不再提示」，后面就不会每次展开了。'}
      </p>
    </div>
  )
}
