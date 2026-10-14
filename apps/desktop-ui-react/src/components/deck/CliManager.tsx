import { useEffect, useState } from 'react'
import { Download, Play, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useDeck } from '../../stores/deck'
import { useAgent } from '../../stores/agent'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'

interface CliStatus {
  installed: boolean; source: string; node_available: boolean; npm_available: boolean
  configuration: { managed: boolean; model?: string; base_url?: string; protocol?: string; effort?: string; has_api_key?: boolean }
}
export function CliManager({ open, onOpenChange, taskId, active, initialSize, onStarted }: {
  open: boolean; onOpenChange: (open: boolean) => void; taskId: string; active: boolean
  initialSize: () => { rows: number; cols: number }; onStarted: () => void
}) {
  const [profile, setProfile] = useState('codex')
  const [status, setStatus] = useState<CliStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [source, setSource] = useState('custom')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [protocol, setProtocol] = useState('openai-responses')
  const [effort, setEffort] = useState('auto')
  const providers = useAgent(state => state.providers)
  useEffect(() => {
    if (!open) { setApiKey(''); return }
    let mounted = true
    setStatus(null); setError(''); setApiKey(''); setSource('custom'); setWorking(true)
    void useAgent.getState().loadProviders()
    useDeck.getState().action<CliStatus>(taskId, { action: 'cli', operation: 'inspect', profile }).then(result => {
      if (!mounted) return
      setStatus(result); setModel(result.configuration.model || ''); setBaseUrl(result.configuration.base_url || '')
      setEffort(result.configuration.effort || 'auto'); setProtocol(result.configuration.protocol || (profile === 'codex' ? 'openai-responses' : 'openai-chat-completions'))
    }).catch(error => { if (mounted) setError(String(error)) }).finally(() => { if (mounted) setWorking(false) })
    return () => { mounted = false }
  }, [open, taskId, profile])
  const run = async (operation: string) => {
    if (working) return
    setWorking(true); setError('')
    try {
      if (operation === 'configure') {
        await useDeck.getState().action(taskId, { action: 'cli', operation, profile, model, effort: effort === 'auto' ? '' : effort, ...(source === 'custom' ? { base_url: baseUrl, api_key: apiKey, protocol } : { provider_id: source }) })
        setApiKey('')
        setStatus(await useDeck.getState().action(taskId, { action: 'cli', operation: 'inspect', profile }))
        toast.success('配置已保存，下次启动 CLI 生效')
      } else if (operation === 'inspect') {
        setStatus(await useDeck.getState().action(taskId, { action: 'cli', operation, profile }))
      } else {
        await useDeck.getState().action(taskId, { action: 'cli', operation, profile, ...initialSize() })
        await useDeck.getState().refresh(); onStarted(); onOpenChange(false)
        toast.success(operation === 'install' ? '已打开安装终端，可实时查看安装进度' : 'CLI 已启动')
      }
    } catch (error) { setError(String(error)) } finally { setWorking(false) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title='CLI 安装与模型配置' description='管理 Deck 中的 Codex 与 ZCode，或直接在底部请 Coomi 帮你操作。' width={540} footer={<><Button variant='ghost' onClick={() => onOpenChange(false)}>关闭</Button><Button variant='primary' disabled={working || !active || (source === 'custom' && (!model.trim() || !baseUrl.trim()))} onClick={() => void run('configure')}>保存模型配置</Button></>}>
    <div className='space-y-4'>
      <Select value={profile} disabled={working} onChange={setProfile} options={[{ value: 'codex', label: 'Codex' }, { value: 'zcode', label: 'ZCode' }]} />
      <div className='rounded-lg border border-line p-3 text-12'>
        <p>{working ? '正在处理…' : status?.installed ? '已安装' : '尚未安装'}{status?.source ? ' · ' + status.source : ''}</p>
        {profile === 'zcode' ? <p className='mt-1 text-11 text-ink-3'>安装使用 zcode-app-cli 社区终端客户端，Node.js 需为 22.19 或更新版本。</p> : null}
        <div className='mt-3 flex gap-2'>
          <Button variant='secondary' size='sm' disabled={working || !active || !status?.node_available || !status?.npm_available} onClick={() => void run('install')}><Download size={14} />{status?.installed ? '安装 / 更新' : '安装'}</Button>
          <Button variant='secondary' size='sm' disabled={working || !active || !status?.installed} onClick={() => void run('start')}><Play size={14} />启动终端</Button>
          <Button variant='ghost' size='sm' disabled={working} onClick={() => void run('inspect')}><RefreshCw size={14} />检查</Button>
        </div>
        {status && (!status.node_available || !status.npm_available) ? <p className='mt-2 text-11 text-ink-3'>安装 CLI 需要 Node.js 与 npm，安装后重新打开 Coomi。</p> : null}
      </div>
      <label className='block space-y-1.5 text-12'>API 配置来源<Select className='w-full' value={source} disabled={working || !active} onChange={value => { setSource(value); if (value !== 'custom') setModel(providers.find(provider => provider.id === value)?.model || '') }} options={[{ value: 'custom', label: '手动设置 API' }, ...providers.map(provider => ({ value: provider.id, label: '使用 Coomi 厂商 · ' + (provider.name || provider.id) }))]} /></label>
      {source === 'custom' ? <>
        <label className='block space-y-1.5 text-12'>API 地址<Input aria-label='CLI API 地址' value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder='https://api.example.com/v1' disabled={working || !active} /></label>
        <label className='block space-y-1.5 text-12'>API Key<Input aria-label='CLI API Key' type='password' autoComplete='off' value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={status?.configuration.has_api_key ? '留空保留现有密钥' : '输入 API Key'} disabled={working || !active} /></label>
        <label className='block space-y-1.5 text-12'>API 协议<Select className='w-full' value={protocol} onChange={setProtocol} disabled={working || !active || profile === 'codex'} options={[{ value: 'openai-responses', label: 'OpenAI Responses' }, { value: 'openai-chat-completions', label: 'OpenAI Chat Completions' }, { value: 'anthropic-messages', label: 'Anthropic Messages' }]} /></label>
      </> : <p className='text-11 text-ink-3'>在本机读取所选厂商的地址和密钥，无需在调度消息中填写密钥。Codex 需要支持 Responses API 的厂商。</p>}
      <label className='block space-y-1.5 text-12'>模型 ID<Input aria-label='CLI 模型 ID' value={model} onChange={event => setModel(event.target.value)} placeholder='使用厂商支持的模型 ID' disabled={working || !active} /></label>
      <label className='block space-y-1.5 text-12'>思考强度<Select className='w-full' value={effort} onChange={setEffort} disabled={working || !active} options={(profile === 'codex' ? ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] : ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).map(value => ({ value, label: value === 'auto' ? '使用 CLI / 模型默认值' : value }))} /></label>
      <p className='text-11 text-ink-3'>配置用于 Deck 启动的新终端，保存时自动备份。已开启的终端需重新启动后生效。</p>
      {error ? <p role='alert' className='break-words text-12 text-danger'>{error}</p> : null}
    </div>
  </Dialog>
}
