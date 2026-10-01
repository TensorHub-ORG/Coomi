/**
 * 路径芯片（FileChip）：正文里认出来的文件路径渲染成的可点击小胶囊。
 *
 *   [类型图标] [扩展名徽标] 文件名
 *
 * 交互口径（都写在下面这一个组件里，别处不再各写一套）：
 *   · 悬停 —— 原生 title 显示完整路径 + 是否存在（存在时带大小）；状态来自 /api/fs/stat 的轻校验缓存；
 *   · 左键 —— 在软件内预览（右侧栏「预览」页签就地打开，不弹系统程序）；
 *   · 右键 —— 在文件夹中打开 / 复制路径 / 用系统默认程序打开 / 另存为 / 存为产物；
 *   · 流式期间 —— 一律不可点。正文在流式期间本来就是纯文本（见 Markdown.tsx），
 *     这里再用一层 context 兜底：万一将来流式也走解析，芯片至少不会在路径还没写完时被点。
 *   · 文件不存在 / 解析不出绝对路径 —— 画删除线，右键菜单只留「复制路径」。
 *
 * 校验只在**芯片进入视口附近**时才发（useInView + 状态缓存），
 * 所以一条列了 50 个路径的长回答不会在渲染那一刻打出 50 个请求。
 */
import { createContext, useContext, useEffect, useMemo } from 'react'
import { Copy, ExternalLink, FolderOpen, PackagePlus, Save } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../lib/cn'
import { ipc } from '../../lib/ipc'
import { useEngine } from '../../stores/engine'
import { ContextMenu, type MenuEntry } from '../ui/Menu'
import { FileBadge } from '../ui/FileBadge'
import { useInView } from '../richtext/preview/common'
import { filePathFromHref } from '../richtext/fileLink'
import { resolvePath } from '../richtext/filePath'
import { sessionCwd } from '../richtext/actions'
import { saveArtifactAs } from '../../lib/saveAs'
import {
  copyFileAsArtifact, copyFilePath, NO_CWD_NOTE, openFileWithSystem,
  revealFile, statSummary, useFilePeek, useFileStatStore,
} from '../richtext/fileStore'

/** 芯片是否可交互：Markdown.tsx 按「这轮是否还在流式」提供，缺省是不给点（保守）。 */
const ChipEnabledCtx = createContext(false)

export function FileChipEnabled({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return <ChipEnabledCtx.Provider value={enabled}>{children}</ChipEnabledCtx.Provider>
}

export function FileChip({ raw, className }: { raw: string; className?: string }) {
  const enabled = useContext(ChipEnabledCtx)
  const { ref, inView } = useInView<HTMLButtonElement>('200px')

  // 解析成绝对路径：正文里的相对路径按**当前会话工作目录**展开（~/ 用引擎给的 home）。
  const path = useMemo(() => resolvePath(raw, sessionCwd(), useEngine.getState().home), [raw])
  const entry = useFileStatStore((s) => (path ? s.stats[path] : undefined))

  useEffect(() => {
    if (!enabled || !inView || !path) return
    useFileStatStore.getState().ensure(path)
  }, [enabled, inView, path])

  const unresolved = !path
  const missing = unresolved || entry?.state === 'missing'
  const name = useMemo(() => {
    const parts = String(path || raw).split(/[\\/]/)
    return parts[parts.length - 1] || raw
  }, [path, raw])

  const shown = path || raw
  const title = [
    shown,
    unresolved ? '路径未解析：当前没有会话工作目录' : statSummary(entry),
    missing ? '（文件不存在，只能复制路径）' : '左键：在本软件内预览 · 右键：更多操作',
  ].join('\n')

  const copyOnly = (): void => { void copyFilePath(shown) }

  const run = (task: () => Promise<void>): void => {
    void task().catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
  }

  const openPreview = (): void => {
    if (unresolved) { toast.message(NO_CWD_NOTE); return }
    if (missing) { copyOnly(); return }
    useFilePeek.getState().open(path)
  }

  // 另存为走全应用同一条路（lib/saveAs）：弹壳的原生保存对话框，
  // 取消 / 失败 / 壳未就绪都由它翻成一句人话，这里不再另写一套文案。
  const saveAs = (): void => { void saveArtifactAs({ path, name }) }

  const asArtifact = (): void => {
    void copyFileAsArtifact(path).then(
      (target) => toast.success('已存为产物：' + target),
      (error) => toast.error(error instanceof Error ? error.message : String(error)),
    )
  }

  const items: MenuEntry[] = missing
    ? [{ label: '复制路径', icon: <Copy size={13} />, onSelect: copyOnly }]
    : [
        { label: '在文件夹中打开', icon: <FolderOpen size={13} />, onSelect: () => run(() => revealFile(path)) },
        { label: '复制路径', icon: <Copy size={13} />, onSelect: copyOnly },
        { label: '用系统默认程序打开', icon: <ExternalLink size={13} />, onSelect: () => run(() => openFileWithSystem(path)) },
        { divider: true },
        { label: '另存为…', icon: <Save size={13} />, onSelect: saveAs },
        { label: '存为产物', icon: <PackagePlus size={13} />, onSelect: asArtifact },
      ]

  const body = (
    <>
      <FileBadge path={raw} size='sm' />
      <span className={cn('min-w-0 truncate font-mono', missing && 'line-through')}>{name}</span>
    </>
  )

  const shape = cn(
    'inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-line bg-control-2/60 px-1.5 py-0 align-baseline text-12',
    missing ? 'text-ink-4' : 'text-ink',
    enabled
      ? 'cursor-pointer transition-colors duration-[var(--motion-fast)] hover:border-line-strong hover:bg-hover'
      : 'cursor-default opacity-70',
    className,
  )

  if (!enabled) {
    // 流式期间（或脱离 Markdown 上下文时的缺省值）：只画样子，不给任何交互。
    return <span className={shape} title={shown}>{body}</span>
  }

  return (
    <ContextMenu
      trigger={(
        <button ref={ref} type='button' className={shape} title={title} onClick={openPreview}>
          {body}
        </button>
      )}
      items={items}
    />
  )
}

/**
 * Markdown 的 `a` 覆盖：`coomi-file:` 前缀的链接换成芯片，其余链接保持原来的行为
 * （交给系统浏览器打开）。markdownComponents.tsx 里的那张共用表不认识这个前缀，
 * 所以覆盖表由 Markdown.tsx 组合出来，而不是去改那张共用表。
 */
export function FileLinkAnchor({ href, children }: { href?: unknown; children?: React.ReactNode }) {
  const raw = filePathFromHref(href)
  if (!raw) {
    return (
      <a
        href={typeof href === 'string' ? href : undefined}
        className='text-primary underline-offset-2 hover:underline'
        onClick={(e) => { e.preventDefault(); if (href) void ipc('open_external', { url: String(href) }).catch(() => {}) }}
      >
        {children}
      </a>
    )
  }
  return <FileChip raw={raw} />
}
