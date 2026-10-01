/** 技能市场顶部的「运行环境」状态条：缺什么一目了然，装完能当场复检。
 *
 *  数据来自 store 里的 /api/runtime/runtimes 结果；接口没上线时（引擎返回 404）
 *  这里不报错，而是降级成「引擎暂不支持检测」+ 列出市场条目真正用到的运行时，
 *  并保留「怎么装」（命令来自内置兜底表）与「重新检测」。 */
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronUp, ClipboardCopy, Cpu, ExternalLink, RefreshCw, Zap } from 'lucide-react'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Input'
import { Spinner } from '../ui/Controls'
import { copyText } from './clipboard'
import { RuntimeHelpDialog } from './RuntimeHelpDialog'
import { RestartPrompt } from './RestartPrompt'
import { useLibrary } from '../../stores/library'
import {
  helpTargetFor, missingRuntimesFor, referencedRuntimeIds, runtimeHint,
  type RuntimeHelpTarget, type RuntimeStatus,
} from './runtimeMeta'

/** 市场条目里跟运行时有关的那几个字段（store 里的类型更宽，这里只取需要的）。 */
type MarketplaceEntry = { command?: string; requires?: string[]; available?: boolean }

export function RuntimeBar({ onRecheck, onInstallRuntime }: {
  /** 重新拉 /api/catalog + /api/runtime/runtimes（外加调用方自己的已安装清单）。 */
  onRecheck: () => void | Promise<void>
  /** 「一键装」：交给调用方打开一键安装确认卡（缺哪个点哪个，装完自动重新探测）。 */
  onInstallRuntime?: (id: string, label: string) => void
}) {
  const runtimes = useLibrary((s) => s.runtimes)
  const status = useLibrary((s) => s.runtimesStatus)
  const error = useLibrary((s) => s.runtimesError)
  const checkedAt = useLibrary((s) => s.runtimesCheckedAt)
  const tools = useLibrary((s) => s.tools) as unknown as MarketplaceEntry[]
  /** 刚装/刚卸过东西时这里会有值：状态条上直接给出重启入口（见下面的两个 RestartPrompt）。 */
  const restartHint = useLibrary((s) => s.restartHint)
  const [open, setOpen] = useState(false)
  const [autofolded, setAutofolded] = useState(false)
  const [checking, setChecking] = useState(false)
  const [help, setHelp] = useState<{ target: RuntimeHelpTarget | null; reason: string } | null>(null)

  const missing = useMemo(() => missingRuntimesFor(runtimes, tools), [runtimes, tools])
  /// 接口不可用时退化成「市场需要这些」：状态一律未检测，但安装指引照给。
  const detected = status === 'ready' && runtimes.length > 0
  const expected = useMemo(() => referencedRuntimeIds(tools), [tools])
  const rows: RuntimeStatus[] = useMemo(() => {
    if (detected) return runtimes
    if (status === 'unsupported' || status === 'error') {
      return expected.map((id) => {
        const hint = runtimeHint(id)
        return {
          id, label: hint.label, found: false, version: '', path: '',
          installCommand: hint.winget, url: hint.url, note: hint.note, fromEngine: false,
        }
      })
    }
    return []
  }, [detected, runtimes, status, expected])

  // 第一次发现缺运行时就把详情展开：用户不用再点一下才知道缺什么。
  useEffect(() => {
    if (autofolded || status !== 'ready' || !missing.length) return
    setAutofolded(true)
    setOpen(true)
  }, [autofolded, status, missing.length])

  const run = async (): Promise<void> => {
    setChecking(true)
    try {
      await onRecheck()
      const next = useLibrary.getState()
      if (next.runtimesStatus === 'ready') {
        const gone = next.runtimes.filter((item) => !item.found)
        if (gone.length) toast.warning('仍然缺少 ' + gone.map((item) => item.label).join('、'))
        else toast.success('运行环境已就绪，市场里的条目都可以安装了')
      } else if (next.runtimesStatus === 'unsupported') {
        toast.message('当前引擎不支持运行环境检测', { description: '条目是否可用要看它自己的原因说明，可用「怎么装」里的命令自行确认。' })
      } else if (next.runtimesStatus === 'error') {
        toast.error('检测失败：' + (next.runtimesError || '未知错误'))
      }
    } finally {
      setChecking(false)
    }
  }

  const copyCommand = async (row: RuntimeStatus): Promise<void> => {
    if (!row.installCommand) {
      toast.error('这个运行时没有内置的一键命令，请点「怎么装」看官网步骤')
      return
    }
    const ok = await copyText(row.installCommand)
    if (ok) toast.success('已复制 ' + row.label + ' 的安装命令')
    else toast.error('复制失败：剪贴板不可用')
  }

  const summary = (() => {
    if (status === 'loading' || status === 'idle') {
      return <span className='flex items-center gap-1.5 text-12 text-ink-3'><Spinner /> 正在检测本机运行环境…</span>
    }
    if (status === 'unsupported') {
      return (
        <span className='flex min-w-0 flex-wrap items-center gap-1.5 text-12 text-ink-3'>
          <Badge tone='neutral'>引擎暂不支持检测</Badge>
          当前引擎没有 /api/runtime/runtimes 接口，条目为什么置灰只能看它自己的说明。
        </span>
      )
    }
    if (status === 'error') {
      return (
        <span className='flex min-w-0 flex-wrap items-center gap-1.5 text-12 text-ink-3'>
          <Badge tone='warn'>检测失败</Badge>
          <span className='min-w-0 truncate' title={error}>{error || '引擎没有返回可用结果'}</span>
        </span>
      )
    }
    if (!missing.length) {
      return <span className='flex items-center gap-1.5 text-12 text-ink-3'><Badge tone='ok'>全部就绪</Badge>{runtimes.length} 个运行时都已检测到</span>
    }
    return (
      <span className='flex min-w-0 flex-wrap items-center gap-1.5 text-12 text-ink-3'>
        <Badge tone='warn'>缺 {missing.length} 项</Badge>
        <span className='min-w-0 truncate text-ink-2' title={missing.map((item) => item.runtime.label).join('、')}>
          {missing.map((item) => item.runtime.label + (item.affected ? '（影响 ' + item.affected + ' 个条目）' : '')).join('、')}
        </span>
      </span>
    )
  })()

  return (
    <div className='mx-8 mt-3 shrink-0 rounded-lg border border-line bg-surface elev-1 px-3.5 py-2.5'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
        <span className='flex shrink-0 items-center gap-1.5 text-12 font-medium text-ink'>
          <Cpu size={14} className='text-ink-3' /> 运行环境
        </span>
        {summary}
        <span className='flex-1' />
        {checkedAt && detected ? (
          <span className='shrink-0 text-11 text-ink-4'>{new Date(checkedAt).toLocaleTimeString('zh-CN')} 检测</span>
        ) : null}
        <Button variant='ghost' size='sm' aria-expanded={open} aria-controls='runtime-bar-detail' onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />} {open ? '收起' : '详情'}
        </Button>
        <Button variant='secondary' size='sm' disabled={checking} onClick={() => void run()}>
          {checking ? <Spinner /> : <RefreshCw size={13} />} 重新检测
        </Button>
      </div>

      {/* 刚装完（或刚卸完）运行环境：状态条上就地给「重启引擎 / 重启应用」两个按钮，
          不用等用户展开详情。装运行环境改的是 PATH，只有新进程才会读到。 */}
      {detected && restartHint ? (
        <div className='mt-2 border-t border-line pt-2'>
          <RestartPrompt
            scenario={restartHint.target === 'engine' ? 'engine' : 'runtime'}
            detail={restartHint.label}
          />
        </div>
      ) : null}

      {/* 详情：内容常驻 DOM，靠 .collapse 的 grid-template-rows 0fr↔1fr 展开/收起（时长 --motion-collapse）；
          收起时 visibility + pointer-events 一起退出：里面的按钮既不显示、也点不到、Tab 也走不到。 */}
      <div id='runtime-bar-detail' className='collapse' data-open={open}>
        <div>
          {/* 展开区自己滚（2026-09-28「展开后超出屏幕」）：它以前是普通文档流、没有高度上限，
              而外层只有下面的列表能滚 —— 内容一多就被 .collapse 的 overflow:hidden 裁掉。
              48vh 与 420px 取小值：低配笔记本 + 125%/150% 缩放时窗口本来就只有 ~680 逻辑高。 */}
          <div className='mt-2.5 max-h-[min(48vh,420px)] overflow-y-auto overscroll-contain border-t border-line pt-1.5 pr-1'>
            {!rows.length ? (
              <p className='py-2 text-11 text-ink-4'>这次没有拿到可展示的运行时清单。</p>
            ) : null}
            {rows.map((row) => {
              const found = detected && row.found
              const affected = missing.find((item) => item.runtime.id === row.id)?.affected ?? 0
              return (
                <div key={row.id} className='flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5'>
                  <span className='w-[132px] shrink-0 truncate text-12 text-ink' title={row.label}>{row.label}</span>
                  <span className='w-[64px] shrink-0 font-mono text-11 text-ink-4'>{row.id}</span>
                  {detected ? (found ? <Badge tone='ok'>已就绪</Badge> : <Badge tone='warn'>未安装</Badge>) : <Badge tone='neutral'>未检测</Badge>}
                  {found && row.version ? <span className='shrink-0 text-11 text-ink-4'>{row.version}</span> : null}
                  <span className='min-w-0 flex-1 truncate font-mono text-11 text-ink-4' title={found ? row.path : row.note}>
                    {found && row.path ? row.path : row.note}
                  </span>
                  {affected ? <span className='shrink-0 text-11 text-warn'>{affected} 个条目受影响</span> : null}
                  {found ? null : (
                    <>
                      {onInstallRuntime ? (
                        <Button variant='primary' size='sm' title='引擎直接执行安装命令，装完自动重新探测' onClick={() => onInstallRuntime(row.id, row.label)}>
                          <Zap size={13} /> 一键装
                        </Button>
                      ) : null}
                      <Button variant='secondary' size='sm' onClick={() => setHelp({ target: helpTargetFor(row.id, runtimes), reason: '' })}>
                        怎么装
                      </Button>
                      {row.installCommand ? (
                        <Button variant='ghost' size='sm' onClick={() => void copyCommand(row)}>
                          <ClipboardCopy size={13} /> 复制命令
                        </Button>
                      ) : null}
                      {row.url ? (
                        <Button variant='ghost' size='sm' onClick={() => window.open(row.url, '_blank', 'noopener,noreferrer')}>
                          <ExternalLink size={13} /> 官网
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              )
            })}
            {/* 已安装的运行环境条目：装完要重启进程才会认新 PATH，这里常驻一组按钮。 */}
            {detected && runtimes.some((item) => item.found) ? (
              <div className='mt-1.5 border-t border-line pt-2'>
                <RestartPrompt
                  scenario={restartHint?.target === 'engine' ? 'engine' : 'runtime'}
                  detail='已就绪的运行环境'
                />
              </div>
            ) : null}
            <p className='pt-1 text-11 leading-[1.6] text-ink-4'>
              {detected
                ? '缺失的运行时装完后请重开一次 Coomi（PATH 才会刷新），再点上面的「重新检测」。'
                : '上面是技能市场条目里出现过的运行时。引擎这次没提供检测结果，所以状态显示为「未检测」：可以先用「怎么装」里的命令确认本机是否已安装。'}
            </p>
          </div>
        </div>
      </div>

      <RuntimeHelpDialog
        open={!!help}
        onOpenChange={(v) => { if (!v) setHelp(null) }}
        target={help?.target ?? null}
        reason={help?.reason ?? ''}
        onRecheck={() => run()}
        onOneClick={onInstallRuntime && help?.target ? () => {
          const target = help?.target
          setHelp(null)
          if (target) onInstallRuntime(target.id, target.label)
        } : undefined}
      />
    </div>
  )
}
