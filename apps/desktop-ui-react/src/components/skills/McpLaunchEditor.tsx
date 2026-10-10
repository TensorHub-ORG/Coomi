import { useState } from 'react'
import { useEngine } from '../../stores/engine'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Overlay'
export function McpLaunchEditor({ id, onSaved }: { id: string; onSaved: () => void }) {
 const [open,setOpen]=useState(false),[raw,setRaw]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const [original,setOriginal]=useState<unknown>(null)
 const readOnly=id.startsWith('plugin:')
 async function show(){setBusy(true);setError('');try{const doc=await useEngine.getState().api<{servers:Record<string,unknown>}>('/api/settings/mcp');const config=doc.servers[id];if(!config)throw Error('找不到工具配置');setOriginal(config);setRaw(JSON.stringify(config,null,2));setOpen(true)}catch(e){setError(String(e))}finally{setBusy(false)}}
 async function save(){setBusy(true);setError('');try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('配置必须是对象');if(value.args&&!Array.isArray(value.args))throw Error('args 必须是字符串数组');if(value.args?.some((x:unknown)=>typeof x!=='string'))throw Error('args 中每一项必须是字符串');if(value.env&&Object.values(value.env).some(x=>typeof x!=='string'))throw Error('env 必须是字符串键值对');const doc=await useEngine.getState().api<{servers:Record<string,unknown>}>('/api/settings/mcp');if(JSON.stringify(doc.servers[id])!==JSON.stringify(original))throw Error('配置已变化，请关闭后重新打开');doc.servers[id]=value;await useEngine.getState().api('/api/settings/mcp',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(doc)});setOpen(false);onSaved()}catch(e){setError(String(e))}finally{setBusy(false)}}
 return <><Button size='sm' variant='ghost' disabled={busy} onClick={()=>void show()}>启动参数</Button>{error&&!open?<span className='text-11 text-danger'>{error}</span>:null}<Dialog open={open} onOpenChange={setOpen} title={'启动配置 · '+id} description='编辑 command、args（数组）、env、cwd。保存会重新连接工具；这些参数可启动本机程序，请确认来源。' width={620} footer={<Button disabled={busy||readOnly} onClick={()=>void save()}>保存并重连</Button>}><textarea aria-label='工具启动配置 JSON' className='w-full min-h-[260px] rounded border border-line bg-control p-3 font-mono text-12' value={raw} readOnly={readOnly} onChange={e=>setRaw(e.target.value)}/>{readOnly?<p>此配置由插件管理，不允许覆盖。</p>:null}{error?<p role='alert' className='text-danger text-12'>{error}</p>:null}</Dialog></>
}
