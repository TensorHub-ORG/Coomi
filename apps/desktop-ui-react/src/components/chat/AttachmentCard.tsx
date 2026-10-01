/** 附件卡片：已发送消息里的附件长这样（徽标 + 文件名 + 大小）。
 *
 *  三个对外入口：
 *    · <AttachmentCard path='/a/b.xlsx' size={12345} />  —— 渲染
 *    · parseLegacyAttachments(text)                      —— 旧消息正文里的 `附件：<路径>` 升级
 *    · openAttachment(path) / canPreview(path)           —— 打开策略（可被 onOpen 覆盖）
 *
 *  打开策略：能内联预览的（图片 / 文本 / 代码 / 数据）交给右侧「预览」页签，
 *  其余（音视频、压缩包、PDF…）交给系统默认程序打开——这两条都用现成的壳能力，
 *  不在这里自己读文件。 */
import { ExternalLink } from 'lucide-react'
import { cn } from '../../lib/cn'
import { fmtBytes } from '../../lib/format'
import { FileBadge, fileName, type FileBadgeSize } from '../ui/FileBadge'
import { Tip } from '../ui/Overlay'
import { openDockTab, revealPath, useDockPreview } from '../shell/dockShared'

/** 一条附件：path 必需，name / size 由发送方补（引擎回读时可能只有路径）。 */
export interface AttachmentRef {
  path: string
  name?: string
  size?: number
}

/** 附件显示名：没有显式 name 时取路径最后一段。 */
export function attachmentName(attachment: AttachmentRef | string): string {
  if (typeof attachment === 'string') return fileName(attachment)
  return attachment.name || fileName(attachment.path)
}

/** 能内联预览的扩展名（与右侧预览页签支持的范围一致：图片直接渲染，文本走原文）。 */
const PREVIEW_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?|md|markdown|txt|log|json|jsonc|ya?ml|toml|ini|cfg|conf|env|ts|tsx|js|jsx|mjs|cjs|css|scss|less|html?|xml|py|rs|go|java|kt|kts|c|h|cc|cpp|hpp|cs|swift|rb|php|sh|bash|zsh|ps1|bat|cmd|sql|csv|tsv|vue|svelte|patch|diff)$/i

/** 这个路径能不能在应用内预览（否则只能交给系统打开）。 */
export function canPreview(path: string): boolean {
  return PREVIEW_EXT.test(String(path ?? ''))
}

/** 点附件卡片的默认动作。 */
export async function openAttachment(path: string): Promise<void> {
  if (!path) return
  if (canPreview(path)) {
    openDockTab('preview')
    await useDockPreview.getState().open(path)
    return
  }
  await revealPath(path)
}

/** 旧消息里的 `附件：<路径>` 行（发送时曾经拼进正文，现在改走结构化字段）。
 *  只认**结尾连续**的若干行——正文中间出现「附件：」是用户自己写的，不动它。 */
const LEGACY_ATTACH_LINE = /^附件[:：]\s*(.+)$/

/** 把旧消息正文拆成「正文 + 附件」。没有旧式附件行时原样返回，一个字都不改。 */
export function parseLegacyAttachments(text: string): { body: string; attachments: AttachmentRef[] } {
  const lines = String(text ?? '').split(/\r?\n/)
  let end = lines.length
  const found: string[] = []
  while (end > 0) {
    const hit = LEGACY_ATTACH_LINE.exec(lines[end - 1].trim())
    if (!hit) break
    found.unshift(hit[1].trim())
    end -= 1
  }
  if (!found.length) return { body: text, attachments: [] }
  // 附件行之前那一行是当年发送时补的空行：一起吃掉，正文末尾不留空行。
  if (end > 0 && !lines[end - 1].trim()) end -= 1
  return { body: lines.slice(0, end).join('\n'), attachments: found.map((path) => ({ path })) }
}

export interface AttachmentCardProps {
  /** 文件完整路径（也是悬停提示与打开目标） */
  path: string
  /** 显示名；省略时取路径最后一段 */
  name?: string
  /** 字节数；未知时不显示大小 */
  size?: number
  /** 徽标尺寸：默认 md（卡片），芯片场景传 sm */
  badge?: FileBadgeSize
  className?: string
  /** 覆盖默认的打开行为（默认：能预览的走预览页签，其余交给系统） */
  onOpen?: (path: string) => void
}

/** 附件卡片：整块可点，悬停给完整路径与「打开」提示。 */
export function AttachmentCard({ path, name, size, badge = 'md', className, onOpen }: AttachmentCardProps) {
  const shown = name || fileName(path)
  return (
    <Tip label={path}>
      <button
        type='button'
        onClick={() => (onOpen ? onOpen(path) : void openAttachment(path))}
        aria-label={'附件 ' + shown + '：' + path}
        className={cn(
          'group/att flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-left',
          'transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:border-primary/40 hover:bg-hover',
          className,
        )}
      >
        <FileBadge path={path} size={badge} />
        <span className='min-w-0 flex-1 truncate text-12 text-ink'>{shown}</span>
        {typeof size === 'number' && size > 0 ? (
          <span className='shrink-0 text-11 tabular-nums text-ink-4'>{fmtBytes(size)}</span>
        ) : null}
        <ExternalLink
          size={12}
          className='shrink-0 text-ink-4 opacity-0 transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-spring)] group-hover/att:opacity-100'
        />
      </button>
    </Tip>
  )
}
