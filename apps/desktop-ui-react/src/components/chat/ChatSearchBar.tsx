import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useChatSearch } from '../../stores/chatSearch'
import { Button } from '../ui/Button'
import { Tip } from '../ui/Overlay'

/** 会话内搜索条：Ctrl/Cmd+F 打开，输入即找，↑/Enter 在命中之间跳，Esc 关闭。
 *  命中与高亮由 MessageList 的 DOM 遍历完成——这里只管交互与计数。 */
export function ChatSearchBar() {
  const open = useChatSearch((s) => s.open)
  const query = useChatSearch((s) => s.query)
  const count = useChatSearch((s) => s.count)
  const active = useChatSearch((s) => s.active)
  const setQuery = useChatSearch((s) => s.setQuery)
  const next = useChatSearch((s) => s.next)
  const prev = useChatSearch((s) => s.prev)
  const hide = useChatSearch((s) => s.hide)
  const input = useRef<HTMLInputElement>(null)

  /// 打开时把焦点给输入框；若用户刚好选中了一段文字，直接拿来当关键词。
  useEffect(() => {
    if (!open) return
    const selected = (window.getSelection()?.toString() ?? '').trim()
    if (selected && selected.length <= 60 && !selected.includes('\n')) setQuery(selected)
    const el = input.current
    el?.focus()
    el?.select()
    // 只在「打开」这一刻做一次，不跟着 query 变化跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const status = !query ? '输入关键词' : count ? active + ' / ' + count : '无匹配'

  return (
    <div className='shrink-0 border-b border-line bg-surface px-3 py-2 elev-1 animate-rise'>
      <div className='mx-auto flex w-full max-w-[var(--content-w)] items-center gap-1.5'>
        <Search size={14} className='shrink-0 text-ink-4' />
        <input
          ref={input}
          data-native-menu
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); hide(); return }
            if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) prev(); else next() }
          }}
          placeholder='在当前对话里搜索…'
          className='h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-control px-2 text-12 text-ink placeholder:text-ink-4 focus:border-primary'
        />
        <span className='shrink-0 px-1 text-11 tabular-nums text-ink-3'>{status}</span>
        <Tip label='上一条（Shift+Enter）'>
          <Button variant='ghost' size='icon-sm' title='上一条（Shift+Enter）' disabled={!count} onClick={prev}>
            <ChevronUp size={14} />
          </Button>
        </Tip>
        <Tip label='下一条（Enter）'>
          <Button variant='ghost' size='icon-sm' title='下一条（Enter）' disabled={!count} onClick={next}>
            <ChevronDown size={14} />
          </Button>
        </Tip>
        <Tip label='关闭（Esc）'>
          <Button variant='ghost' size='icon-sm' title='关闭（Esc）' onClick={hide}>
            <X size={14} />
          </Button>
        </Tip>
      </div>
    </div>
  )
}
