import { useEffect, useMemo, useState } from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import { cn } from '../lib/cn'
import { fmtBytes, prettyPath } from '../lib/format'
import { useEngine } from '../stores/engine'
import { useSession } from '../stores/session'
import { useLibrary } from '../stores/library'
import { groupSessions, sessionTitle, useWorkspace } from '../stores/workspace'
import { useUi } from '../stores/ui'
import { PageHeader, Empty } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { FileBadge } from '../components/ui/FileBadge'
import { Segmented, SkeletonRows } from '../components/ui/Controls'

/** 文件类型筛选：只影响当前这一屏的显示，不改数据流的取数逻辑。 */
type TypeFilter = 'all' | 'dir' | 'file'

const FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'dir', label: '目录' },
  { value: 'file', label: '文件' },
]

/** 列表错峰入场：每行只加一点延迟，超过 10 行就不再往后排（否则最后一行要等半秒）。 */
const stagger = (i: number): React.CSSProperties => ({
  animationDelay: Math.min(i, 10) * 24 + 'ms',
})

/* ⚠ 这里原本给「≥60 行的长列表」挂了 content-visibility:auto（离屏条目不布局不绘制）。
   **与对话消息行同一个坑，一起撤掉**：Chromium 会把**就在视口里**的行判成「与用户无关」
   而跳过绘制，行还在 DOM、高度也正常，就是屏幕上没有（真机取证见 styles/base.css 那段注释
   与 tests/check-msg-visibility.mjs）。列表本来就有分页/过滤，这点开销不值得拿「条目可能不显示」换。 */
const CV_MIN_ROWS = Number.POSITIVE_INFINITY
/** 保留常量名以免调用处散落条件；值恒为空对象＝不做任何渲染隔离。 */
const CV_ROW: React.CSSProperties = {}

