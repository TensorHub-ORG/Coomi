import { useEffect } from 'react'
import { Minus, Square, X } from 'lucide-react'
import { toast } from 'sonner'
import { ipc } from '../../lib/ipc'
import { useSession } from '../../stores/session'
import { Button } from '../ui/Button'
import { DesktopMenus } from './DesktopMenus'
import { queueDuringNavPause } from './navPause'

/** 滚动信号的空闲窗口（ms）：最后一次滚动之后再等这么久才摘掉标记。
    200ms 是「手指还在滚」与「停下来了」之间的那一档——短于 150ms 会在连续滚动里
    一下有一下没有地抖（毛玻璃被反复切来切去），长于 300ms 则停手之后还要糊一阵子。 */
const SCROLL_IDLE_MS = 200

/** 与 CSS 约定的属性名：html[data-scrolling='1']（样式见 theme.css 的 .glass-topbar 那一段）。 */
const SCROLLING_ATTR = 'scrolling'

/** 空闲定时器做成模块级单例：这个钩子全站只该有一个实例（标题栏只有一个），
    即便将来多挂一处，窗口也只有一份，不会两个定时器互相打架。 */
let scrollIdleTimer: number | null = null

/** 滚动状态标记：滚动一开始就给 html 挂 data-scrolling，200ms 没有新的滚动再摘。
    为什么这件事挂在标题栏里：要遮的正是它自己的毛玻璃（theme.css 里
    html[data-scrolling='1'] .glass-topbar 把那层 backdrop-filter 换成半透明纯色）。
    写在别处就成了「A 组件给 B 组件打标记」，标题栏将来换皮时这段逻辑没人跟着走。
    两个信号都算「滚动开始」：scroll（已经在动）+ wheel/touchstart（正要动）——
    等到第一个 scroll 再切，最快的那一帧已经带着 blur 画出去了。 */
function useScrollIdleFlag(): void {
  useEffect(() => {
    const root = document.documentElement

    /** 闲置 200ms 后摘标记。摘这一下交给闸门：切页过渡那 250ms 主线程最忙，
        这一拍不该再改一次样式 —— 排队到收闸时合并执行（同 key 只留最后一次）。 */
    function stop(): void {
      scrollIdleTimer = null
      queueDuringNavPause('topbar-scroll-idle', () => { delete root.dataset[SCROLLING_ATTR] })
    }

    function arm(): void {
      if (root.dataset[SCROLLING_ATTR] !== '1') root.dataset[SCROLLING_ATTR] = '1'
      if (scrollIdleTimer !== null) window.clearTimeout(scrollIdleTimer)
      scrollIdleTimer = window.setTimeout(stop, SCROLL_IDLE_MS)
    }

    /// 捕获阶段挂（passive）：scroll 不冒泡，只有捕获才收得到消息列表**内部**的滚动 ——
    /// 而滚动发涩恰恰发生在那里，标题栏要遮的也是那一下。
    const opts: AddEventListenerOptions = { passive: true, capture: true }
    document.addEventListener('scroll', arm, opts)
    document.addEventListener('wheel', arm, opts)
    document.addEventListener('touchstart', arm, opts)
    return () => {
      document.removeEventListener('scroll', arm, true)
      document.removeEventListener('wheel', arm, true)
      document.removeEventListener('touchstart', arm, true)
      if (scrollIdleTimer !== null) { window.clearTimeout(scrollIdleTimer); scrollIdleTimer = null }
      delete root.dataset[SCROLLING_ATTR]
    }
  }, [])
}

/** 自绘标题栏：左侧品牌 + 可拖拽空白 + 右侧窗口按钮。
    高度取 --topbar-h（44）这个布局令牌，底色取 --canvas-side：它是唯一保留毛玻璃的一层
    （.glass-topbar 用半透明底 + blur，其余表面一律半透明纯色，见 base.css 的性能一节）；
    按钮一律走 Button 的 ghost 变体（hover/active/焦点环都由组件给），
    只有「关闭」是唯一的危险色 —— 一屏里只允许一个红。

    「展开/收起侧栏」按钮自本轮起**不再放在这里**：它是页面工具（跟着页面走的东西放页面工具栏），
    对话页／产物页的工具栏里已经有了，两处都有等于同一个开关两个入口，
    而且标题栏按钮还盖在窗口按钮旁边，误点是关窗口而不是开侧栏。
    右侧栏在本页不渲染时靠右栏图标条自己打开（RightDock 的图标条点了就展开），入口没丢。 */
export function TitleBar({ title }: { title?: string }) {
  /// 滚动期间把标题栏的毛玻璃切成半透明纯色（滚动发涩的头号开销就在那一层，见 theme.css）。
  useScrollIdleFlag()
  /// 会话标题是跟着首条消息「长」出来的：流式期间还没有标题时先给一条骨架扫光，
  /// 标题到位后按 key 重挂一次做 180ms 淡入，切会话/改名都不会「啪」地换字。
  const streaming = useSession((s) => s.streaming)
  /// 窗口按钮的按压反馈：沉 2px（--shift-press）+ --motion-press(120ms) 弹性曲线，
  /// 两个值都从令牌取（指针反馈全站只有 2~3px 这一个量级，别在这里写死 px）。 */
  const winBtn = 'window-control'

  return (
    <div
      data-tauri-drag-region
      data-shell-part='titlebar'
      className='glass-topbar drag flex h-[var(--topbar-h)] shrink-0 items-center gap-2 border-b border-line pl-2 pr-0'
    >
      <DesktopMenus />
      {title ? (
        <>
          <span className='text-ink-4'>/</span>
          <span
            key={title}
            className='animate-fade max-w-[42%] truncate text-12 text-ink-2'
            title={title}
          >
            {title}
          </span>
        </>
      ) : streaming ? (
        <>
          <span className='text-ink-4'>/</span>
          <span role='status' aria-label='会话标题生成中' className='skeleton h-3 w-28 rounded-sm' />
        </>
      ) : null}
      <div className='flex-1' />
      <div className='no-drag flex h-full items-center'>
        <Button variant='ghost' size='icon-sm' aria-label='最小化' title='最小化' className={winBtn} onClick={() => void ipc('win_minimize').catch((e) => toast.error(String(e)))}>
          <Minus size={16} strokeWidth={1.5} />
        </Button>
        <Button variant='ghost' size='icon-sm' aria-label='最大化' title='最大化' className={winBtn} onClick={() => void ipc('win_toggle_maximize').catch((e) => toast.error(String(e)))}>
          <Square size={16} strokeWidth={1.5} />
        </Button>
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label='收起到托盘'
          title='收起到托盘；完全退出请使用托盘菜单'
          className={winBtn}
          onClick={() => void ipc('win_close').catch((e) => toast.error(String(e)))}
        >
          <X size={16} strokeWidth={1.5} />
        </Button>
      </div>
    </div>
  )
}
