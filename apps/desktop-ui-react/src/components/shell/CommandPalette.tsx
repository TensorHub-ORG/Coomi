import { useEffect, useMemo, useRef, useState } from 'react'
import { usePluginClientCommands } from '../plugins/clientRuntime'
import * as Dialog from '@radix-ui/react-dialog'
import {
  ArrowLeft, Brain, ChevronRight, FolderOpen, MessageSquare, Package, Plus, Puzzle, Search, Settings, Shield, Sparkles, UserRound,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { ipc } from '../../lib/ipc'
import { useSession } from '../../stores/session'
import { useEngine } from '../../stores/engine'
import { useUi, type ViewKey } from '../../stores/ui'
import { EFFORT_LABELS, PERMISSION_LABELS, useAgent } from '../../stores/agent'
import { sessionTitle, useWorkspace } from '../../stores/workspace'
import { Empty } from '../ui/Card'

/** 退场等待时长：比 --motion-base（180ms）留一点余量，轨道滑回去之后才卸载子层。 */
const SUB_EXIT_MS = 200

interface Command {
  id: string
  label: string
  hint?: string
  icon: React.ReactNode
  /** 叶子命令：选中即执行并关面板。 */
  run?: () => void
  /** 带 children 的命令＝一层：面板推进到子层，上一层留在左侧降透明度，退场反向。 */
  children?: () => Command[]
}

/// Ctrl/Cmd+K 命令面板：切会话、切模型、切页面、切策略，一次键盘搞定。
/// 分两层：根层是「动作」，策略 / 对话这类多选根层推进成子层（进出一层各 180ms 的位移）。
/// 搜索永远在**摊平后**的整个命令树上做——层级只负责浏览，不该让人记得「它在哪一层」。
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const sessions = useSession((s) => s.sessions)
  const openSession = useSession((s) => s.openSession)
  const newSession = useSession((s) => s.newSession)
  const setView = useUi((s) => s.setView)
  const cwd = useEngine((s) => s.cwd)
  const meta = useWorkspace((s) => s.meta)
  const effort = useAgent((s) => s.effort)
  const permission = useAgent((s) => s.permission)
  const setEffort = useAgent((s) => s.setEffort)
  const setPermission = useAgent((s) => s.setPermission)

  /// 子层：open 决定轨道位移（进 / 退各一层），cmd 决定这一层渲染什么。
  /// 退场时先把轨道滑回去、内容留在原地，动画播完再卸载——否则会「内容先消失、面板再退」。
  const [sub, setSub] = useState<{ cmd: Command; open: boolean } | null>(null)
  const exitTimer = useRef<number | null>(null)
  const depth = sub?.open ? 1 : 0
  const parent = sub?.cmd ?? null

  useEffect(() => { if (open) { setQuery(''); setIndex(0); setSub(null) } }, [open])
  useEffect(() => () => { if (exitTimer.current !== null) window.clearTimeout(exitTimer.current) }, [])

  const push = (cmd: Command): void => {
    if (exitTimer.current !== null) { window.clearTimeout(exitTimer.current); exitTimer.current = null }
    setSub({ cmd, open: true })
    setQuery('')
    setIndex(0)
  }
  const pop = (): void => {
    setQuery('')
    setIndex(0)
    setSub((s) => (s ? { ...s, open: false } : s))
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current)
    exitTimer.current = window.setTimeout(() => { setSub(null); exitTimer.current = null }, SUB_EXIT_MS)
  }

  /* 客户端插件注册的命令（订阅式：插件热加载后这里自动跟着变）。 */
  const pluginCommands = usePluginClientCommands()

  const root = useMemo<Command[]>(() => {
    const view = (key: ViewKey, label: string, icon: React.ReactNode): Command => ({
      id: 'view:' + key, label, icon, run: () => setView(key),
    })
    const list: Command[] = [
      { id: 'new', label: '新建对话', icon: <Plus size={15} />, run: () => { setView('chat'); void newSession() } },
      view('chat', '前往 对话', <MessageSquare size={15} />),
      view('skills', '前往 技能中心', <Sparkles size={15} />),
      view('artifacts', '前往 产物中心', <Package size={15} />),
      view('settings', '前往 设置', <Settings size={15} />),
      {
        id: 'open-cwd',
        label: '在资源管理器中打开工作目录',
        hint: cwd,
        icon: <FolderOpen size={15} />,
        run: () => { if (cwd) void ipc('open_path', { path: cwd }) },
      },
      {
        id: 'group:effort',
        label: '思考强度',
        hint: EFFORT_LABELS.find((e) => e.value === effort)?.label ?? '自动',
        icon: <Brain size={15} />,
        children: () => EFFORT_LABELS.map((level) => ({
          id: 'effort:' + level.value,
          label: '思考强度 · ' + level.label,
          hint: level.hint,
          icon: <Brain size={15} />,
          run: () => void setEffort(level.value),
        })),
      },
      {
        id: 'group:permission',
        label: '放行程度',
        hint: PERMISSION_LABELS.find((p) => p.value === permission)?.label ?? '每次询问',
        icon: <Shield size={15} />,
        children: () => PERMISSION_LABELS.map((mode) => ({
          id: 'perm:' + mode.value,
          label: '放行程度 · ' + mode.label,
          hint: mode.hint,
          icon: <Shield size={15} />,
          run: () => void setPermission(mode.value),
        })),
      },
      {
        id: 'group:sessions',
        label: '切换对话',
        hint: sessions.length + ' 个',
        icon: <UserRound size={15} />,
        children: () => sessions.map((s) => ({
          id: 'session:' + s.id,
          label: sessionTitle(s, meta),
          hint: s.cwd ?? '',
          icon: <UserRound size={15} />,
          run: () => { setView('chat'); void openSession(s.id) },
        })),
      },
      /* 客户端插件注册的命令：排在核心命令之后，hint 标出来源，便于分辨是谁提供的。
         插件热加载后这份列表会自动跟着变（useSyncExternalStore 订阅运行时）。 */
      ...pluginCommands.map((cmd) => ({
        id: 'plugin:' + cmd.pluginId + ':' + cmd.id,
        label: cmd.title,
        hint: '插件 · ' + cmd.pluginId,
        icon: <Puzzle size={15} />,
        run: cmd.run,
      })),
    ]
    return list
  }, [sessions, meta, cwd, effort, permission, newSession, openSession, setView, setEffort, setPermission, pluginCommands])

  /// 当前层自己的列表；搜索时把子层摊平一起搜（层级只负责浏览，搜索保持全局）。
  const needle = query.trim().toLowerCase()
  const pool = parent ? (parent.children?.() ?? []) : root
  // 没在搜索时不摊平：子层（尤其会话列表）可能很长，白建一遍对象没意义。
  const searchPool = !needle
    ? pool
    : parent
      ? pool
      : root.flatMap((cmd) => (cmd.children ? [cmd, ...cmd.children()] : [cmd]))
  const shown = (needle
    ? searchPool.filter((c) => c.label.toLowerCase().includes(needle) || (c.hint ?? '').toLowerCase().includes(needle))
    : searchPool
  ).slice(0, 40)

  /// 上一层的列表始终保留（退场期间也不清空，否则面板会「先空再退」）。
  const rootRows = parent ? root : shown
  const subRows = parent ? shown : []

  const activate = (cmd: Command | undefined): void => {
    if (!cmd) return
    if (cmd.children) { push(cmd); return }
    cmd.run?.()
    onOpenChange(false)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.max(0, Math.min(i + 1, shown.length - 1))) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'ArrowRight') {
      const target = shown[index]
      if (target?.children) { e.preventDefault(); push(target) }
    } else if (e.key === 'ArrowLeft') { if (parent) { e.preventDefault(); pop() } }
    else if (e.key === 'Backspace' && parent && !query) { e.preventDefault(); pop() }
    else if (e.key === 'Enter') { e.preventDefault(); activate(shown[index]) }
  }

  const rows = (items: Command[], active: boolean, enterKey: string) => (
    <div key={enterKey} className='animate-bar max-h-[52vh] overflow-y-auto p-1.5'>
      {items.map((cmd, i) => (
        <button
          key={cmd.id}
          type='button'
          tabIndex={active ? 0 : -1}
          onMouseEnter={() => { if (active) setIndex(i) }}
          onClick={() => { if (active) activate(cmd) }}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-13 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-enter)]',
            active && i === index ? 'bg-hover text-ink' : 'text-ink-2',
          )}
        >
          <span className='shrink-0 text-ink-3'>{cmd.icon}</span>
          <span className='min-w-0 flex-1 truncate'>{cmd.label}</span>
          {cmd.hint ? <span className='max-w-[240px] shrink-0 truncate text-11 text-ink-4'>{cmd.hint}</span> : null}
          {/* 有子层的行给一个「还能往里走」的箭头，和叶子命令区分开 */}
          {cmd.children ? <ChevronRight size={13} className='shrink-0 text-ink-4' /> : null}
        </button>
      ))}
      {!items.length ? <Empty compact art='search' className='py-6' title='没有匹配项' description='换个关键词，或按 Backspace 退回上一层。' /> : null}
    </div>
  )

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* 遮罩不套毛玻璃：全站只有标题栏那一层保留（见 theme.css 的 .glass-topbar），
            遮罩要的只是「压暗 + 挡住点击」，一层纯色比一次全屏 blur 便宜得多。 */}
        <Dialog.Overlay className='fixed inset-0 z-40 bg-black/30' />
        <Dialog.Content
          // Esc：有子层时先退一层，退到根层才关面板
          onEscapeKeyDown={(e) => { if (parent) { e.preventDefault(); pop() } }}
          className='fixed left-1/2 top-[16%] z-50 w-[600px] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-pop animate-rise'
        >
          <Dialog.Title className='sr-only'>命令面板</Dialog.Title>
          <div className='flex items-center gap-2 border-b border-line px-4 py-3'>
            {parent ? (
              <button
                type='button'
                onClick={pop}
                className='-ml-1 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-12 text-ink-3 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-enter)] hover:bg-hover hover:text-ink'
              >
                <ArrowLeft size={14} /> {parent.label}
              </button>
            ) : (
              <Search size={15} className='shrink-0 text-ink-4' />
            )}
            <input
              autoFocus
              value={query}
              onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
              onKeyDown={onKeyDown}
              placeholder={parent ? '在「' + parent.label + '」里筛选…' : '搜索对话、页面、模型策略…'}
              className='flex-1 bg-transparent text-14 text-ink placeholder:text-ink-4'
            />
            <kbd className='rounded border border-line-strong px-1.5 py-0.5 text-11 text-ink-4'>Esc</kbd>
          </div>
          {/* 层级推进：两层并排放在 200% 宽的轨道上，整体位移一层宽（.cmd-track，只动 transform），
              上一层留在原地降透明度；面板高度不参与动画，所以不会「撑一下」。 */}
          <div className='overflow-hidden'>
            <div className='cmd-track' data-depth={depth}>
              <div className='cmd-pane' data-active={!parent}>{rows(rootRows, !parent, 'root')}</div>
              <div className='cmd-pane' data-active={!!parent}>{rows(subRows, !!parent, parent ? parent.id : 'sub')}</div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
