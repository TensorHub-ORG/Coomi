/**
 * 产物页签：列出本次会话产生的文件 / 图片，可就地预览、在文件夹中打开、复制路径。
 * 数据来源（都是真实数据，没有假条目）：
 * - 主数据源：GET /api/sessions/{id}/artifacts —— 引擎扫会话隔离工作区得到的真实文件，
 *   带 size / modified / kind；kind 决定预览方式与提示，图标与类别色统一交给 ui/FileBadge
 *   （按扩展名分类，与输入框附件、消息附件卡同一份表），不再逐个 /api/fs/stat 校验
 * - 补充线索：会话历史里写文件类工具调用（write_file / edit_file / apply_patch …）的 path 参数；
 *   按路径去重合并进主列表，清单里没有的条目只标「清单外」，不猜它是否还存在
 * 两路合并后按修改时间倒序排序（不知道时间的排在后面，再按文件名稳定排序）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, FileText, FolderOpen, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/cn'
import { fmtBytes, fmtTime, normPath, prettyPath } from '../../lib/format'
import { useEngine } from '../../stores/engine'
import type { ChatItem } from '../../lib/chat'
import { useSession } from '../../stores/session'
import { Button } from '../ui/Button'
import { FileBadge } from '../ui/FileBadge'
import { ContextMenu } from '../ui/Menu'
import { Tip } from '../ui/Overlay'
import { fetchSessionArtifacts, openArtifactPreview } from './dockApi'
import { useRichStore } from '../richtext/store'
import type { ArtifactKind, SessionArtifact } from './dockApi'
import { DockSection } from './dockMetrics'
import {
  basename,
  copyPath,
  IMAGE_EXT,
  isAbsolutePath,
  joinPath,
  revealPath,
  StateBlock,
  TEXT_EXT,
  useDockPreview,
} from './dockShared'

interface ArtifactItem {
  path: string
  name: string
  /** 清单条目是文件字节数；只有工具调用提到、清单里没有的条目为 null（大小未知）。 */
  size: number | null
  /** 毫秒时间戳；未知为 0。 */
  modified: number
  kind: ArtifactKind
  /** list：来自引擎产物清单（真实文件）；tool：只在工具调用参数里出现过（线索）。 */
  source: 'list' | 'tool'
  /** source === 'tool' 时有值：出现该路径的工具名。 */
  tool: string
}

/** 会产出文件的内置工具：只有这些工具调用的 path 参数才算产物线索。 */
const ARTIFACT_TOOLS = /^(write_file|edit_file|apply_patch|create_file|save_file|move_file|copy_file|write|edit)$/i

/** 工具线索没有引擎给的 kind，只能按扩展名粗分；只用于挑图标与预览方式。 */
function kindOfPath(path: string): ArtifactKind {
  if (IMAGE_EXT.test(path)) return 'image'
  if (TEXT_EXT.test(path)) return 'text'
  return 'other'
}

function collectToolPaths(messages: ChatItem[], cwd: string): Array<{ path: string; tool: string }> {
  const found = new Map<string, { path: string; tool: string }>()
  for (const item of messages) {
    if (item.kind !== 'assistant') continue
    for (const call of item.tools) {
      const tool = String(call.name ?? '')
      if (!ARTIFACT_TOOLS.test(tool)) continue
      // 工具参数是 JSON 文本（见 lib/chat.ts 的 argsText），这里解析出来取路径字段。
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(call.args || '{}') } catch { /* 参数解析失败就跳过 */ }
      const raw = [args.path, args.file_path, args.target, args.destination, args.filename]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      if (!raw) continue
      const value = raw.trim()
      const absolute = isAbsolutePath(value) ? value : joinPath(cwd, value)
      const key = normPath(absolute)
      if (!found.has(key)) found.set(key, { path: absolute, tool })
    }
  }
  return [...found.values()]
}

