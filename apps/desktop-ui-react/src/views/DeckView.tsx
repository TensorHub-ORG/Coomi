import { useEffect, useRef, useState } from 'react'
import { Menu, Plus, Terminal, Check, ChevronLeft, ChevronRight, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { useDeck } from '../stores/deck'
import { useEngine } from '../stores/engine'
import { confirmAction } from '../stores/dialogs'
import { useListPaneLayout } from '../components/shell/dockShared'
import { ChatView } from './ChatView'
import { useSession } from '../stores/session'
import { TerminalPanel } from '../components/deck/TerminalPanel'
import { newDeckTask } from '../components/deck/TaskPane'
import { Button } from '../components/ui/Button'
import { Menu as ActionMenu } from '../components/ui/Menu'
import { CliManager } from '../components/deck/CliManager'
import type { CoordinatorLayout } from '../components/deck/DeckActivity'

export function DeckView() {
  const tasks = useDeck((state) => state.tasks)
  const selected = useDeck((state) => state.selected)
  const mode = useDeck((state) => state.mode)
  const ready = useEngine((state) => state.ready)
  const sessionId = useSession((state) => state.sessionId)
  const surface = useSession((state) => state.sessionSurface)
  const question = useSession((state) => state.question)
  const { showInline, showDrawer, open, close } = useListPaneLayout()
  const task = tasks.find((item) => item.id === selected)
  const [maximized, setMaximized] = useState('')
  const [page, setPage] = useState(0)
  const grid = useRef<HTMLDivElement>(null)
  const coordinator = useRef<HTMLDivElement>(null)
  const visited = useRef(new Set<string>())
  if (task) visited.current.add(task.id)
  const [coordinatorLayout, setCoordinatorLayout] = useState<CoordinatorLayout>('compact')
  const [compactHeight, setCompactHeight] = useState(160)
  const [cliManager, setCliManager] = useState(false)
  const [columns, setColumns] = useState(3)
  useEffect(() => {
    if (question && coordinatorLayout === 'compact' && mode === 'deck') setCoordinatorLayout('half')
  }, [question, coordinatorLayout, mode])
  useEffect(() => {
    const element = grid.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0) setColumns(element.clientWidth >= 1080 ? 3 : element.clientWidth >= 720 ? 2 : 1)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [task?.id])
  const pageCount = Math.max(1, Math.ceil((task?.terminals.length || 0) / columns))
  const currentPage = Math.min(page, pageCount - 1)
  useEffect(() => { setMaximized('') }, [columns])
  useEffect(() => { setMaximized(''); setPage(0) }, [selected])
  useEffect(() => {
    const element = coordinator.current
    if (!element || coordinatorLayout !== 'compact') return
    const composer = element.querySelector<HTMLElement>('.workbench-composer-zone')
    const toolbar = element.querySelector<HTMLElement>('[data-chat-toolbar]')
    const stage = grid.current
    const resize = () => {
      if (!stage?.clientHeight) return
      // Collapsed conversation occupies one toolbar row, plus the Work composer.
      const height = Math.min(stage.clientHeight, Math.ceil((composer?.scrollHeight || 120) + (toolbar?.clientHeight || 37) + 1))
      element.style.height = height + 'px'
      setCompactHeight(height)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    if (composer) observer.observe(composer)
    if (toolbar) observer.observe(toolbar)
    if (stage) observer.observe(stage)
    resize()
    return () => { observer.disconnect(); element.style.removeProperty('height') }
  }, [selected, coordinatorLayout, sessionId, surface, mode])
  useEffect(() => {
    if (!ready || mode !== 'deck') return
    let active = true
    let timer: number
    const refresh = async () => { await useDeck.getState().refresh(); if (active) timer = window.setTimeout(() => void refresh(), 2500) }
    void refresh()
    return () => { active = false; window.clearTimeout(timer) }
  }, [ready, mode])
  const start = async (profile: string) => {
    if (!task) return
    const size = initialSize()
    try { await useDeck.getState().action(task.id, { action: 'start', profile, ...size }); await useDeck.getState().refresh(); setPage(Math.floor(task.terminals.length / columns)); setMaximized('') } catch (error) { toast.error(String(error)); if (profile !== 'powershell') setCliManager(true) }
  }
  const initialSize = () => {
    const count = Math.min(columns, (task?.terminals.length || 0) % columns + 1)
    return { cols: Math.max(2, Math.min(500, Math.floor(((grid.current?.clientWidth || 900) - 20 - (count - 1) * 8) / count / 7.8) - 3)), rows: Math.max(2, Math.min(500, Math.floor(((grid.current?.clientHeight || 680) - compactHeight - 70) / 15))) }
  }
  const actualMaximized = task?.terminals.some(terminal => terminal.id === maximized) ? maximized : ''
  const visible = task?.terminals.slice(currentPage * columns, currentPage * columns + columns) || []
  return <section className='deck-view' data-deck-view>
    <header className='workbench-toolbar flex h-[54px] shrink-0 items-center gap-2 border-b border-line px-4'>
      <Button variant='ghost' size='sm' onClick={() => showInline || showDrawer ? close() : open()}><Menu size={15} />任务列表</Button>
      <div className='min-w-0 flex-1'><p className='truncate text-14 font-semibold'>{task?.title || 'Deck · 任务调度'}</p>{task ? <p className='truncate text-10 text-ink-3' title={task.cwd}>{task.cwd}</p> : null}</div>
      {task?.status === 'active' ? <ActionMenu items={['codex', 'zcode', 'powershell'].map((profile) => ({ label: profile === 'powershell' ? 'PowerShell' : profile, onSelect: () => void start(profile) }))} trigger={<Button variant='ghost' size='sm' disabled={!ready}><Plus size={15} />添加 CLI</Button>} /> : null}
      {task ? <Button variant='ghost' size='sm' title='CLI 安装与模型配置' disabled={!ready} onClick={() => setCliManager(true)}><Settings2 size={15} />CLI 管理</Button> : null}
      {task?.status === 'active' ? <Button variant='ghost' size='icon-sm' title='结束并归档任务' onClick={() => { void confirmAction({ title: '结束并归档任务？', description: '请确认任务结果已验收。将关闭此任务的全部 CLI 终端。', confirmLabel: '归档' }).then(async (confirmed) => { if (confirmed) { await useDeck.getState().action(task.id, { action: 'finish' }); await useDeck.getState().refresh() } }).catch((error) => toast.error(String(error))) }}><Check size={16} /></Button> : null}
    </header>
    {!task ? <div className='m-auto max-w-md p-8 text-center text-ink-3'><Terminal size={38} className='mx-auto mb-4 text-primary' /><h2 className='mb-2 text-18 font-semibold text-ink'>让 CLI Agent 一起工作</h2><p className='mb-5 text-13'>按任务组织终端。你可以直接输入，也可以把就绪的终端交给 Coomi 派发指令。</p><Button variant='primary' disabled={!ready} onClick={() => void newDeckTask()}><Plus size={16} />新建任务</Button></div> : <>
      {task.terminals.length > columns ? <nav aria-label='终端分页' className='flex items-center gap-2 px-3 py-1 text-11 text-ink-3'><div className='flex min-w-0 flex-1 gap-1 overflow-auto'>{task.terminals.map((terminal, index) => <button key={terminal.id} className={'shrink-0 rounded px-2 py-1 ' + (Math.floor(index / columns) === currentPage ? 'bg-primary-soft text-primary' : 'hover:bg-hover')} title={terminal.status === 'running' ? '查看终端' : '查看终端日志'} onClick={() => { setPage(Math.floor(index / columns)); setMaximized('') }}>{index + 1} · {terminal.profile}{terminal.status !== 'running' ? ' · 已停止' : ''}</button>)}</div><Button variant='ghost' size='icon-sm' aria-label='上一组终端' disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setMaximized('') }}><ChevronLeft size={14} /></Button>{currentPage + 1} / {pageCount}<Button variant='ghost' size='icon-sm' aria-label='下一组终端' disabled={currentPage + 1 >= pageCount} onClick={() => { setPage(currentPage + 1); setMaximized('') }}><ChevronRight size={14} /></Button></nav> : null}
      <div ref={grid} className='deck-stage'>
        {tasks.filter(item => visited.current.has(item.id)).map(item => <div key={item.id} className='deck-terminal-grid' style={{ display: item.id !== selected ? 'none' : undefined, bottom: compactHeight, gridTemplateColumns: `repeat(${actualMaximized ? 1 : Math.max(1, visible.length)}, minmax(0, 1fr))` }} data-maximized={item.id === selected && !!actualMaximized}>
          {item.terminals.length ? item.terminals.map((terminal, index) => <div key={terminal.id} className='deck-terminal-slot' style={{ display: item.id !== selected || Math.floor(index / columns) !== currentPage || (actualMaximized && actualMaximized !== terminal.id) ? 'none' : undefined }}><TerminalPanel taskId={item.id} terminal={terminal} maximized={actualMaximized === terminal.id} onMaximize={() => setMaximized(actualMaximized === terminal.id ? '' : terminal.id)} /></div>) : <div className='deck-terminal-empty'><Terminal size={30} /><p>{item.status === 'completed' ? '此任务已归档' : '为这个任务启动 CLI'}</p>{item.status === 'active' ? <div className='flex gap-2'>{['codex', 'zcode', 'powershell'].map((profile) => <Button key={profile} variant='secondary' size='sm' disabled={!ready} onClick={() => void start(profile)}>{profile === 'powershell' ? 'PowerShell' : profile}</Button>)}</div> : null}</div>}
        </div>)}
        <div ref={coordinator} className='deck-coordinator' data-layout={coordinatorLayout} key={task.session_id}>{mode === 'deck' && surface === 'deck' && sessionId === task.session_id ? <ChatView deckLayout={coordinatorLayout} onDeckLayout={setCoordinatorLayout} /> : <div className='p-4 text-12 text-ink-3'>正在打开调度会话…</div>}</div>
      </div>
      <CliManager open={cliManager} onOpenChange={setCliManager} taskId={task.id} active={task.status === 'active'} initialSize={initialSize} onStarted={() => { setPage(Math.floor(task.terminals.length / columns)); setMaximized('') }} />
    </>}
  </section>
}
