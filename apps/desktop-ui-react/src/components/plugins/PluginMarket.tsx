import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Download, Globe, Package, RefreshCw, Store } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Empty } from '../ui/Card'
import { Button } from '../ui/Button'
import { Badge, Input } from '../ui/Input'
import { Spinner } from '../ui/Controls'
import { withDisplayName } from '../../lib/stormProbe'
import { BUILTIN_MARKET_URL, usePluginStore, type MarketPlugin } from './pluginStore'

/* 插件中心「市场」页签：输入仓库/清单 URL（或选内置固定 URL）→ plugin_market_list(url)
   列插件（名称/描述/版本）→「安装」调 plugin_install_from_url(zipUrl)。
   壳命令缺字段 / 不存在时与插件列表同一套可读降级（describeIpcError），进度与错误都以文字呈现。 */

type MarketStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 安装中的一条：zipUrl + 状态（壳侧下载解压安装，前端只呈现可读进度与结果）。 */
interface InstallState {
  zipUrl: string
  status: 'running' | 'ok' | 'error'
  message: string
}

export function PluginMarket() {
  const listMarket = usePluginStore((s) => s.listMarket)
  const installFromUrl = usePluginStore((s) => s.installFromUrl)

  const [url, setUrl] = useState(BUILTIN_MARKET_URL)
  const [status, setStatus] = useState<MarketStatus>('idle')
  const [plugins, setPlugins] = useState<MarketPlugin[]>([])
  const [message, setMessage] = useState('')
  const [install, setInstall] = useState<InstallState | null>(null)
  /// 组件卸载后不再 setState（市场页签切走时拉取/安装可能还在途）。
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async (target: string): Promise<void> => {
    setStatus('loading')
    setMessage('')
    const r = await listMarket(target)
    if (!alive.current) return
    setPlugins(r.plugins)
    setMessage(r.message)
    setStatus(r.ok ? 'ready' : 'error')
  }, [listMarket])

  /// 首次进入市场页签自动拉一次内置源。
  useEffect(() => {
    void load(BUILTIN_MARKET_URL)
  }, [load])

  const installPlugin = async (p: MarketPlugin): Promise<void> => {
    const zipUrl = p.zipUrl ?? ''
    if (!zipUrl) {
      setMessage('「' + p.name + '」没有可用的安装地址（壳侧未下发 zipUrl）')
      return
    }
    setInstall({ zipUrl, status: 'running', message: '正在下载并安装：' + zipUrl + ' …' })
    const r = await installFromUrl(zipUrl)
    if (!alive.current) return
    setInstall({ zipUrl, status: r.ok ? 'ok' : 'error', message: r.message })
  }

  const runningZip = install?.status === 'running' ? install.zipUrl : ''

  return (
    <div className='flex min-w-0 flex-col gap-2.5' data-testid='plugin-market'>
      {/* 仓库地址：输入清单 URL，或一键回内置固定源。 */}
      <div className='flex min-w-0 flex-wrap items-center gap-2'>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder='插件市场清单 URL（JSON）'
          className='h-8 min-w-[220px] flex-1'
        />
        <Button variant='ghost' size='sm' title='回到内置固定源' onClick={() => setUrl(BUILTIN_MARKET_URL)}>
          <Globe size={13} /> 内置源
        </Button>
        <Button variant='primary' size='sm' disabled={status === 'loading'} onClick={() => void load(url)}>
          <RefreshCw size={13} /> 拉取清单
        </Button>
      </div>

      {status === 'loading' ? (
        <p className='flex items-center gap-2 px-0.5 text-12 text-ink-3'>
          <Spinner className='text-primary' /> 正在向仓库拉取插件清单…
        </p>
      ) : null}

      {status === 'error' ? (
        <Empty
          compact
          icon={<AlertTriangle size={18} />}
          title='拉取清单失败'
          description={message || '未知原因；检查 URL 是否可达，或换内置固定源再试。'}
        />
      ) : null}

      {status === 'ready' && !plugins.length ? (
        <Empty
          compact
          icon={<Store size={18} />}
          title='仓库里没有插件'
          description={message || '试试别的清单 URL，或点「内置源」回到固定地址。'}
        />
      ) : null}

      {plugins.length ? (
        <div className='flex flex-col gap-2'>
          {plugins.map((p, i) => {
            const busy = p.zipUrl === runningZip
            const done = install && install.zipUrl === p.zipUrl && install.status !== 'running'
            return (
              <div key={p.id ?? (p.name ?? 'plugin') + i} className='card-lift min-w-0 rounded-xl border border-line bg-surface elev-1 p-3.5'>
                <div className='flex min-w-0 items-start gap-3'>
                  <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-ink-3'>
                    <Package size={15} />
                  </span>
                  <div className='min-w-0 flex-1'>
                    <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
                      <span className='min-w-0 truncate text-13 font-medium text-ink'>{p.name}</span>
                      {p.version ? <Badge tone='neutral'>{p.version}</Badge> : null}
                    </div>
                    {p.description ? <p className='mt-0.5 break-words text-12 leading-[1.55] text-ink-3'>{p.description}</p> : null}
                    {done ? (
                      <p className={cn('mt-1 text-11', install.status === 'ok' ? 'text-ok' : 'text-danger')}>{install.message}</p>
                    ) : null}
                  </div>
                  <Button
                    variant='secondary'
                    size='sm'
                    loading={busy}
                    disabled={runningZip !== '' && !busy}
                    onClick={() => void installPlugin(p)}
                    title={p.zipUrl ? '从 ' + p.zipUrl + ' 下载并安装' : '壳侧未下发 zipUrl，无法安装'}
                  >
                    <Download size={13} /> 安装
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

withDisplayName(PluginMarket, 'PluginMarket')
