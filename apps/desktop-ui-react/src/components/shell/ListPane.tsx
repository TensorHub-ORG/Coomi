import { useMemo, useState } from 'react'
import { ChevronRight, Copy, FileDown, Folder, FolderOpen, Hash, Plus, Pin, Pencil, RefreshCw, Trash2, Search, X, PanelLeftClose } from 'lucide-react'
import { m, type MotionProps } from 'motion/react'
import { cn } from '../../lib/cn'
import { ipc } from '../../lib/ipc'
import { motionOn, staggerSeconds } from '../../lib/motionPref'
import { useEngine } from '../../stores/engine'
import { currentSessionIsEmpty, useSession, type SessionSummary } from '../../stores/session'
import { useWorkspace, groupSessions, sessionTitle, type SessionMeta } from '../../stores/workspace'
import { Button } from '../ui/Button'
import { showContextMenu, type CtxItem } from '../../stores/contextMenu'
import { confirmAction, promptText } from '../../stores/dialogs'
import { toast } from 'sonner'
import { Input } from '../ui/Input'
import { Empty } from '../ui/Card'
import { useUi } from '../../stores/ui'
import { LIST_W, useListWidth } from './dockShared'
import { ResizeHandle } from './ResizeHandle'

/** 行入场：4px 的轻 rise + 按序号错峰（最多错 8 行，再往后一起到）。
    动效关掉时返回 null，走静态渲染——不再同时挂 CSS 动画类，两套不会并存。 */
function rowProps(index: number): MotionProps | null {
  if (!motionOn()) return null
  return {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.16, delay: Math.min(index, 8) * staggerSeconds(0.02), ease: 'easeOut' },
  }
}

/** 导出用的文件名：标题里的路径分隔符 / 通配符一律换成短横线，过长截断。 */
function safeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return cleaned || 'conversation'
}

/** 会话正文 → Markdown：只取 user / assistant 的正文，工具调用与思考过程不混进导出文件
    （要完整记录看会话 JSON；导出件是给人读的）。 */
function sessionMarkdown(title: string, messages: Array<Record<string, any>>): string {
  const out: string[] = ['# ' + title, '']
  for (const m of messages) {
    const role = String(m.role ?? '')
    if (role !== 'user' && role !== 'assistant') continue
    const text = typeof m.content === 'string' ? m.content.trim() : ''
    if (!text) continue
    out.push(role === 'user' ? '## 用户' : '## 助手', '', text, '')
  }
  return out.join('\n')
}

/** 「还没有内容的当前会话」在列表里的标识：灰色「空会话」。
 *  不用「未命名对话」那个兜底词 —— 那正是这一整件事要清掉的东西：
 *  空壳行跟真有内容的会话长得一样，用户根本分不出来。 */
const EMPTY_ROW_TITLE = '空会话'

/** 列表一行的显示标题：`empty`（当前会话的空占位行）一律显示成「空会话」，
    其余照旧走引擎摘要 / 本地重命名（sessionTitle）。
    搜索也按这个口径：搜「空会话」找得到它，搜「未命名对话」不会把任何一行翻出来。 */
function listRowTitle(s: SessionSummary, meta: Record<string, SessionMeta>): string {
  return s.empty ? EMPTY_ROW_TITLE : sessionTitle(s, meta)
}

/** 引擎给的报错统一成一句话。 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 会话列表栏。
    inline=常驻占位：宽度由外层 Panel（react-resizable-panels）控制，这里只画内容；
    drawer=窄窗口下的浮层：不在面板组里，宽度仍旧自己管（同一个 localStorage 键）并自带拖拽手柄。
    两种形态共用同一份列表内容、搜索、分组与右键菜单。 */
