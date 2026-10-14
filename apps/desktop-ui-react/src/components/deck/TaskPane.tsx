import { useEffect, useState } from 'react'
import { Plus, Search, PanelLeftClose, ListTodo } from 'lucide-react'
import { toast } from 'sonner'
import { useDeck } from '../../stores/deck'
import { useEngine } from '../../stores/engine'
import { promptText } from '../../stores/dialogs'
import { Button } from '../ui/Button'

export async function newDeckTask(): Promise<void> {
  const title = await promptText({ title: '新建 Deck 任务', placeholder: '希望完成什么？', confirmLabel: '下一步' })
  if (!title?.trim()) return
  const cwd = await promptText({ title: '任务工作目录', value: useEngine.getState().cwd, placeholder: '选择已有项目目录', confirmLabel: '创建任务' })
  if (!cwd?.trim()) return
  try { await useDeck.getState().create(title, cwd) } catch (error) { toast.error(String(error)) }
}
export function TaskPane({ onClose }: { onClose?: () => void }) {
  const tasks = useDeck((state) => state.tasks)
  const selected = useDeck((state) => state.selected)
  const error = useDeck((state) => state.error)
  const ready = useEngine((state) => state.ready)
  const [search, setSearch] = useState('')
  useEffect(() => { if (ready) void useDeck.getState().refresh() }, [ready])
  return <aside data-deck-task-pane className='flex h-full min-h-0 flex-col border-r border-line bg-canvas-side p-3'>
    <div className='mb-4 flex items-center justify-between px-1 pt-3'><h2 className='text-16 font-semibold'>Deck</h2><Button variant='ghost' size='icon-sm' title='收起任务列表' onClick={onClose}><PanelLeftClose size={16} /></Button></div>
    <Button variant='primary' className='mb-3 w-full' disabled={!ready} onClick={() => void newDeckTask()}><Plus size={17} /> 新建任务</Button>
    <label className='mb-3 flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2'><Search size={15} className='text-ink-3' /><input aria-label='搜索任务' className='min-w-0 flex-1 bg-transparent text-12 outline-none' placeholder='搜索任务' value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    {error ? <p role='alert' className='mb-2 text-11 text-danger'>{error}<button className='ml-2 underline' onClick={() => void useDeck.getState().refresh()}>重试</button></p> : null}
    <div className='min-h-0 flex-1 space-y-1 overflow-auto'>{tasks.filter((task) => task.title.toLowerCase().includes(search.toLowerCase())).map((task) => <button key={task.id} onClick={() => useDeck.getState().select(task.id)} className={'w-full rounded-xl p-3 text-left transition-colors ' + (selected === task.id ? 'bg-primary-soft text-primary' : 'text-ink-2 hover:bg-hover')}>
      <div className='flex items-center gap-2'><ListTodo size={15} className='shrink-0' /><span className='truncate text-13 font-medium'>{task.title}</span></div>
      <p className='mt-1 truncate text-10 text-ink-3' title={task.cwd}>{task.cwd}</p>
      <p className='mt-1 text-10 text-ink-3'>{task.status === 'completed' ? '已归档' : task.terminals.some((terminal) => terminal.status === 'running') ? 'CLI 运行中' : '待操作'} · {task.terminals.length} 个终端</p>
    </button>)}</div>
    {!tasks.length && !error ? <p className='p-3 text-center text-12 text-ink-3'>创建任务，连接你的 CLI Agent。</p> : null}
  </aside>
}