export function ArtifactsView() {
  const engineCwd = useEngine((s) => s.cwd)
  const ready = useEngine((s) => s.ready)
  const sessions = useSession((s) => s.sessions)
  const sessionId = useSession((s) => s.sessionId)
  const openSession = useSession((s) => s.openSession)
  const meta = useWorkspace((s) => s.meta)
  const files = useLibrary((s) => s.files)
  const currentPath = useLibrary((s) => s.currentPath)
  const listDir = useLibrary((s) => s.listDir)
  const togglePanel = useUi((s) => s.togglePanel)
  const [filter, setFilter] = useState<TypeFilter>('all')

  useEffect(() => {
    if (ready && !currentPath) void listDir(engineCwd || '/')
  }, [ready, currentPath, engineCwd, listDir])

  const groups = useMemo(() => groupSessions(sessions, engineCwd, meta), [sessions, engineCwd, meta])

  // 面包屑：去掉盘符（C:）这类噪声，只留最后三段目录名。
  const crumbs = prettyPath(currentPath)
    .split(/[\\/]/)
    .filter((p) => p && !/^[a-zA-Z]:$/.test(p))
    .slice(-3)

  const shown = useMemo(
    () => (filter === 'all' ? files : files.filter((f) => f.type === filter)),
    [files, filter],
  )

  /// 条目够多才上离屏隔离（见 CV_ROW）：短目录不需要，长目录才真的省。
  const longList = shown.length >= CV_MIN_ROWS

  const openEntry = (f: (typeof files)[number]): void => {
    if (f.type === 'dir') void listDir(f.path)
    else { togglePanel(true); void useLibrary.getState().readFile(f.path) }
  }

  return (
    <main className='flex min-h-0 flex-1 flex-col bg-canvas'>
      <PageHeader
        title='产物中心'
        description='每个会话的工作目录与产出文件，选中即在右侧预览。'
        actions={<Button variant='ghost' size='md' onClick={() => void listDir(currentPath || engineCwd || '/')}>刷新</Button>}
      />
      <div className='flex min-h-0 flex-1 gap-4 px-8 pb-6'>
        <aside className='w-[248px] shrink-0 overflow-y-auto rounded-lg border border-line bg-surface p-2 elev-1'>
          <p className='px-2 py-1 text-11 font-medium text-ink-4'>会话</p>
          {groups.map((g) => (
            <div key={g.key} className='mb-1'>
              <p className='flex items-center gap-1.5 px-2 py-1 text-11 text-ink-3'>
                <Folder size={12} /> <span className='truncate'>{g.label}</span>
              </p>
              {g.sessions.map((s) => {
                const on = s.id === sessionId
                return (
                  <button
                    key={s.id}
                    type='button'
                    aria-current={on || undefined}
                    onClick={() => { void openSession(s.id); void listDir(s.cwd || engineCwd || '/') }}
                    className={cn(
                      'relative flex h-7 w-full items-center rounded-xs px-2 pl-5 text-left text-12',
                      // 只动 transform/opacity：选中用左侧强调条滑入 + 底色变化，不做位移抖动
                      'transition-[background-color,color,transform] duration-[var(--motion-fast)] ease-[var(--ease-enter)]',
                      on ? 'bg-selected text-ink' : 'text-ink-2 hover:translate-x-[1px] hover:bg-hover',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'absolute left-0.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary',
                        'transition-[opacity,transform] duration-[var(--motion-fast)] ease-[var(--ease-enter)]',
                        on ? 'opacity-100 scale-y-100' : 'scale-y-0 opacity-0',
                      )}
                    />
                    <span className='truncate'>{sessionTitle(s, meta)}</span>
                  </button>
                )
              })}
            </div>
          ))}
          {!groups.length ? <Empty compact art='sessions' className='py-4' title='还没有会话' /> : null}
        </aside>

        <section className='flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface elev-1'>
          <header className='flex h-10 shrink-0 items-center gap-1.5 border-b border-line-soft px-3 text-12 text-ink-3'>
            <button
              type='button'
              className='rounded-xs px-1.5 py-0.5 transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-ink'
              onClick={() => void listDir(engineCwd || '/')}
            >
              根目录
            </button>
            {crumbs.map((c, i) => (
              <span key={c + i} className='flex min-w-0 items-center gap-1.5'>
                <span className='text-ink-4'>/</span>
                <span className='truncate'>{c}</span>
              </span>
            ))}
            <div className='flex-1' />
            {/* 类型筛选：滑块指示器 + 计数，切换时列表错峰淡入 */}
            <span className='mr-1 shrink-0 text-11 tabular-nums text-ink-4'>
              {filter === 'all' ? files.length : shown.length}/{files.length}
            </span>
            <Segmented<TypeFilter> value={filter} options={FILTERS} onChange={setFilter} ariaLabel='文件类型筛选' className='shrink-0' />
            <Button variant='ghost' size='sm' className='ml-1' onClick={() => togglePanel(true)}>在右侧预览</Button>
          </header>
          <div className='min-h-0 flex-1 overflow-y-auto p-2'>
            {/* key 挂在列表容器上：筛选切换时只重放容器的入场动画，
                数据与滚动位置不受影响（列表本身没有需要保住的状态）。 */}
            <div key={filter} className='flex flex-col'>
              {shown.map((f, i) => (
                <button
                  key={f.path}
                  type='button'
                  style={longList ? { ...stagger(i), ...CV_ROW } : stagger(i)}
                  onClick={() => openEntry(f)}
                  className='flex h-8 w-full animate-card-in items-center gap-2 rounded-xs px-2 text-left text-13 text-ink-2 transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-ink'
                >
                  {/* 文件的图标 / 类别色 / 扩展名徽标一律由 ui/FileBadge 出（与输入框附件、
                      消息附件卡、右侧栏文件树同一份分类表）；目录不参与文件分类，仍用 Folder。 */}
                  {f.type === 'dir'
                    ? <FolderOpen size={16} className='shrink-0 text-ink-4' />
                    : <FileBadge path={f.path} size='md' />}
                  <span className='min-w-0 flex-1 truncate'>{f.name}</span>
                  {f.type === 'file'
                    ? <span className='shrink-0 font-mono text-11 tabular-nums text-ink-4'>{fmtBytes(f.size)}</span>
                    : null}
                </button>
              ))}
            </div>
            {/* 加载态统一成骨架屏，不再出现「引擎启动中…」这种一行字 */}
            {!ready ? <SkeletonRows rows={6} className='px-0' /> : null}
            {ready && !files.length ? (
              <Empty className='animate-card-in' art='artifacts' title='这个目录还是空的' description='让 Agent 干活之后，产物会出现在这里。' />
            ) : null}
            {ready && !!files.length && !shown.length ? (
              <Empty
                className='animate-card-in'
                compact
                art='search'
                title={filter === 'dir' ? '这一层没有子目录' : '这一层没有文件'}
                description='切回「全部」可以同时看目录和文件。'
                action={<Button variant='secondary' size='sm' onClick={() => setFilter('all')}>看全部</Button>}
              />
            ) : null}
          </div>
        </section>
      </div>
      <div className='px-8 pb-2 font-mono text-11 text-ink-4'>{currentPath}</div>
    </main>
  )
}
