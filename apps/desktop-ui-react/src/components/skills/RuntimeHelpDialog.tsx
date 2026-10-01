/** 「怎么装」帮助弹窗：把灰显条目的「本机缺少运行环境」变成一条能照做的路径。
 *
 *  三件事必须说清楚：装什么（运行时 + 它是干什么的）、怎么装（Windows 一键命令可复制 +
 *  官网链接）、装完怎么办（重开 Coomi 让 PATH 生效，再点「我已装好，重新检测」）。
 *  引擎的 /api/runtime/runtimes 没上线时这里照旧可用 —— 命令来自 runtimeMeta 的兜底表。 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ClipboardCopy, ExternalLink, RefreshCw, Terminal, Wrench } from 'lucide-react'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Input'
import { Spinner } from '../ui/Controls'
import { copyText } from './clipboard'
import { useLibrary } from '../../stores/library'
import { runtimeStatusFor, type RuntimeHelpTarget } from './runtimeMeta'

export function RuntimeHelpDialog({ open, onOpenChange, target, reason, entryName, onRecheck, onOneClick }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 缺的运行时；认不出来时为 null（例如条目只是不支持当前系统）。 */
  target: RuntimeHelpTarget | null
  /** 条目给的原因原文：最可信，原样展示。 */
  reason?: string
  /** 触发这次帮助的条目名。 */
  entryName?: string
  onRecheck: () => void | Promise<void>
  /** 提供时多一个主按钮「一键安装」：交给调用方打开一键安装确认卡（引擎不支持时那张卡自己会降级）。 */
  onOneClick?: () => void
}) {
  const [checking, setChecking] = useState(false)
  /// 「仅支持 Windows / Android」这类是平台限制，装任何运行时都解决不了，要换一套说法。
  const platformBlocked = /仅支持/.test(reason ?? '')

  useEffect(() => {
    if (open) setChecking(false)
  }, [open, target?.id])

  const copy = async (): Promise<void> => {
    const command = target?.installCommand ?? ''
    if (!command) {
      toast.error('这条没有可复制的一键命令，请按官网步骤安装')
      return
    }
    const ok = await copyText(command)
    if (ok) toast.success('安装命令已复制，粘到 PowerShell 里回车即可')
    else toast.error('复制失败：剪贴板不可用，可以手动选中命令')
  }

  const recheck = async (): Promise<void> => {
    setChecking(true)
    try {
      await onRecheck()
      const state = useLibrary.getState()
      if (state.runtimesStatus !== 'ready') {
        toast.message('已重新拉取目录', { description: '当前引擎不支持自动检测运行环境，请用命令自行确认是否安装成功' })
        return
      }
      const now = target ? runtimeStatusFor(state.runtimes, target.id) : null
      if (now?.found) {
        toast.success('已检测到 ' + now.label + '，现在可以直接安装了')
      } else {
        toast.warning('还是没有检测到 ' + (target?.label ?? '该运行时'), {
          description: '装完请完全退出并重新打开 Coomi —— 新装的程序要重新读 PATH 才会被检测到。',
        })
      }
    } finally {
      setChecking(false)
    }
  }

  const title = platformBlocked
    ? '这个条目在当前系统上用不了'
    : target
      ? '装好 ' + target.label + ' 就能安装' + (entryName ? '「' + entryName + '」' : '')
      : '怎么把运行环境装好'

  const description = platformBlocked
    ? '这是平台限制，不是缺运行环境：装任何工具都装不上这个条目。'
    : '按下面的顺序做一遍，回来后点「我已装好，重新检测」即可。'

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      width={560}
      footer={
        <>
          <Button variant='ghost' size='sm' onClick={() => onOpenChange(false)}>关闭</Button>
          {!platformBlocked && target?.installCommand ? (
            <Button variant='secondary' size='sm' onClick={() => void copy()}>
              <ClipboardCopy size={13} /> 复制安装命令
            </Button>
          ) : null}
          {!platformBlocked && target && onOneClick ? (
            <Button variant='primary' size='sm' onClick={() => onOneClick()}>
              <Wrench size={13} /> 一键安装
            </Button>
          ) : null}
          <Button variant='primary' size='sm' disabled={checking} onClick={() => void recheck()}>
            {checking ? <Spinner /> : <RefreshCw size={13} />} 我已装好，重新检测
          </Button>
        </>
      }
    >
      <div className='flex flex-col gap-3'>
        {reason ? (
          <div className='flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-12 leading-[1.6] text-ink-2'>
            <Wrench size={13} className='mt-0.5 shrink-0 text-warn' />
            <span>{reason}</span>
          </div>
        ) : null}

        {platformBlocked ? (
          <div className='rounded-lg border border-line bg-muted p-3 text-12 leading-[1.7] text-ink-2'>
            <p>该条目在目录里声明了支持的系统，当前系统不在其中，所以引擎直接把它置灰：</p>
            <ul className='mt-1.5 list-disc pl-5 text-ink-3'>
              <li>可以换一个功能相近、支持当前系统的条目；</li>
              <li>也可以点条目上的「重新检测」再确认一次（换了系统或引擎版本后会重新判定）。</li>
            </ul>
          </div>
        ) : (
          <>
            {target ? (
              <div className='rounded-lg border border-line bg-muted p-3'>
                <div className='flex items-center gap-2'>
                  <span className='text-13 font-medium text-ink'>{target.label}</span>
                  <span className='font-mono text-11 text-ink-4'>{target.id}</span>
                  {target.status?.found ? <Badge tone='ok'>已检测到</Badge> : target.status ? <Badge tone='warn'>未检测到</Badge> : <Badge tone='neutral'>未检测</Badge>}
                </div>
                <p className='mt-1 text-12 leading-[1.7] text-ink-2'>{target.note}</p>
                {target.status?.version ? <div className='mt-1 font-mono text-11 text-ink-4'>版本 {target.status.version}</div> : null}
                {target.status?.path ? <div className='mt-0.5 break-all font-mono text-11 text-ink-4'>{target.status.path}</div> : null}
              </div>
            ) : (
              <p className='text-12 leading-[1.7] text-ink-2'>
                没能从条目信息里认出具体缺哪个运行时。可以先把 Node.js 与 uv 装上：市场上绝大多数条目用这两个之一拉起。
              </p>
            )}

            {target?.installCommand ? (
              <div className='rounded-lg border border-line bg-muted p-3'>
                <div className='flex items-center gap-1.5 text-11 text-ink-4'>
                  <Terminal size={12} /> Windows 一键安装（在 PowerShell 里执行）
                </div>
                <div className='mt-2 flex items-start gap-2'>
                  <code className='min-w-0 flex-1 break-all font-mono text-11 leading-[1.7] text-ink-2'>{target.installCommand}</code>
                  <Button variant='secondary' size='sm' className='shrink-0' onClick={() => void copy()}>
                    <ClipboardCopy size={13} /> 复制
                  </Button>
                </div>
                {target.status && !target.status.fromEngine ? (
                  <p className='mt-2 text-11 text-ink-4'>该命令来自 Coomi 内置指引（引擎这次没有返回安装命令），版本变化时以官网为准。</p>
                ) : null}
              </div>
            ) : (
              <div className='rounded-lg border border-line bg-muted p-3 text-12 text-ink-3'>
                这个运行时没有通用的一键命令，请按下面的官网步骤安装。
              </div>
            )}

            {target?.url ? (
              <div className='flex items-center gap-2'>
                <Button variant='secondary' size='sm' onClick={() => window.open(target.url, '_blank', 'noopener,noreferrer')}>
                  <ExternalLink size={13} /> 打开官网下载页
                </Button>
                <span className='min-w-0 truncate font-mono text-11 text-ink-4' title={target.url}>{target.url}</span>
              </div>
            ) : null}

            <div className='rounded-lg border border-line p-3'>
              <div className='text-11 text-ink-4'>步骤</div>
              <ol className='mt-1.5 flex list-decimal flex-col gap-1 pl-5 text-12 leading-[1.7] text-ink-2'>
                {(target?.steps ?? []).map((step) => <li key={step}>{step}</li>)}
              </ol>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
