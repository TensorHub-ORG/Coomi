/** 引用块 / 引用芯片：划选或「引用」产生的片段，发送后长这样。
 *
 *  对外入口：
 *    · <QuoteBlock text msgId at />              —— 消息里的引用块（左竖线 + 摘要 + 来源，点击跳回）
 *    · <QuoteChip text onRemove />               —— 输入框里的引用芯片（两行摘要 + 删除）
 *    · parseLegacyQuotes(text)                   —— 旧消息正文开头的 `> ` 前缀升级成引用块
 *    · quoteSummary(text, lines)                 —— 只要摘要文本
 *
 *  跳转只走 lib/msgScroll：虚拟列表 / 普通列表由列表自己决定怎么定位，这里不碰 DOM。 */
import { Quote } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../lib/cn'
import { fmtTime } from '../../lib/format'
import { scrollToMessage } from '../../lib/msgScroll'

/** 一条引用：id 是本地标识（同一个 id 只加一次），msgId 是原消息 id（可能没有：旧消息 / 划选文本）。 */
export interface QuoteRef {
  id: string
  text: string
  msgId?: string
  at?: number
}

/** 引用摘要：最多 max 行，被截断时以省略号收尾（视觉上另有 line-clamp 兜底）。 */
export function quoteSummary(text: string, max = 3): string {
  const lines = String(text ?? '').split(/\r?\n/)
  if (lines.length <= max) return lines.join('\n')
  return lines.slice(0, max).join('\n') + '…'
}

/** 旧消息开头的 `> ` 前缀块（当年是把引用拼进正文的，现在改走结构化字段）。
 *  只认**开头连续**的引用行：正文中间出现的 `> ` 是用户自己写的 markdown 引用，不动它。 */
export function parseLegacyQuotes(text: string): { body: string; quotes: string[] } {
  const lines = String(text ?? '').split(/\r?\n/)
  let at = 0
  const quoted: string[] = []
  while (at < lines.length && /^>/.test(lines[at])) {
    quoted.push(lines[at].replace(/^> ?/, ''))
    at += 1
  }
  if (!quoted.length) return { body: text, quotes: [] }
  // 引用块后面那一行是当年发送时补的空行：一起吃掉，正文开头不留空行。
  if (at < lines.length && !lines[at].trim()) at += 1
  return { body: lines.slice(at).join('\n'), quotes: [quoted.join('\n')] }
}

export interface QuoteBlockProps {
  text: string
  /** 原消息 id：有它才谈得上「跳回」 */
  msgId?: string
  /** 原消息时间（引擎回读的历史才带） */
  at?: number
  /** 摘要最多显示几行，默认 3 */
  lines?: number
  className?: string
  /** 覆盖默认跳转（默认走 lib/msgScroll 的 scrollToMessage） */
  onJump?: (msgId: string) => void
}

/** 引用块：点一下跳回原消息。没有 msgId（旧消息 / 划选文本）时不假装能跳。 */
export function QuoteBlock({ text, msgId, at, lines = 3, className, onJump }: QuoteBlockProps) {
  const source = msgId
    ? at ? '原消息 · ' + fmtTime(at) : '点击跳回原消息'
    : '来自更早的消息'
  const jump = (): void => {
    if (!msgId) return
    if (onJump) { onJump(msgId); return }
    // 列表还没挂载（骨架阶段）或这条已经被截断：明确说一句，不做无声失败。
    if (!scrollToMessage(msgId)) toast.message('找不到原消息（可能已被截断或不在当前列表）')
  }
  return (
    <button
      type='button'
      onClick={jump}
      disabled={!msgId}
      title={quoteSummary(text, lines)}
      className={cn(
        'block w-full max-w-full rounded-r-md border-l-2 border-primary/45 bg-muted py-1.5 pl-2.5 pr-2 text-left',
        'transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
        msgId ? 'hover:bg-hover' : 'cursor-default',
        className,
      )}
    >
      <span className='line-clamp-3 whitespace-pre-wrap break-words text-12 leading-[1.55] text-ink-3'>{text}</span>
      <span className='mt-1 block truncate text-11 text-ink-4'>{source}</span>
    </button>
  )
}

export interface QuoteChipProps {
  text: string
  /** 点 × 的回调；省略时不给删除按钮 */
  onRemove?: () => void
  className?: string
}

/** 引用芯片：输入框顶部那一排。图标 + 两行摘要 + ×（退场动画由调用方的 AnimatePresence 播）。 */
export function QuoteChip({ text, onRemove, className }: QuoteChipProps) {
  return (
    <span
      className={cn(
        'flex max-w-[260px] items-start gap-1.5 rounded-md border border-primary/30 bg-primary-soft px-2 py-1',
        className,
      )}
      title={quoteSummary(text, 3)}
    >
      <Quote size={11} className='mt-[3px] shrink-0 text-primary' />
      <span className='line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words text-11 leading-[1.45] text-primary'>{text}</span>
      {onRemove ? (
        <button
          type='button'
          aria-label='删除这条引用'
          title='删除这条引用'
          onClick={onRemove}
          className='-mr-0.5 mt-[1px] shrink-0 rounded px-0.5 text-12 leading-none text-primary opacity-70 transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:opacity-100'
        >
          ×
        </button>
      ) : null}
    </span>
  )
}
