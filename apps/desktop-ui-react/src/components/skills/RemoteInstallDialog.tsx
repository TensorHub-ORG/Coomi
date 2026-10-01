/** 远程条目的「一键安装」预填表单：推断不出启动方式、或清单要求填环境变量时弹它。
 *
 *  表单里的值全部来自清单（remoteInstallPlan / RemoteEntry），用户只需补齐缺的那几项：
 *  改个配置键名、填一个 API Key、必要时纠正命令或地址。确认后一次 POST
 *  /api/catalog/mcp/install-remote 写进 config/mcp_servers.json 并热重载——
 *  不再是「生成片段 → 自己粘进文件」。冲突（409）与「已保存但连不上」（502）都在卡里处理。 */
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, KeyRound, Terminal } from 'lucide-react'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Badge, Field, Input, Textarea } from '../ui/Input'
import { Segmented, Spinner } from '../ui/Controls'
import { useLibrary } from '../../stores/library'
import { remoteInstallPlan, remoteServerName, remoteSourceDef, splitArgs, type RemoteEntry } from './remoteSources'
import type { McpInstallResult, McpTransport } from './installClient'

type Transport = McpTransport

const TRANSPORTS: Array<{ value: Transport; label: string }> = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'http' },
  { value: 'sse', label: 'sse' },
]

/** 环境变量文本 ↔ 对象：一行一个 KEY=VALUE，允许 = 出现在值里。 */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return env
}

function asTransport(value: string): Transport {
  return value === 'http' || value === 'sse' || value === 'stdio' ? value : 'stdio'
}

