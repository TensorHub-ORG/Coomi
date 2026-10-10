import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'
import { useContextMenu, type CtxItem } from '../../stores/contextMenu'

/** 退场窗口（ms）：必须等于 --motion-fast。JS 读不到 CSS 变量，所以这里只能写数，
 *  但它**不是一个随手定的数**——改 theme.css 的 --motion-fast 就得同步改这里，否则
 *  元素会在淡出播到一半时被卸载（表现就是「啪」地消失）。 */
const EXIT_MS = 140
function useExitWindow(open: boolean, ms: number): boolean {
  const [closing, setClosing] = useState(false)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (open) { wasOpen.current = true; setClosing(false); return }
    if (!wasOpen.current) return
    wasOpen.current = false
    setClosing(true)
    const timer = window.setTimeout(() => setClosing(false), ms)
    return () => window.clearTimeout(timer)
  }, [open, ms])

  return closing
}

/** 右键菜单宿主：全局接管 contextmenu，避免弹出浏览器原生菜单；
 *  位置带边界钳制，永远不会超出窗口。 */
export function ContextMenuHost() {
  // 逐字段订阅：整对象订阅（useContextMenu()）时，x / y 每动一次、
  // items 每换一次引用都会把宿主连同整棵菜单树重渲染一遍，而它们在这里本来就各用各的。
  const open = useContextMenu((s) => s.open)
  const x = useContextMenu((s) => s.x)
  const y = useContextMenu((s) => s.y)
  const items = useContextMenu((s) => s.items)
  const hide = useContextMenu((s) => s.hide)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  /// 关闭时 store 会清空 items，这里留一份给孩子，退场那一小段还画得出来。
  const lastItems = useRef<CtxItem[]>(items)
  const closing = useExitWindow(open, EXIT_MS)
  const shown = open ? items : lastItems.current
  /// 方向语义：贴着光标往下弹的（data-side=bottom）从上方 4px 起；被窗口底边顶上去时反过来。
  const side: 'top' | 'bottom' = pos.top < y ? 'top' : 'bottom'

  useEffect(() => { if (items.length) lastItems.current = items }, [items])

  useLayoutEffect(() => {
    if (!open) return
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    // 只有真的挪了位置才写状态：同一坐标再来一次（右键落在菜单自己身上、
    // 或者 items 换了引用但位置没变）不该产生任何提交 —— 那是 #185 的典型引信。
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }))
  }, [open, x, y, items])

  useEffect(() => {
    if (!open) return
    const close = (): void => hide()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') hide() }
    window.addEventListener('mousedown', close)
    window.addEventListener('wheel', close, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, hide])

  /// 全局接管：右键不该再出现 Chromium 的原生菜单。输入框保留（粘贴/拼写检查要用）。
  useEffect(() => {
    /// 捕获阶段接管：有选区时 WebView2 会抢弹原生菜单，冒泡阶段拦不住。
    /// 只有显式标了 data-native-menu 的输入框才放行原生菜单（粘贴/拼写检查要用）。
    ///
    /// **只 preventDefault，不 stopPropagation**：压掉原生菜单靠的是 preventDefault，
    /// 而 stopPropagation 会在 window 这一层就把事件掐断——下游 React 的 onContextMenu
    /// （消息条目、会话条目里各自调 showContextMenu 的那些）根本收不到，
    /// 表现就是「右键完全没反应」。捕获阶段先于 React 跑完，所以这里看到空 items 时
    /// 只是把上一个菜单关掉，随后条目自己的 handler 再把新菜单打开。
    const onContextMenu = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-native-menu]')) return
      e.preventDefault()
      const items = useContextMenu.getState().items
      if (!items.length) hide()
    }
    window.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('contextmenu', onContextMenu, true)
    return () => {
      window.removeEventListener('contextmenu', onContextMenu, true)
      document.removeEventListener('contextmenu', onContextMenu, true)
    }
  }, [hide])

  if ((!open && !closing) || !shown.length) return null

  return createPortal(
    <div
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
      data-side={side}
      // 入场走 .pop-surface（方向由 data-side 给），退场是纯淡出，比缩放收敛更安静；
      // 底色/高程与 Menu 一致（--surface-overlay + --elev-3），两套右键菜单看起来是同一个东西。
      className={cn(
        'fixed z-[60] min-w-[184px] rounded-lg border border-line bg-overlay p-1 shadow-elev-3',
        // 只要进入关闭流程（!open），class 就**一直是** menu-fade-out，
        // 不会再切回 pop-surface —— 否则 closing 变 false（卸载前那帧）
        // 动画名从 menu-fade-out 换回 pop-in，浏览器重启动画，菜单消失前又弹入一次（闪一下）。
        !open || closing ? 'menu-exit' : 'pop-surface',
      )}
    >
      {shown.map((item, i) =>
        item.divider ? (
          <div key={'d' + i} className='my-1 h-px bg-line-soft' />
        ) : (
          <button
            key={item.label ?? i}
            type='button'
            disabled={item.disabled}
            onClick={() => { hide(); item.onSelect?.() }}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-xs px-2 text-left text-13 text-ink-2',
              'transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
              'disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
              item.danger
                ? 'hover:bg-danger-soft hover:text-danger active:bg-danger-soft'
                : 'hover:bg-hover hover:text-ink active:bg-active',
            )}
          >
            {item.icon ? <span className='shrink-0 text-ink-3 [&_svg]:h-3.5 [&_svg]:w-3.5'>{item.icon}</span> : null}
            <span className='truncate'>{item.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}