export function ListPane({ variant = 'inline', onClose }: {
  variant?: 'inline' | 'drawer'
  /** 收起 / 关闭本栏；由 App 按当前形态决定是「收起内嵌栏」还是「关掉抽屉」。 */
  onClose?: () => void
}) {
  const drawer = variant === 'drawer'
  // 抽屉自己控宽（浮层没有面板组可用）；内嵌形态的宽度归面板组，这里读到的值只当兜底。
  const drawerBox = useListWidth('drawer')
  const engine = useEngine((s) => s.cwd)
  const sessions = useSession((s) => s.sessions)
  const sessionId = useSession((s) => s.sessionId)
  const pendingCwd = useSession((s) => s.pendingCwd)
  const openSession = useSession((s) => s.openSession)
  const newSession = useSession((s) => s.newSession)
  const loadSessions = useSession((s) => s.loadSessions)
  const meta = useWorkspace((s) => s.meta)
  const collapsed = useWorkspace((s) => s.collapsed)
  const toggleCollapse = useWorkspace((s) => s.toggleCollapse)
  const patch = useWorkspace((s) => s.patch)
  const renameProject = useWorkspace((s) => s.renameProject)
  const setView = useUi((s) => s.setView)
  const [query, setQuery] = useState('')

  /** 列表数据 = 引擎给的那些（已经滤掉没有内容的，见 stores/session 的 loadSessions）
      + 当前会话的「空占位行」。
      为什么后者要单独补一行：用户就坐在那条会话里（老版本留下的空记录），
      列表里却一行都没有 —— 那不是「干净」，是「我在哪」都看不出来。
      它带 empty 标记，渲染成灰色「空会话」，绝不冒充一个正常的对话名；
      只要这条会话一有内容（发出第一条消息、或被重命名），它立刻变成普通行。
      新建但一个字都没发的会话**不在此列**：它由本地名单管，列表照旧不为它占行。
      cwd 取当前工作目录（这条空记录本来也没有自己的目录可言），它只决定这一行归在哪个分组。 */
  const listed = useMemo(() => {
    if (!sessionId || sessions.some((s) => s.id === sessionId)) return sessions
    if (!currentSessionIsEmpty()) return sessions
    const placeholder: SessionSummary = { id: sessionId, cwd: pendingCwd, empty: true }
    return [...sessions, placeholder]
  }, [sessions, sessionId, pendingCwd])

  const groups = useMemo(() => groupSessions(listed, engine, meta), [listed, engine, meta])

  // 抽屉是浮层：选中会话 / 新建对话之后要自动收起来，否则浮层一直挡着内容。
  // 内嵌形态没有这回事——它只在用户点头部那个「收起会话列表」按钮时才收起。
  const dismiss = drawer ? onClose : undefined

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map((g) => ({ ...g, sessions: g.sessions.filter((s) => listRowTitle(s, meta).toLowerCase().includes(q)) }))
      .filter((g) => g.sessions.length)
  }, [groups, query, meta])

  /// 行序号（跨分组连续）：错峰延迟按它算，分组之间的节奏才是连着的。
  const rowOrder = useMemo(() => {
    const order = new Map<string, number>()
    let i = 0
    for (const g of filtered) for (const s of g.sessions) order.set(s.id, i++)
    return order
  }, [filtered])

  /* ── 会话条目的右键菜单 ──
     统一走全局 ContextMenuHost 的 showContextMenu：Radix 那套 <ContextMenu> 触发器
     依赖 React 合成的 contextmenu 事件，而它已经被全局接管（见 ui/ContextMenuHost.tsx），
     条目上挂自己的菜单才收得到右键。 */

  const copyText = (text: string, ok: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(ok),
      () => toast.error('复制失败：剪贴板不可用'),
    )
  }

  /** 重命名：标题的权威值在会话元数据里（引擎落盘），改完重拉一次列表回显。 */
  const rename = async (s: SessionSummary): Promise<void> => {
    const next = await promptText({ title: '重命名会话', value: s.empty ? '' : sessionTitle(s, meta), placeholder: '输入新的会话名称', confirmLabel: '保存' })
    if (next === null) return
    const title = next.trim()
    if (!title) { toast.error('名称不能为空'); return }
    try {
      await useEngine.getState().api('/api/sessions/' + encodeURIComponent(s.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      await loadSessions()
      toast.success('已重命名')
    } catch (e) { toast.error('重命名失败：' + errText(e)) }
  }

  /** 置顶 / 取消置顶：本地 meta 决定排序与图标（先落定，操作立刻可见），再同步给引擎。 */
  const togglePin = (s: SessionSummary): void => {
    const next = !meta[s.id]?.pinned
    patch(s.id, { pinned: next })
    void useEngine.getState().api('/api/sessions/' + encodeURIComponent(s.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: next }),
    }).then(
      () => toast.success(next ? '已置顶' : '已取消置顶'),
      (e: unknown) => {
        // 引擎不认就回滚：不留一个只在本地成立的置顶。
        patch(s.id, { pinned: !next })
        toast.error('操作失败：' + errText(e))
      },
    )
  }

  /** 在文件夹中打开：会话自己的工作目录，没有就退到引擎当前目录。 */
  const openFolder = (s: SessionSummary): void => {
    const path = (s.cwd || engine || '').trim()
    if (!path) { toast.error('这条会话还没有工作目录'); return }
    void ipc('open_path', { path })
  }

  /** 导出 Markdown：读会话全文，写进它自己的工作目录（引擎的 /api/fs/write 直接落盘）。 */
  const exportMarkdown = async (s: SessionSummary, title: string): Promise<void> => {
    const dir = (s.cwd || engine || '').trim()
    if (!dir) { toast.error('这条会话还没有工作目录，导出的文件没地方落盘'); return }
    try {
      const data = await useEngine.getState().api<{ messages?: Array<Record<string, any>> }>(
        '/api/sessions/' + encodeURIComponent(s.id),
      )
      const path = dir.replace(/[\\/]+$/, '') + '/' + safeFileName(title) + '.md'
      await useEngine.getState().api('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: sessionMarkdown(title, data?.messages ?? []) }),
      })
      toast.success('已导出：' + path)
    } catch (e) { toast.error('导出失败：' + errText(e)) }
  }

  /** 删除：二次确认后删引擎磁盘记录，删的就是当前会话时先切走，最后重拉列表。 */
  const remove = async (s: SessionSummary, title: string): Promise<void> => {
    const ok = await confirmAction({
      title: '删除会话',
      description: '「' + title + '」会连同磁盘上的会话记录一起删除，无法撤销。',
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await useEngine.getState().api('/api/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' })
      if (s.id === sessionId) await newSession()
      await loadSessions()
      toast.success('已删除')
    } catch (e) { toast.error('删除失败：' + errText(e)) }
  }

  const rowMenu = (s: SessionSummary): CtxItem[] => {
    const title = listRowTitle(s, meta)
    const pinned = !!meta[s.id]?.pinned
    return [
      { label: '重命名', icon: <Pencil size={14} />, onSelect: () => { void rename(s) } },
      { label: pinned ? '取消置顶' : '置顶', icon: <Pin size={14} />, onSelect: () => togglePin(s) },
      { label: '复制标题', icon: <Copy size={14} />, onSelect: () => copyText(title, '已复制标题') },
      { label: '复制会话 ID', icon: <Hash size={14} />, onSelect: () => copyText(s.id, '已复制会话 ID') },
      { divider: true },
      { label: '在文件夹中打开', icon: <FolderOpen size={14} />, onSelect: () => openFolder(s) },
      { label: '导出 Markdown', icon: <FileDown size={14} />, onSelect: () => { void exportMarkdown(s, title) } },
      { divider: true },
      { label: '删除', icon: <Trash2 size={14} />, danger: true, onSelect: () => { void remove(s, title) } },
    ]
  }

  /** 空白处的菜单：列表里最常用的两个动作。 */
  const blankMenu = (): CtxItem[] => [
    { label: '新建会话', icon: <Plus size={14} />, onSelect: () => { void newSession(); dismiss?.() } },
    {
      label: '刷新列表',
      icon: <RefreshCw size={14} />,
      onSelect: () => {
        void loadSessions().then(() => toast.success('已刷新列表'), (e: unknown) => toast.error('刷新失败：' + errText(e)))
      },
    },
  ]

  // data-shell-part：显式登记为「外壳部件」，CSS 据此给内嵌栏/抽屉栏各自一个
  // view-transition-name（两者互斥，同时只会在 DOM 里出现一个，名字不会撞车）。
  // 用显式标记而不是 [data-app-shell] > ... 这类结构选择器：外壳里多套一层 div 就不会失效。
  return (
    <aside
      id={drawer ? 'coomi-list-drawer' : 'coomi-list'}
      data-list-pane
      data-list-variant={variant}
      data-shell-part={drawer ? 'drawer' : 'list'}
      data-shell-frozen
      style={drawer ? { width: drawerBox.width } : undefined}
      className={cn(
        'relative flex h-full min-w-0 flex-col bg-side',
        // 内嵌形态的左右边界由面板组的分隔条画，自己不再描边（否则两条线并排）
        drawer ? 'shrink-0 border-r border-line' : 'w-full',
      )}
    >
      <div className='session-heading'><span>Coomi</span><span className='session-heading-note'>与灵感同行</span></div>
      <div className='flex items-center gap-2 px-3 pt-3 pb-2'>
          {/* 新对话常驻头部：列表里最常用的动作，不该藏在别处。
              文字显式跟密度档的 13 号走，字重比按钮默认的 font-medium 再加一档 ——
              它是这一栏唯一的主行动，压得住下面一整列会话标题（Button 的 size=md 已是 13 号，
              这里写死是防止以后有人把密度档调小，这一格跟着缩下去）。 */}
          <Button variant='primary' size='md' className='new-conversation min-w-0 flex-1 text-13 font-semibold' onClick={() => { void newSession(); dismiss?.() }}>
            <Plus size={14} /> 新会话
          </Button>
          {onClose ? (
            <button
              type='button'
              data-list-collapse
              title={drawer ? '关闭会话列表' : '收起会话列表'}
              aria-label={drawer ? '关闭会话列表' : '收起会话列表'}
              onClick={onClose}
              className='grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-3 transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-ink'
            >
              {drawer ? <X size={14} /> : <PanelLeftClose size={15} />}
            </button>
          ) : null}
        </div>
        <div className='relative px-4 pb-3'>
          <Search size={13} className='pointer-events-none absolute left-[22px] top-1/2 -translate-y-1/2 text-ink-4' />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='搜索会话'
            aria-label='搜索会话'
            className='h-7 border-transparent bg-muted pl-7 text-12'
          />
        </div>
        {/* 空白处右键：条目自己的菜单会 stopPropagation，冒泡不到这里 */}
        <div
          className='workbench-list flex-1 overflow-y-auto px-3 pb-4'
          onContextMenu={(e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, blankMenu()) }}
        >
          {filtered.map((g) => {
            const isCollapsed = collapsed[g.key]
            return (
              <div key={g.key} className='mb-1'>
                <div className='group/head flex items-center gap-1 px-1 py-1'>
                  <button
                    type='button'
                    onClick={() => toggleCollapse(g.key)}
                    className='flex min-w-0 flex-1 items-center gap-1 rounded-[5px] px-1 py-0.5 text-11 font-medium text-ink-3 hover:text-ink-2'
                  >
                    <ChevronRight size={12} className={cn('shrink-0 transition-transform', !isCollapsed && 'rotate-90')} />
                    {g.kind === 'project' ? <Folder size={12} className='shrink-0' /> : null}
                    <span className='truncate'>{g.label}</span>
                    <span className='text-ink-4'>{g.sessions.length}</span>
                  </button>
                  {g.kind === 'project' ? (
                    <button
                      type='button'
                      title='重命名项目'
                      onClick={() => {
                        void promptText({ title: '重命名项目', value: g.label, confirmLabel: '保存' }).then((next) => {
                          if (next?.trim()) renameProject(g.path, next.trim())
                        })
                      }}
                      className='shrink-0 rounded p-0.5 text-ink-4 opacity-0 group-hover/head:opacity-100 hover:text-ink-2'
                    >
                      <Pencil size={12} />
                    </button>
                  ) : null}
                </div>
                {!isCollapsed ? (
                  <ul>
                    {g.sessions.map((s) => {
                      const on = s.id === sessionId
                      return (
                        <m.li key={s.id} {...(rowProps(rowOrder.get(s.id) ?? 0) ?? {})}>
                          <button
                            type='button'
                            data-session-row
                            aria-current={on ? 'true' : undefined}
                            onClick={() => { setView('chat'); void openSession(s.id); dismiss?.() }}
                            // 右键菜单走全局宿主；stopPropagation 挡住外层「空白处」那份菜单。
                            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, rowMenu(s)) }}
                            className={cn(
                              'relative flex h-9 w-full items-center gap-2 overflow-hidden rounded-lg pr-2.5 text-left text-13 transition-all duration-[var(--motion-fast)]',
                              on
                                ? 'border border-row-active-line bg-row-active pl-3 text-ink'
                                : 'border border-transparent pl-3 text-ink-2 hover:border-line hover:bg-hover',
                            )}
                          >
                            {/* 通高强调条：贴着整行左边，不再是插在文字中间的小短线 */}
                            {meta[s.id]?.pinned ? <Pin size={11} className='shrink-0 text-ink-4' /> : null}
                            {/* 空占位行的标识是灰的：它只说明「你在这条还没有内容的会话里」，
                                不是一个可以拿去认的对话名。 */}
                            <span className={cn('truncate', s.empty && 'text-ink-4')}>{listRowTitle(s, meta)}</span>
                            {s.running ? <span className='ml-auto h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary' data-loop-anim /> : null}
                          </button>
                        </m.li>
                      )
                    })}
                  </ul>
                ) : null}
              </div>
            )
          })}
          {!filtered.length ? (
            <Empty
              compact
              art={query ? 'search' : 'sessions'}
              className='animate-bar py-6'
              title={query ? '没有匹配的会话' : '还没有会话'}
              description={query ? '换个关键词试试。' : '点上面的「新会话」开始第一轮。'}
            />
          ) : null}
        </div>
        {/* 抽屉浮层自带拖拽手柄（8px 命中区 + 1px 视觉线，双击复位）。
            内嵌形态不在这里拖：那根分隔条是面板组的，画在主列与列表之间。 */}
        {drawer ? (
          <ResizeHandle
            side='right'
            width={drawerBox.width}
            min={drawerBox.min}
            max={drawerBox.max}
            onWidth={drawerBox.setWidth}
            defaultWidth={LIST_W}
            label='调整会话列表宽度'
            className='absolute bottom-0 right-0 top-0'
          />
        ) : null}
    </aside>
  )
}
