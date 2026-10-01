/**
 * 文件页签：当前会话工作目录的文件树。
 * - 目录懒加载（点开才请求 /api/fs/list），不递归预读整棵树
 * - 搜索走有界的目录遍历（最多 60 个目录 / 200 条结果），只读真实文件系统
 * - 点文件即在侧栏内预览（图片直出、文本走 /api/fs/raw）
 */
import { useEffect, useState } from 'react'
import { ChevronRight, Copy, Folder, FolderOpen, RefreshCw, Search, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { fmtBytes, prettyPath, shortPath } from '../../lib/format'
import { useEngine } from '../../stores/engine'
import { useSession } from '../../stores/session'
import { Button } from '../ui/Button'
import { FileBadge } from '../ui/FileBadge'
import { Input } from '../ui/Input'
import { Tip } from '../ui/Overlay'
import { Spinner } from '../ui/Controls'
import { DockSection } from './dockMetrics'
import {
  copyPath,
  listDirectory,
  revealPath,
  StateBlock,
  useDockPreview,
  type FsEntry,
} from './dockShared'

/** 搜索时跳过的重目录：这些目录动辄几万条，遍历它们只会把侧栏拖死。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', '.next', '.cache', '__pycache__', '.venv', 'venv'])
const SEARCH_MAX_DIRS = 60
const SEARCH_MAX_HITS = 200

interface SearchState {
  loading: boolean
  error: string
  matches: FsEntry[]
  scanned: number
  truncated: boolean
}

const EMPTY_SEARCH: SearchState = { loading: false, error: '', matches: [], scanned: 0, truncated: false }

async function searchTree(root: string, rawQuery: string): Promise<Omit<SearchState, 'loading' | 'error'>> {
  const needle = rawQuery.trim().toLowerCase()
  const matches: FsEntry[] = []
  const queue: string[] = [root]
  let scanned = 0
  let truncated = false
  while (queue.length) {
    if (scanned >= SEARCH_MAX_DIRS || matches.length >= SEARCH_MAX_HITS) { truncated = true; break }
    const dir = queue.shift() as string
    scanned += 1
    try {
      const { entries } = await listDirectory(dir)
      for (const entry of entries) {
        if (entry.name.toLowerCase().includes(needle)) matches.push(entry)
        if (entry.isDir && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) queue.push(entry.path)
      }
    } catch { /* 无权限的目录跳过，不让一次失败打断整次搜索 */ }
  }
  return { matches, scanned, truncated }
}

function FileRow({ entry, depth, active, onOpen }: { entry: FsEntry; depth: number; active: boolean; onOpen: () => void }) {
  return (
    <div
      className={cn('group/file flex min-h-7 min-w-0 items-center gap-1 rounded-md pr-1', active ? 'bg-selected' : 'hover:bg-hover')}
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <button type='button' onClick={onOpen} title={entry.path} className='flex min-w-0 flex-1 items-center gap-1.5 text-left'>
        {/* 文件行的图标 / 类别色 / 扩展名徽标走 ui/FileBadge（与产物页签、输入框附件同一份分类表）；
            目录仍然用 Folder 图标，不参与文件分类。 */}
        <FileBadge path={entry.path} size='sm' />
        <span className='min-w-0 flex-1 truncate text-12 text-ink-2' title={entry.name}>{entry.name}</span>
        <span className='shrink-0 whitespace-nowrap text-11 tabular-nums text-ink-4'>{fmtBytes(entry.size)}</span>
      </button>
      <Tip label='复制路径'>
        <Button variant='ghost' size='icon-sm' className='h-5 w-5 opacity-0 group-hover/file:opacity-100' onClick={() => void copyPath(entry.path)}>
          <Copy size={11} />
        </Button>
      </Tip>
      <Tip label='在文件夹中打开'>
        <Button variant='ghost' size='icon-sm' className='h-5 w-5 opacity-0 group-hover/file:opacity-100' onClick={() => void revealPath(entry.path)}>
          <FolderOpen size={11} />
        </Button>
      </Tip>
    </div>
  )
}

function DirEntries({ dir, depth, activePath, onOpen, token }: {
  dir: string
  depth: number
  activePath: string
  onOpen: (entry: FsEntry) => void
  token: number
}) {
  const [state, setState] = useState<{ loading: boolean; error: string; entries: FsEntry[] }>({ loading: true, error: '', entries: [] })

  useEffect(() => {
    let alive = true
    setState({ loading: true, error: '', entries: [] })
    void listDirectory(dir)
      .then((result) => { if (alive) setState({ loading: false, error: '', entries: result.entries }) })
      .catch((e) => { if (alive) setState({ loading: false, error: e instanceof Error ? e.message : String(e), entries: [] }) })
    return () => { alive = false }
  }, [dir, token])

  const pad = 8 + depth * 12
  if (state.loading) {
    return <div className='flex items-center gap-1.5 py-1 text-11 text-ink-4' style={{ paddingLeft: pad }}><Spinner /> 读取目录…</div>
  }
  if (state.error) {
    return <p className='min-w-0 break-all py-1 text-11 text-danger' style={{ paddingLeft: pad }}>{state.error}</p>
  }
  if (!state.entries.length) {
    return <p className='min-w-0 break-all py-1 text-11 text-ink-4' style={{ paddingLeft: pad }}>空目录</p>
  }
  return (
    <ul>
      {state.entries.map((entry) => (
        <li key={entry.path}>
          {entry.isDir
            ? <DirNode entry={entry} depth={depth} activePath={activePath} onOpen={onOpen} token={token} />
            : <FileRow entry={entry} depth={depth} active={activePath === entry.path} onOpen={() => onOpen(entry)} />}
        </li>
      ))}
    </ul>
  )
}

