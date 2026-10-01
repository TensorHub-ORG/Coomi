/** 「一键安装运行环境」对话框：把 RuntimeInstallPanel 装进弹窗，管住取计划的时机。
 *
 *  流程（3 次点击内完成）：卡片上的「一键装环境」→ 确认卡（命令 + 允许一键安装开关）
 *  → 「开始安装」→ 实时输出 → 完成自动重新探测。
 *  关掉弹窗不会中断安装：进度存在 store 里，任务在引擎侧照跑，重新打开还是同一张卡。 */
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Controls'
import { RuntimeInstallPanel } from './RuntimeInstallPanel'
import { useLibrary } from '../../stores/library'
import { runtimeLabel } from './runtimeMeta'

export function RuntimeInstallDialog({ open, onOpenChange, runtimeId, runtimeIdLabel, onRecheck }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 要装的运行时 id（npx / uvx / git …）；为 null 时只关不做事。 */
  runtimeId: string | null
  /** 展示用的名字（调用方可能已经有更好的文案）。 */
  runtimeIdLabel?: string
  /** 装完 / 用户点「重新检测」时调用的重检入口（一般是 recheckAll）。 */
  onRecheck?: () => void | Promise<void>
}) {
  const key = (runtimeId ?? '').trim().toLowerCase()
  const progress = useLibrary((s) => (key ? s.runtimeInstalls[key] : undefined))
  const prepareRuntimeInstall = useLibrary((s) => s.prepareRuntimeInstall)
  const runRuntimeInstall = useLibrary((s) => s.runRuntimeInstall)
  const cancelRuntimeInstall = useLibrary((s) => s.cancelRuntimeInstall)
  const previous = useRef('')

  // 打开（或换了 id）时取一次计划：prepareRuntimeInstall 对「已在跑 / 已有计划」是幂等的。
  useEffect(() => {
    if (!open || !key) return
    if (previous.current === key) return
    previous.current = key
    void prepareRuntimeInstall(key, runtimeIdLabel)
  }, [open, key, runtimeIdLabel, prepareRuntimeInstall])

  // 引擎没有一键安装接口：除卡片上的降级说明外再明确提示一次（用户点的是「一键装」）。
  const warned = useRef('')
  useEffect(() => {
    if (progress?.phase !== 'unsupported' || warned.current === key) return
    warned.current = key
    toast.message('引擎暂不支持一键安装', { description: '已切回「复制命令」模式：命令来自 Coomi 内置指引，粘到 PowerShell 里执行即可。' })
  }, [progress?.phase, key])

  const label = progress?.label || runtimeIdLabel || (key ? runtimeLabel(key) : '')
  const running = progress?.phase === 'running'

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={'一键安装 ' + (label || '运行环境')}
      description={running ? '安装进行中：关掉这个窗口不会中断，任务在引擎侧继续跑。' : '引擎会先给出将要执行的完整命令，确认后才动手。'}
      width={620}
      footer={
        <>
          <Button variant='ghost' size='sm' onClick={() => onOpenChange(false)}>关闭</Button>
          {running ? <span className='text-11 text-ink-4'>安装中，可随时在卡上取消</span> : null}
        </>
      }
    >
      {!key ? (
        <p className='text-12 text-ink-3'>没有指定要安装的运行时。</p>
      ) : !progress ? (
        <div className='flex items-center gap-2 py-6 text-12 text-ink-3'><Spinner /> 正在取安装计划…</div>
      ) : (
        <RuntimeInstallPanel
          progress={progress}
          onConfirm={async () => { await runRuntimeInstall(key) }}
          onCancel={async () => { await cancelRuntimeInstall(key) }}
          onRetry={async () => {
            // 重试 = 重新取一次计划再装：引擎版本/开关可能在这期间变了。
            await prepareRuntimeInstall(key, label)
            await runRuntimeInstall(key)
          }}
          onRecheck={onRecheck}
        />
      )}
    </Dialog>
  )
}
