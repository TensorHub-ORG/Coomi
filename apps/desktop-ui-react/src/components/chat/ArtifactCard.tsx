/**
 * 生成物卡片：这一轮产出的文件，挂在**最后一条有正文的回复**下面。
 *
 * 数据来自 turn_end 事件的 artifacts 字段（见 stores/artifacts.ts 的解析层）：
 * 引擎这一轮产出什么，卡片就显示什么；没有产出时调用方整块不渲染 —— 一个占位都不留。
 *
 * 一张卡显示四样东西：图标（按扩展名，与输入框附件 / 产物页签同一份表）、文件名、
 * 扩展名徽标、大小与时间。四个动作：
 *  · 左键 → 在右侧「预览」页签里打开（图片直接渲染，文本 / 代码读原文）；
 *  · 右键 → 在文件夹中打开 / 复制路径 / 另存为 / 存为产物。
 * 「另存为」会弹系统对话框，受能力开关 allowSaveAsRequest 控制（默认关，见下文注释）。
 */
import { useState } from 'react'
import { Copy, FileText, FolderOpen, Save } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../lib/cn'
import { fmtBytes, fmtTime, shortPath } from '../../lib/format'
import { useEngine } from '../../stores/engine'
import { useSession } from '../../stores/session'
import { showContextMenu, type CtxItem } from '../../stores/contextMenu'
import { useCapabilities } from '../../stores/capabilities'
import { dedupeArtifacts, artifactExt, type TurnArtifact } from '../../stores/artifacts'
import { openArtifactPreview } from '../shell/dockApi'
import { copyPath, openDockTab, revealPath } from '../shell/dockShared'
import { useRichStore } from '../richtext/store'
import { FileBadge } from '../ui/FileBadge'
import { Tip } from '../ui/Overlay'
import { saveArtifactAs, describeSaveError } from '../../lib/saveAs'

/** 存为产物：把文件复制进当前会话的工作目录（引擎的 /api/fs/copy 直接落盘，不弹对话框）。 */
export async function saveArtifactToSession(item: TurnArtifact): Promise<void> {
  const session = useSession.getState()
  const cwd = (session.sessions.find((x) => x.id === session.sessionId)?.cwd
    || session.pendingCwd
    || useEngine.getState().cwd
    || '').trim()
  if (!cwd) {
    toast.error('还没有工作目录：先打开一个会话或选一个目录，产物才有地方落盘')
    return
  }
  const target = await uniquePath(cwd.replace(/[\\/]+$/, '') + '/' + (item.name || 'artifact'))
  try {
    await useEngine.getState().api('/api/fs/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: item.path, to: target }),
    })
  } catch (error) {
    toast.error('存为产物失败：' + describeSaveError(error))
    return
  }
  // 产物页签靠这个计数重取清单：存完切过去就能看见刚存下的文件。
  useRichStore.getState().bumpArtifacts(target)
  toast.success('已存为产物：' + shortPath(target, 60))
}

/** 目标路径被占了就加 -2 / -3 后缀：存产物应该是「存下来」，不该因为重名就失败。 */
async function uniquePath(path: string): Promise<string> {
  const dot = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const head = dot > slash ? path.slice(0, dot) : path
  const tail = dot > slash ? path.slice(dot) : ''
  const engine = useEngine.getState()
  for (let n = 1; n <= 20; n += 1) {
    const candidate = n === 1 ? path : head + '-' + n + tail
    try {
      // 引擎的 /api/fs/stat 在路径不存在时直接 404：那正是「这个位置空着」的答案。
      // 接口不存在或请求失败也当作空位：存产物宁可直接写（覆盖），也不要因为探测失败而中止。
      const stat = await engine.api<{ is_file?: boolean; is_dir?: boolean }>('/api/fs/stat?path=' + encodeURIComponent(candidate))
      if (!stat?.is_file && !stat?.is_dir) return candidate
    } catch {
      return candidate
    }
  }
  return path
}

