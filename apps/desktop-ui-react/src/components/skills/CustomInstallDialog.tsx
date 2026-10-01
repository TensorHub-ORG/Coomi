/** 「自定义安装」对话框：把远程清单/手填的服务器整理成一段可以直接粘进
 *  config/mcp_servers.json 的配置。
 *
 *  这是一条**手动**路：常规安装已经是一键的（卡片主按钮 → POST /api/catalog/mcp/install-remote，
 *  见 RemoteMcpBrowser），这里留给「想自己改配置文件 / 把片段贴到别的机器」的用户。
 *  远程清单里字段不全的条目会先弹预填表单（RemoteInstallDialog），装不上时才需要来这里抄片段。 */
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ClipboardCopy, FolderOpen, Terminal } from 'lucide-react'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Input, Field, Textarea } from '../ui/Input'
import { Segmented } from '../ui/Controls'
import { copyText } from './clipboard'
import { mcpConfigFragment } from './remoteSources'
import { ipc } from '../../lib/ipc'

export interface CustomInstallSeed {
  id: string
  name?: string
  transport?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  repository?: string
  description?: string
  /** 来源标签（显示用，例如「npm 搜索」）。 */
  source?: string
}

type Transport = 'stdio' | 'http' | 'sse'

const TRANSPORTS: Array<{ value: Transport; label: string }> = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'http' },
  { value: 'sse', label: 'sse' },
]

function asTransport(value: string | undefined): Transport {
  return value === 'http' || value === 'sse' || value === 'stdio' ? value : 'stdio'
}

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

function envToText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {}).map(([key, value]) => key + '=' + value).join('\n')
}

export function CustomInstallDialog({ open, onOpenChange, seed, configPath }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  seed: CustomInstallSeed | null
  /** config/mcp_servers.json 的路径（取自 /api/runtime/installed），可能为空。 */
  configPath?: string
}) {
  const [id, setId] = useState('')
  const [transport, setTransport] = useState<Transport>('stdio')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [url, setUrl] = useState('')

  /** 种子的稳定键：**依赖里不能放 seed 对象本身** —— 它由调用方在渲染期新建，
      每次渲染都是新引用。这个 effect 里全是 setState，用它当依赖 =
      「渲染 → 新对象 → effect 重跑 → setState → 再渲染」的自激环路（React #185 的经典形状）。 */
  const seedKey = (seed?.id ?? '') + '|' + (seed?.name ?? '')

  // 每次打开（或换了一条种子）都用种子重置：关掉再开不会残留上一条的内容。
  useEffect(() => {
    if (!open) return
    setId(seed?.id ?? '')
    setTransport(asTransport(seed?.transport || (seed?.url ? 'http' : 'stdio')))
    setCommand(seed?.command ?? '')
    setArgsText((seed?.args ?? []).join(' '))
    setEnvText(envToText(seed?.env))
    setUrl(seed?.url ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed 只按 seedKey 认「是不是同一条」
  }, [open, seedKey])

  const fragment = useMemo(() => {
    const parsedArgs = argsText
      .match(/"[^"]*"|'[^']*'|\S+/g)
      ?.map((part) => part.replace(/^["']|["']$/g, ''))
      .filter(Boolean) ?? []
    const name = id.trim() || 'my-server'
    return mcpConfigFragment({
      id: name,
      transport,
      command: command.trim(),
      args: parsedArgs,
      env: parseEnv(envText),
      url: url.trim(),
    })
  }, [id, transport, command, argsText, envText, url])

  /** 目标文件里缺什么就先说清楚，别让用户复制完才发现命令是空的。 */
  /// 远程清单声明的必填环境变量（种子带进来的键），复制前提醒用户它们的值要自己找。
  const envRequired = useMemo(() => Object.keys(seed?.env ?? {}), [seed])

  const problem = !id.trim()
    ? '请填服务器名称（就是配置文件里的键名）'
    : transport === 'stdio' && !command.trim()
      ? 'stdio 需要填写启动命令（例如 npx / uvx / node）'
      : transport !== 'stdio' && !url.trim()
        ? 'http/sse 需要填写服务器地址'
        : ''

  const copy = async (): Promise<void> => {
    if (problem) { toast.error(problem); return }
    const ok = await copyText(fragment)
    if (ok) toast.success('配置片段已复制，粘贴进 mcp_servers.json 的 servers 里即可')
    else toast.error('复制失败：剪贴板不可用，可以手动选中下面的文本')
  }

  const openConfigFolder = async (): Promise<void> => {
    const target = (configPath ?? '').trim()
    if (!target) { toast.error('引擎还没返回配置文件路径'); return }
    try {
      // 壳里打开的是所在目录（explorer 会选中该文件）；直接给文件路径即可。
      await ipc('open_path', { path: target })
    } catch {
      toast.error('打开失败：请在浏览器里手动定位该文件')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title='自定义安装'
      description={seed?.name ? '来自 ' + (seed.source ?? '远程源') + '：' + seed.name : '手填一个 MCP 服务器，生成配置片段'}
      width={600}
      footer={
        <>
          <Button variant='ghost' size='sm' onClick={() => void openConfigFolder()}>
            <FolderOpen size={13} /> 配置文件位置
          </Button>
          <Button variant='primary' size='sm' onClick={() => void copy()}>
            <ClipboardCopy size={13} /> 复制配置片段
          </Button>
        </>
      }
    >
      <div className='flex flex-col gap-3'>
        {seed?.description ? (
          <p className='rounded-lg border border-line bg-muted px-3 py-2 text-12 leading-[1.6] text-ink-2'>{seed.description}</p>
        ) : null}
        {seed?.repository ? (
          <div className='truncate font-mono text-11 text-ink-4' title={seed.repository}>{seed.repository}</div>
        ) : null}

        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
          <Field label='服务器名称（配置键）'>
            <Input value={id} onChange={(e) => setId(e.target.value)} placeholder='例如 filesystem' />
          </Field>
          <Field label='传输方式'>
            <div className='pt-0.5'>
              <Segmented<Transport> value={transport} options={TRANSPORTS} onChange={setTransport} />
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
            <Field label='环境变量（一行一个 KEY=VALUE，可留空）'>
              <Textarea rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder='API_KEY=sk-…' />
            </Field>
            {envRequired.length ? (
              <p className='text-11 leading-[1.6] text-ink-4'>
                来源要求填这 {envRequired.length} 个环境变量：<span className='font-mono'>{envRequired.join('、')}</span>
                。取值一般写在它仓库 / 官网的 README 里；只写进本机配置文件，不会上传。
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
            <Terminal size={12} /> 写入 config/mcp_servers.json 的 servers 里的片段
          </div>
          <pre className='mt-2 max-h-[180px] overflow-auto whitespace-pre-wrap break-all font-mono text-11 leading-[1.6] text-ink-2'>{fragment}</pre>
        </div>

        <p className='text-11 leading-[1.6] text-ink-3'>
          常规安装用卡片上的「一键安装」即可（引擎会直接写进配置文件并热重载）；这里生成的片段是给
          「想自己改配置 / 贴到别的机器」用的：把它粘进 <span className='font-mono'>config/mcp_servers.json</span>
          {configPath ? <span className='font-mono'>（{configPath}）</span> : null}
          的 <span className='font-mono'>servers</span> 对象里，保存后到「已安装」页刷新，就能看到并启停它。
        </p>
        {problem ? <p className='text-11 text-warn'>{problem}</p> : null}
      </div>
    </Dialog>
  )
}