export function RemoteInstallDialog({ open, onOpenChange, entry, onInstalled }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  entry: RemoteEntry | null
  /** 装完（写盘成功）时通知调用方：刷新已安装清单并回显连接状态。 */
  onInstalled?: (result: McpInstallResult) => void
}) {
  const installRemote = useLibrary((s) => s.installRemote)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<Transport>('stdio')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [url, setUrl] = useState('')
  const [envText, setEnvText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<McpInstallResult | null>(null)

  const plan = useMemo(() => (entry ? remoteInstallPlan(entry) : null), [entry])

  /** entry 的稳定键：**依赖里不能放 entry 对象本身** —— 调用方（RemoteMcpBrowser）手里那份
      是远程清单里的对象，而状态一变就可能是新引用。上面那个 effect 里全是 setState，
      拿对象当依赖就是「渲染 → 新对象 → effect 重跑 → setState → 再渲染」的自激环路
      （React #185 / Maximum update depth exceeded 的经典形状）。 */
  const entryKey = entry ? (entry.key || entry.id) + '|' + (entry.source ?? '') : ''

  // 每次打开都用清单里的值重置：关掉再开不会残留上一条的内容。
  useEffect(() => {
    if (!open || !entry || !plan) return
    setName(remoteServerName(entry))
    setTransport(plan.transport)
    setCommand(plan.command)
    setArgsText(plan.args.join(' '))
    setUrl(plan.url)
    setEnvText(plan.envKeys.map((key) => key + '=').join('\n'))
    setResult(null)
    setBusy(false)
    // plan 由 entry 派生，这里只认 entry 的变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entryKey])

  const env = useMemo(() => parseEnv(envText), [envText])
  const missingEnv = (plan?.envKeys ?? []).filter((key) => !(env[key] ?? '').trim())
  const problem = !name.trim()
    ? '请填一个配置键名（就是 mcp_servers.json 里 servers 的键）'
    : transport === 'stdio' && !command.trim()
      ? 'stdio 需要启动命令（例如 npx / uvx / node）'
      : transport !== 'stdio' && !url.trim()
        ? 'http/sse 需要服务器地址'
        : ''

  const submit = async (overwrite: boolean): Promise<void> => {
    if (!entry || !plan || problem) return
    setBusy(true)
    setResult(null)
    try {
      const outcome = await installRemote({
        id: entry.id,
        name: name.trim(),
        transport,
        command: command.trim(),
        args: splitArgs(argsText),
        env,
        url: url.trim(),
        overwrite,
      })
      setResult(outcome)
      if (outcome.ok) {
        toast.success('已安装 ' + name.trim() + '：已连接 · ' + outcome.toolsCount + ' 个工具')
        onInstalled?.(outcome)
      } else if (outcome.conflict) {
        toast.warning('已存在同名条目：可以「覆盖安装」')
      } else if (outcome.saved) {
        toast.error('配置已写入，但引擎没能连上它', { description: outcome.error.slice(0, 160) })
        onInstalled?.(outcome)
      } else {
        toast.error('安装失败', { description: (outcome.message || outcome.error).slice(0, 160) })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={'一键安装 ' + (entry?.name || entry?.id || '')}
      description={plan?.basis
        ? '清单给的依据：' + plan.basis + '。确认下面的值后一次装好，不用再手工改配置文件。'
        : '清单没有给出启动方式：补上命令或地址，一次装好。'}
      width={620}
      footer={
        <>
          <Button variant='ghost' size='sm' onClick={() => onOpenChange(false)}>关闭</Button>
          <Button
            variant='primary'
            size='sm'
            disabled={busy || !!problem}
            // 上一次是 409（已存在同名条目）：再点一次就是「覆盖安装」，不用再问一遍。
            onClick={() => void submit(result?.conflict === true)}
          >
            {busy ? <Spinner /> : null} {result?.conflict ? '覆盖安装' : '一键安装'}
          </Button>
        </>
      }
    >
      <div className='flex flex-col gap-3'>
        {entry?.description ? (
          <p className='rounded-lg border border-line bg-muted px-3 py-2 text-12 leading-[1.6] text-ink-2'>{entry.description}</p>
        ) : null}

        {result ? (
          <div className={result.ok
            ? 'flex items-start gap-2 rounded-lg border border-ok/30 bg-ok-soft px-3 py-2.5 text-12 leading-[1.7] text-ink-2'
            : result.conflict
              ? 'flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2.5 text-12 leading-[1.7] text-ink-2'
              : 'flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-12 leading-[1.7] text-danger'}>
            {result.ok ? <CheckCircle2 size={14} className='mt-0.5 shrink-0 text-ok' /> : <AlertTriangle size={14} className='mt-0.5 shrink-0' />}
            <div className='min-w-0'>
              {result.ok ? (
                <>
                  <div className='font-medium text-ink'>已连接 · {result.toolsCount} 个工具</div>
                  <div className='mt-0.5 break-all font-mono text-11 text-ink-4'>{result.path}</div>
                </>
              ) : result.conflict ? (
                <>
                  <div className='font-medium'>已存在同名条目</div>
                  <div className='mt-0.5 break-all text-11'>{result.message || result.error}</div>
                  <div className='mt-2'>
                    <Button variant='secondary' size='sm' disabled={busy} onClick={() => void submit(true)}>
                      覆盖安装
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className='font-medium'>{result.saved ? '配置已写入，但没能连上' : '安装失败'}</div>
                  <div className='mt-0.5 break-all text-11'>{result.error || result.message}</div>
                  {result.stderrTail ? (
                    <pre className='mt-1.5 max-h-[120px] overflow-auto whitespace-pre-wrap break-all font-mono text-11 leading-[1.6] opacity-90'>{result.stderrTail}</pre>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : null}

        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
          <Field label='配置键名（servers 里的键）'>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='例如 filesystem' />
          </Field>
          <Field label='传输方式'>
            <div className='pt-0.5'>
              <Segmented<Transport> value={transport} options={TRANSPORTS} onChange={(next) => setTransport(asTransport(next))} />
            </div>
          </Field>
        </div>

        {transport === 'stdio' ? (
          <>
            <Field label='启动命令'>
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder='npx / uvx / node' />
            </Field>
            <Field label='参数（空格分隔，含引号的片段原样保留）'>
              <Input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder='-y @modelcontextprotocol/server-filesystem C:\work' />
            </Field>
            <Field label={'环境变量（一行一个 KEY=VALUE' + (plan?.envKeys.length ? '，清单要求填 ' + plan.envKeys.length + ' 个' : '，可留空') + '）'}>
              <Textarea rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder='API_KEY=sk-…' />
            </Field>
            {plan?.envKeys.length ? (
              <p className='flex items-start gap-1.5 text-11 leading-[1.6] text-ink-4'>
                <KeyRound size={12} className='mt-0.5 shrink-0' />
                <span>
                  清单声明了必填环境变量：<span className='font-mono'>{plan.envKeys.join('、')}</span>
                  。取值一般写在它的仓库 / 官网 README 里；只写进本机配置文件，不会上传。
                  {missingEnv.length ? <span className='text-warn'>还有 {missingEnv.length} 个没填。</span> : null}
                </span>
              </p>
            ) : null}
          </>
        ) : (
          <Field label='服务器地址'>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder='https://example.com/mcp' />
          </Field>
        )}

        <div className='rounded-lg border border-line bg-muted p-3'>
          <div className='flex items-center gap-1.5 text-11 text-ink-4'>
            <Terminal size={12} /> 装完后引擎会立刻热重载并回报连接状态
          </div>
          <div className='mt-2 break-all font-mono text-11 leading-[1.7] text-ink-2'>
            {transport === 'stdio'
              ? [command.trim(), ...splitArgs(argsText)].filter(Boolean).join(' ') || '（还没填命令）'
              : (transport + ' · ' + (url.trim() || '（还没填地址）'))}
          </div>
          <div className='mt-2 flex flex-wrap items-center gap-1.5'>
            <Badge tone='neutral'>{entry ? '来源：' + remoteSourceDef(entry.source).label : '远程条目'}</Badge>
            {plan?.direct ? null : <Badge tone='warn'>需要确认</Badge>}
          </div>
        </div>

        {problem ? <p className='text-11 text-warn'>{problem}</p> : null}
      </div>
    </Dialog>
  )
}