export function ArtifactCard({ item, className }: { item: TurnArtifact; className?: string }) {
  const [busy, setBusy] = useState(false)
  // 订阅开关（不是 getState 读一次）：用户刚在设置里把「允许另存为」打开，
  // 卡片上的入口应该跟着出现，而不是等下一次消息重渲染才冒出来。
  const saveAsOn = useCapabilities((s) => s.caps.allowSaveAsRequest)
  const ext = artifactExt(item.name)
  // 大小 / 时间两样都可能缺：缺了就少显示一段，不留空档。
  const metaParts: string[] = []
  if (item.size > 0) metaParts.push(fmtBytes(item.size))
  else metaParts.push('大小未知')
  if (item.modified > 0) metaParts.push(fmtTime(item.modified))
  const meta = metaParts.join(' · ')

  const open = (): void => {
    openDockTab('preview')
    void openArtifactPreview({ path: item.path, kind: item.kind })
  }

  const saveAs = (): void => {
    setBusy(true)
    void saveArtifactAs(item).finally(() => setBusy(false))
  }

  const menu = (): CtxItem[] => [
    { label: '预览', icon: <FileText size={14} />, onSelect: open },
    { label: '在文件夹中打开', icon: <FolderOpen size={14} />, onSelect: () => void revealPath(item.path) },
    { label: '复制路径', icon: <Copy size={14} />, onSelect: () => void copyPath(item.path) },
    { divider: true },
    // 默认关：弹系统保存对话框是一次会打断用户的操作，得先由用户在设置里点头。
    {
      label: '另存为…',
      icon: <Save size={14} />,
      disabled: busy || !saveAsOn,
      onSelect: saveAs,
    },
    { label: '存为产物', icon: <FileText size={14} />, onSelect: () => void saveArtifactToSession(item) },
  ]

  return (
    <div
      role='button'
      tabIndex={0}
      title={item.path}
      data-artifact-card={item.path}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, menu()) }}
      className={cn(
        'group/artifact flex w-[188px] max-w-full min-w-0 cursor-default items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-left transition-colors duration-[var(--motion-hover)] ease-[var(--ease-spring)] hover:bg-hover',
        className,
      )}
    >
      <FileBadge path={item.path} size='sm' />
      <span className='min-w-0 flex-1'>
        <span className='block truncate text-12 text-ink-2' title={item.name}>{item.name}</span>
        <span className='block truncate text-11 tabular-nums text-ink-4'>
          {ext ? <span className='mr-1 uppercase'>{ext}</span> : null}
          {meta}
        </span>
      </span>
      {/* 悬停才露出的「另存为」：卡片本身左键是预览，另存是次要动作，不抢主位。 */}
      {saveAsOn ? (
        <Tip label='另存为…'>
          <button
            type='button'
            aria-label='另存为'
            onClick={(e) => { e.stopPropagation(); saveAs() }}
            disabled={busy}
            className='shrink-0 rounded p-0.5 text-ink-4 opacity-0 transition-opacity duration-[var(--motion-hover)] ease-[var(--ease-spring)] group-hover/artifact:opacity-100 hover:text-ink-2 disabled:opacity-40'
          >
            <Save size={12} />
          </button>
        </Tip>
      ) : null}
    </div>
  )
}

/** 本轮产出一整排：同一路径去重后按引擎给的顺序排（一行排不下就换行，不横向滚动）。
 *  **没有任何产出时返回 null** —— 不画空态、不占位：一轮没产出，消息下方与以前一模一样。 */
export function ArtifactList({ items, className }: { items: readonly TurnArtifact[]; className?: string }) {
  const shown = dedupeArtifacts(items)
  if (!shown.length) return null
  return (
    <div data-artifact-list className={cn('mt-2 flex flex-wrap gap-1.5', className)}>
      {shown.map((item) => <ArtifactCard key={item.path} item={item} />)}
    </div>
  )
}