/** 合并两路数据：清单优先（真实 size/kind），工具线索只补清单里没有的路径，最后统一排序。 */
function mergeArtifacts(listed: SessionArtifact[], clues: Array<{ path: string; tool: string }>): ArtifactItem[] {
  const merged = new Map<string, ArtifactItem>()
  for (const entry of listed) {
    const key = normPath(entry.path)
    if (!key) continue
    merged.set(key, {
      path: entry.path,
      name: entry.name || basename(entry.path),
      size: entry.size,
      modified: entry.modified,
      kind: entry.kind,
      source: 'list',
      tool: '',
    })
  }
  for (const clue of clues) {
    const key = normPath(clue.path)
    if (!key || merged.has(key)) continue
    merged.set(key, {
      path: clue.path,
      name: basename(clue.path),
      size: null,
      modified: 0,
      kind: kindOfPath(clue.path),
      source: 'tool',
      tool: clue.tool,
    })
  }
  return [...merged.values()].sort((a, b) => {
    if (a.modified !== b.modified) return b.modified - a.modified
    return a.name.localeCompare(b.name)
  })
}

function ArtifactRow({ item, active, onOpen }: { item: ArtifactItem; active: boolean; onOpen: () => void }) {
  const listed = item.source === 'list'
  const meta = listed
    ? fmtBytes(item.size ?? 0) + (item.modified ? ' · ' + fmtTime(item.modified) : '')
    : '清单外'
  const title = listed
    ? '引擎产物清单 · ' + item.kind + ' · ' + item.path
    : (item.tool || '工具调用') + ' 的参数里出现过，但不在引擎产物清单中（可能不在会话工作区、已删除或超出扫描上限）：' + item.path
  return (
    <ContextMenu
      trigger={
        <div className={cn('group/art flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1.5', active ? 'bg-selected' : 'hover:bg-hover')}>
          <button type='button' onClick={onOpen} title={title} className='flex min-w-0 flex-1 items-center gap-1.5 text-left'>
            {/* 图标 / 类别色 / 扩展名徽标统一由 FileBadge 出（与输入框附件、消息附件卡同一份表）：
                item.kind 现在只用来决定预览方式与提示文案，不再各画一套图标。 */}
            <FileBadge path={item.path} size='sm' />
            <span className={cn('min-w-0 flex-1 truncate text-12', listed ? 'text-ink-2' : 'text-ink-3')} title={item.name}>{item.name}</span>
            <span className='shrink-0 whitespace-nowrap text-11 tabular-nums text-ink-4'>{meta}</span>
          </button>
          <Tip label='复制路径'>
            <Button variant='ghost' size='icon-sm' className='h-6 w-6 opacity-0 group-hover/art:opacity-100' onClick={() => void copyPath(item.path)}>
              <Copy size={12} />
            </Button>
          </Tip>
          <Tip label='在文件夹中打开'>
            <Button variant='ghost' size='icon-sm' className='h-6 w-6 opacity-0 group-hover/art:opacity-100' onClick={() => void revealPath(item.path)}>
              <FolderOpen size={12} />
            </Button>
          </Tip>
        </div>
      }
      items={[
        { label: '预览', icon: <FileText size={14} />, onSelect: onOpen },
        { label: '在文件夹中打开', icon: <FolderOpen size={14} />, onSelect: () => void revealPath(item.path) },
        { label: '复制路径', icon: <Copy size={14} />, onSelect: () => void copyPath(item.path) },
      ]}
    />
  )
}

