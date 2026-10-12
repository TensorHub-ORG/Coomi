import { memo, useState } from 'react'
import { ArrowUpToLine, Clock3, GripVertical, Pencil, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useSession } from '../../stores/session'
import type { ChatItem } from '../../lib/chat'

type Queued = Extract<ChatItem, {kind:'user'}>
function QueuedRow({item}: {item: Queued}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.text)
  const [busy, setBusy] = useState(false)
  const change = async (action: 'edit' | 'delete' | 'immediate') => {
    if (!item.queueId || busy) return
    setBusy(true)
    try { await useSession.getState().updateQueued(item.queueId, action, text); setEditing(false) }
    catch (error) { toast.error('队列操作失败：' + (error instanceof Error ? error.message : String(error))) }
    finally { setBusy(false) }
  }
  const disabled = busy || !item.queueId || item.queueImmediate
  return <div data-queued-message={item.queueId || item.id} className='min-w-0 border-b border-line-soft px-3 py-2 last:border-b-0'>
    <div className='flex min-w-0 items-center gap-2'>
      <GripVertical size={13} aria-hidden className='shrink-0 text-ink-4' />
      <span className='min-w-0 flex-1 truncate text-13 text-ink-2' title={item.text}>{item.text}</span>
      <button type='button' disabled={disabled} onClick={() => void change('immediate')} aria-label='立即执行排队消息' title='优先在当前任务之后执行' className='flex shrink-0 items-center gap-1 rounded-md bg-hover px-2 py-1 text-12 text-ink-2 hover:bg-sunken disabled:opacity-40'>
        {item.queueImmediate ? <Clock3 size={13} /> : <ArrowUpToLine size={13} />}{item.queueImmediate ? '已优先' : '立即'}
      </button>
      <button type='button' disabled={disabled} aria-label='编辑排队消息' onClick={() => { setText(item.text); setEditing(v=>!v) }} className='shrink-0 p-1 text-ink-4 hover:text-ink disabled:opacity-40'><Pencil size={14} /></button>
      <button type='button' disabled={disabled} aria-label='删除排队消息' onClick={() => void change('delete')} className='shrink-0 p-1 text-ink-4 hover:text-danger disabled:opacity-40'><Trash2 size={14} /></button>
    </div>
    {item.attachments?.length || item.quotes?.length ? <p className='ml-5 text-11 text-ink-4'>{item.attachments?.map(a=>a.name || a.path.split(/[\\/]/).pop()).join('、')}{item.quotes?.length ? ` · ${item.quotes.length} 条引用` : ''}</p> : null}
    {editing ? <div className='mt-2 pl-5'>
      <textarea aria-label='排队消息内容' autoFocus value={text} onChange={e=>setText(e.target.value)} className='max-h-36 min-h-16 w-full resize-y bg-canvas p-2 text-13 text-ink outline-none' />
      <div className='mt-1 flex justify-end gap-3 text-12'><button type='button' onClick={()=>setEditing(false)} disabled={busy}>取消</button><button type='button' disabled={busy || !text.trim()} className='text-primary disabled:opacity-40' onClick={()=>void change('edit')}>保存</button></div>
    </div> : null}
  </div>
}

export const QueuedMessages = memo(function QueuedMessages() {
  const items = useSession(useShallow(s=>s.messages.filter((m): m is Queued=>m.kind==='user' && !!m.queued)))
  if (!items.length) return null
  return <section data-message-queue aria-label='待执行消息队列' className='mb-2 max-h-52 overflow-y-auto rounded-xl border border-line bg-surface px-1'>
    {items.map(item=><QueuedRow key={item.queueId || item.id} item={item} />)}
  </section>
})
