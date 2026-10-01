/** 安装前填参数的表单弹窗：条目卡片上的「安装」遇到必填参数时先弹这里。
 *
 *  设计要求是「说明每个参数是什么」，所以每个输入框下面都要有一句话解释：
 *  参数的含义（知道就是知道，不知道就按 key/label 给出通用说明）、以及这个值最终
 *  写到哪（启动参数里的某个占位符 / 某个环境变量 / 配置文件）。底下再预览一次
 *  真实启动命令，用户点「安装」之前就知道引擎会执行什么。 */
import { useEffect, useMemo, useState } from 'react'
import { KeyRound, Terminal } from 'lucide-react'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Field, Input, Badge } from '../ui/Input'
import { Spinner } from '../ui/Controls'

export interface InstallParamSpec {
  key: string
  label: string
  secret?: boolean
  /** 引擎将来若在 required_parameters 里补说明，直接用它的。 */
  description?: string
  placeholder?: string
  example?: string
}

export interface InstallTarget {
  id: string
  name?: string
  description?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  required_parameters?: InstallParamSpec[]
}

/** 认不出的参数按关键词给一句通用说明：宁可说得保守，也不要瞎猜含义。 */
const KEY_HINTS: Array<{ test: RegExp; text: string }> = [
  { test: /(path|dir|directory|folder|root)/i, text: '本机上的一个绝对路径（Windows 例如 C:/work）。引擎会原样写进配置，路径不存在时服务器可能启动失败。' },
  { test: /(connection_string|dsn|database_url|(^|[_-])(url|uri)($|[_-]))/i, text: '服务地址 / 连接串，通常形如 postgresql://用户:密码@主机:5432/库名。' },
  { test: /(token|secret|password|passwd|api_?key|credential)/i, text: '访问密钥或令牌：只写进本机的 config/mcp_servers.json，不会上传到任何服务器。' },
  { test: /(port)/i, text: '端口号：填一个本机没有被占用的数字即可。' },
  { test: /(model|engine)/i, text: '模型名 / 引擎名：按对应服务的文档给出的名字填写。' },
  { test: /(host|server|endpoint)/i, text: '服务主机地址（含协议与端口）。' },
  { test: /(user|username|account)/i, text: '登录用户名。' },
  { test: /(id|key)/i, text: '标识类参数：按对应服务文档给出的 ID / Key 填写。' },
]

/** 这个参数最终写到哪：启动参数占位符、环境变量，还是只落在配置文件里。 */
export function parameterTarget(key: string, entry: InstallTarget): string {
  const token = '{{' + key + '}}'
  const envKey = Object.entries(entry.env ?? {}).find(([, value]) => value.includes(token))?.[0] ?? ''
  const inArgs = (entry.args ?? []).some((arg) => arg.includes(token))
  if (inArgs && envKey) return '会替换启动参数里的 ' + token + '，同时写入环境变量 ' + envKey + '。'
  if (inArgs) return '会替换启动参数里的 ' + token + '。'
  if (envKey) return '会写入环境变量 ' + envKey + '。'
  return '会保存进本机的 MCP 配置（config/mcp_servers.json）。'
}

/** 一句话说清这个参数是什么、写到哪。 */
export function parameterHelp(param: InstallParamSpec, entry: InstallTarget): string {
  const parts: string[] = []
  if (param.description) {
    parts.push(param.description)
  } else {
    const hit = KEY_HINTS.find((hint) => hint.test.test(param.key) || hint.test.test(param.label))
    parts.push(hit ? hit.text : '安装时必须填写的参数：取值请参考该服务器自己的文档。')
  }
  parts.push(parameterTarget(param.key, entry))
  if (param.secret) parts.push('输入时以密码方式显示，界面不会明文回显。')
  if (param.example) parts.push('例如：' + param.example)
  return parts.join(' ')
}

const PLACEHOLDER = new RegExp('[{]{2}([a-zA-Z0-9_]+)[}]{2}', 'g')

/** 用已填的值替换占位符，没填的显示成〈key〉：让用户看清到底会执行什么。 */
function previewCommand(entry: InstallTarget, values: Record<string, string>): string {
  const fill = (text: string): string =>
    text.replace(PLACEHOLDER, (_all, key: string) => (values[key] ?? '').trim() || '〈' + key + '〉')
  return [entry.command ?? '', ...(entry.args ?? []).map(fill)].filter(Boolean).join(' ')
}

export function InstallParamsDialog({ open, onOpenChange, entry, busy, onSubmit }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  entry: InstallTarget | null
  busy: boolean
  onSubmit: (values: Record<string, string>) => void | Promise<void>
}) {
  const [values, setValues] = useState<Record<string, string>>({})

  // 每次打开都清空：关掉再开不会把上一条的参数带进来。
  useEffect(() => {
    if (open) setValues({})
  }, [open, entry?.id])

  const params = entry?.required_parameters ?? []
  const command = useMemo(() => (entry ? previewCommand(entry, values) : ''), [entry, values])
  const missing = params.filter((param) => !(values[param.key] ?? '').trim())

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={'安装 ' + (entry?.name || entry?.id || '') + '：填写必填参数'}
      description='这些值会写进本机的 MCP 配置，装完可以在「已安装」页随时停用或卸载。'
      width={560}
      footer={
        <>
          <Button variant='ghost' size='sm' onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant='primary' size='sm' disabled={busy || missing.length > 0} onClick={() => void onSubmit(values)}>
            {busy ? <Spinner /> : null} 安装
          </Button>
        </>
      }
    >
      <div className='flex flex-col gap-3'>
        {entry?.description ? (
          <p className='rounded-lg border border-line bg-muted px-3 py-2 text-12 leading-[1.6] text-ink-2'>{entry.description}</p>
        ) : null}

        <div className='flex items-center gap-2 text-12 text-ink-3'>
          <KeyRound size={13} className='shrink-0 text-ink-4' />
          这个条目需要 {params.length} 个参数，全部填好才能安装。
        </div>

        {params.map((param) => (
          <Field key={param.key} label={param.label}>
            <div className='flex items-center gap-2'>
              <Input
                value={values[param.key] ?? ''}
                type={param.secret ? 'password' : 'text'}
                placeholder={param.placeholder || param.label}
                onChange={(event) => setValues((prev) => ({ ...prev, [param.key]: event.target.value }))}
              />
              {param.secret ? <Badge tone='warn'>密钥</Badge> : null}
            </div>
            <p className='text-11 leading-[1.6] text-ink-4'>
              <span className='font-mono'>{param.key}</span> · {parameterHelp(param, entry as InstallTarget)}
            </p>
          </Field>
        ))}

        <div className='rounded-lg border border-line bg-muted p-3'>
          <div className='flex items-center gap-1.5 text-11 text-ink-4'>
            <Terminal size={12} /> 安装后引擎会用这条命令拉起服务器
          </div>
          <div className='mt-2 break-all font-mono text-11 leading-[1.7] text-ink-2'>{command || '（未提供启动命令）'}</div>
          {missing.length ? (
            <p className='mt-2 text-11 text-warn'>还有 {missing.length} 个参数没填：{missing.map((param) => param.label).join('、')}</p>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