function DirNode({ entry, depth, activePath, onOpen, token }: {
  entry: FsEntry
  depth: number
  activePath: string
  onOpen: (entry: FsEntry) => void
  token: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        title={entry.path}
        className='flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-1.5 text-left text-12 text-ink-2 hover:bg-hover'
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <ChevronRight size={12} className={cn('shrink-0 text-ink-4 transition-transform duration-[var(--motion-fast)]', open && 'rotate-90')} />
        <Folder size={13} className='shrink-0 text-ink-4' />
        <span className='min-w-0 flex-1 truncate' title={entry.name}>{entry.name}</span>
      </button>
      {open ? <DirEntries dir={entry.path} depth={depth + 1} activePath={activePath} onOpen={onOpen} token={token} /> : null}
    </div>
  )
}

export function DockFilesTab({ refresh, onRefresh }: { refresh: number; onRefresh: () => void }) {
  const ready = useEngine((s) => s.ready)
  const engineCwd = useEngine((s) => s.cwd)
  const sessionId = useSession((s) => s.sessionId)
  const sessions = useSession((s) => s.sessions)
  const pendingCwd = useSession((s) => s.pendingCwd)
  const openPreview = useDockPreview((s) => s.open)
  const previewPath = useDockPreview((s) => s.path)

  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH)
  // 展开状态挂在树上，刷新时用 key 重挂载整棵树即可重新拉取已展开的分支。
  const [mountKey, setMountKey] = useState(0)

  const root = prettyPath(sessions.find((s) => s.id === sessionId)?.cwd || pendingCwd || engineCwd || '')

  useEffect(() => {
    const keyword = query.trim()
    if (!keyword || !root) { setSearch(EMPTY_SEARCH); return }
    let alive = true
    const timer = window.setTimeout(() => {
      setSearch((s) => ({ ...s, loading: true, error: '' }))
      void searchTree(root, keyword)
        .then((result) => { if (alive) setSearch({ loading: false, error: '', ...result }) })
        .catch((e) => { if (alive) setSearch({ loading: false, error: e instanceof Error ? e.message : String(e), matches: [], scanned: 0, truncated: false }) })
    }, 300)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [query, root, refresh])

  const reload = (): void => {
    setMountKey((v) => v + 1)
    onRefresh()
  }

  return (
    <div data-dock-tab='files' className='flex min-h-0 flex-1 flex-col'>
      <div className='flex items-center gap-1.5 px-2.5 pt-2.5'>
        <div className='relative min-w-0 flex-1'>
          <Search size={12} className='pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-4' />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='搜索文件名'
            className='h-7 rounded-md bg-muted pl-6 pr-6 text-12'
          />
          {query ? (
            <button
              type='button'
              onClick={() => setQuery('')}
              className='absolute right-1.5 top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center rounded text-ink-4 hover:bg-hover hover:text-ink-2'
              aria-label='清空搜索'
            >
              <X size={11} />
            </button>
          ) : null}
        </div>
        <Tip label='刷新'>
          <Button variant='ghost' size='icon-sm' className='h-7 w-7' onClick={reload}><RefreshCw size={13} /></Button>
        </Tip>
        <Tip label='在文件夹中打开工作目录'>
          <Button variant='ghost' size='icon-sm' className='h-7 w-7' disabled={!root} onClick={() => void revealPath(root ?? '')}>
            <FolderOpen size={13} />
          </Button>
        </Tip>
      </div>

      <p className='truncate px-3 pt-1.5 pb-1 text-11 text-ink-4' title={root}>
        {root ? shortPath(root, 46) : '未设置工作目录'}
      </p>

      <div className='min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-3'>
        {!ready ? (
          <StateBlock loading />
        ) : !root ? (
          <StateBlock empty emptyIcon={<Folder size={20} />} emptyTitle='没有工作目录' emptyDesc='在输入区选择工作目录后，这里会显示它的文件树。' />
        ) : query.trim() ? (
          <StateBlock
            loading={search.loading}
            error={search.error}
            empty={!search.loading && !search.matches.length}
            emptyArt='search'
            emptyTitle='没有匹配的文件'
            emptyDesc={'已扫描 ' + search.scanned + ' 个目录'}
          >
            <ul className='-mx-1'>
              {search.matches.map((entry) => (
                <li key={entry.path} className='mb-0.5'>
                  {entry.isDir ? (
                    <div className='flex min-h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-12 text-ink-2'>
                      <Folder size={13} className='shrink-0 text-ink-4' />
                      <span className='min-w-0 flex-1 truncate' title={entry.name}>{entry.name}</span>
                      <span className='shrink-0 text-11 tabular-nums text-ink-4'>目录</span>
                    </div>
                  ) : (
                    <FileRow entry={entry} depth={0} active={previewPath === entry.path} onOpen={() => void openPreview(entry.path)} />
                  )}
                  <p className='truncate px-1.5 pl-6 text-11 text-ink-4' title={entry.path}>{shortPath(entry.path, 40)}</p>
                </li>
              ))}
            </ul>
            {search.truncated ? <p className='px-1.5 pt-1.5 text-11 text-ink-4'>结果过多，已截断。缩小关键词可看到更多。</p> : null}
          </StateBlock>
        ) : (
          <DockSection>
            <div key={mountKey}>
              <DirEntries dir={root} depth={0} activePath={previewPath} onOpen={(entry) => void openPreview(entry.path)} token={refresh} />
            </div>
          </DockSection>
        )}
      </div>
    </div>
  )
}