export function DockArtifactsTab({ refresh, onRefresh }: { refresh: number; onRefresh: () => void }) {
  const ready = useEngine((s) => s.ready)
  const engineCwd = useEngine((s) => s.cwd)
  const messages = useSession((s) => s.messages)
  const sessionId = useSession((s) => s.sessionId)
  const sessions = useSession((s) => s.sessions)
  const pendingCwd = useSession((s) => s.pendingCwd)
  const previewPath = useDockPreview((s) => s.path)
  // 「预览」页签里「存为产物」成功一次，这里的清单就重取一次：两个页签由这个计数打通。
  const artifactTick = useRichStore((s) => s.artifactTick)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [root, setRoot] = useState('')
  const [capped, setCapped] = useState(false)
  const [listed, setListed] = useState<SessionArtifact[]>([])
  /** 上一份清单属于哪个会话：切会话时先清空，避免旧会话的文件在新会话里露一下脸。 */
  const listedSession = useRef('')

  const cwd = prettyPath(sessions.find((s) => s.id === sessionId)?.cwd || pendingCwd || engineCwd || '')

  useEffect(() => {
    if (!ready || !sessionId) {
      setListed([])
      setRoot('')
      setCapped(false)
      setError('')
      listedSession.current = ''
      return
    }
    let alive = true
    const switching = listedSession.current !== sessionId
    listedSession.current = sessionId
    setBusy(true)
    setError('')
    if (switching) { setListed([]); setRoot(''); setCapped(false) }
    void (async () => {
      try {
        const data = await fetchSessionArtifacts(sessionId)
        if (!alive) return
        setListed(data.artifacts)
        setRoot(data.root)
        setCapped(data.capped)
      } catch (e) {
        // 清单拿不到时如实说明，只保留工具调用线索，不伪造文件与大小。
        if (!alive) return
        setListed([])
        setRoot('')
        setCapped(false)
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [ready, sessionId, refresh, artifactTick])

  const clues = useMemo(() => collectToolPaths(messages, cwd), [messages, cwd])
  const items = useMemo(() => mergeArtifacts(listed, clues), [listed, clues])

  const refreshButton = (
    <Tip label='刷新'>
      <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={onRefresh}><RefreshCw size={12} /></Button>
    </Tip>
  )

  if (!sessionId) {
    // 空态也要挂 data-dock-tab：巡检脚本按它认「当前页签内容根节点」，缺了就等于这一档没被扫过。
    return (
      <div data-dock-tab='artifacts' className='flex min-h-0 flex-1 flex-col p-2.5'>
        <DockSection>
          <StateBlock empty emptyArt='artifacts' emptyTitle='还没有打开的会话' emptyDesc='打开一个会话后，它产出的文件会出现在这里。' />
        </DockSection>
      </div>
    )
  }

  return (
    <div data-dock-tab='artifacts' className='flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overflow-x-hidden p-2.5'>
      <DockSection
        title='本次会话产出'
        hint={root ? '引擎产物清单 · ' + root : cwd ? '工作目录 ' + cwd : '未设置工作目录，只按工具调用的绝对路径统计'}
        actions={refreshButton}
      >
        {error ? (
          <div className='mb-1.5 min-w-0 rounded-md border border-warn/40 bg-warn-soft px-2.5 py-2 text-11 leading-[1.5] text-warn'>
            <p className='break-all'>引擎产物清单不可用：{error}</p>
            <p className='mt-0.5'>
              {items.length ? '下面是工具调用参数里出现过的路径，没有大小与类型信息。' : '这个会话也没有在工具调用参数里出现过产出路径。'}
            </p>
            <button type='button' className='mt-1 underline underline-offset-2' onClick={onRefresh}>重试</button>
          </div>
        ) : null}
        {/* 错误态用上面的提示条表达（仍要展示工具线索），所以 StateBlock 只管加载 / 空两态。 */}
        <StateBlock
          loading={busy && !items.length}
          empty={!busy && !error && !items.length}
          emptyArt='artifacts'
          emptyTitle='还没有写入过文件'
          emptyDesc='等 Agent 用写文件类工具产出内容后，这里会逐条列出来。'
        >
          <ul className='-mx-1'>
            {items.map((item) => (
              <li key={item.path} className='mb-0.5'>
                <ArtifactRow item={item} active={previewPath === item.path} onOpen={() => void openArtifactPreview(item)} />
              </li>
            ))}
          </ul>
          {capped ? <p className='px-1 pt-1 text-11 text-ink-4'>引擎扫描上限 500 个文件，清单可能不全。</p> : null}
          {items.some((item) => item.source === 'tool') ? (
            <p className='px-1 pt-1 text-11 text-ink-4'>标「清单外」的条目只在工具调用参数里出现过，引擎产物清单里没有它们。</p>
          ) : null}
        </StateBlock>
        <p className='mt-1.5 text-11 leading-[1.5] text-ink-4'>
          {'文件与大小来自 GET /api/sessions/{id}/artifacts（真实磁盘状态），工具调用参数只用来补充清单外的路径，已按路径去重合并。'}
        </p>
      </DockSection>
    </div>
  )
}
