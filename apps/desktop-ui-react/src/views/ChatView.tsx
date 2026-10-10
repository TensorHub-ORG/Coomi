import { memo, useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, Menu, PanelRight, PanelRightClose, Plus, Search } from 'lucide-react'
import { useChatItems, useSession } from '../stores/session'
import { useEngine } from '../stores/engine'
import { MessageList } from '../components/chat/MessageList'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { MessageNav, scrollChatToBottom, useChatAtBottom } from '../components/chat/MessageNav'
import { MessageSkeleton } from '../components/chat/MessageSkeleton'
import { CrashResumeBar, EngineRestartBar } from '../components/chat/RecoveryBars'
import { Composer } from '../components/chat/Composer'
import { ChatSearchBar } from '../components/chat/ChatSearchBar'
// 子智能体入口已搬进顶栏（popover），主列不再常驻展开面板。
import { SubagentPopover } from '../components/chat/SubagentPopover'
import { useChatSearch } from '../stores/chatSearch'
import { useUi } from '../stores/ui'
import { Button } from '../components/ui/Button'
import { Tip } from '../components/ui/Overlay'
import { useListPaneLayout } from '../components/shell/dockShared'
import { cn } from '../lib/cn'
import logo from '../assets/coomi-logo.png'

/** 对话页自己的工具栏。
    以前对话页没有头部，工具入口散在标题栏和导航栏上：会话列表的收放挂在 Rail（一级导航）上，
    预览面板开关挂在标题栏上，用户找不到、也不该去那里找。现在收在这一行里：
    左＝会话列表开关（窄窗口打开抽屉），中＝会话标题 + 当前模型，右＝搜索 / 右侧栏 / 新对话。
    开关状态仍然只读改 stores/ui 的 listCollapsed / listDrawerOpen（谁都不用自己存一份）。 */
function ChatToolbar() {
  const { narrow, showInline, showDrawer, open, close } = useListPaneLayout()
  const panelOpen = useUi((s) => s.panelOpen)
  const togglePanel = useUi((s) => s.togglePanel)
  const title = useSession((s) => s.sessions.find((x) => x.id === s.sessionId)?.title)
  const streaming = useSession((s) => s.streaming)
  const currentModel = useSession((s) => s.currentModel)
  const turnMeta = useSession((s) => s.turnMeta)

  // 会话列表可见＝内嵌展开或抽屉打开。收放走 useListPaneLayout：
  // 它按窗口宽度决定「叫回来 / 收起来」的是内嵌栏还是抽屉，应用层不用在这里再判一次。
  const listVisible = showInline || showDrawer
  const toggleList = (): void => { if (listVisible) { close() } else { open() } }

  return (
    <header
      data-chat-toolbar
      className='workbench-toolbar glass-bar flex h-[54px] shrink-0 items-center gap-2 border-b border-line px-4'
    >
      <Tip label={listVisible ? '收起会话列表' : narrow ? '打开会话列表' : '展开会话列表'}>
        <Button
          variant='ghost'
          size='sm'
          data-list-toggle
          aria-label={listVisible ? '收起会话列表' : '打开会话列表'}
          aria-expanded={listVisible}
          aria-controls={narrow ? 'coomi-list-drawer' : 'coomi-list'}
          onClick={toggleList}
          className='shrink-0 gap-1.5'
        >
          <Menu size={15} />
          {listVisible ? <span className='hidden truncate sm:inline'>会话列表</span> : null}
        </Button>
      </Tip>

      {/* 中间：会话标题 + 当前模型。窄列下两端一压，这里先截断，绝不把右侧按钮挤出去。 */}
      <div className='flex min-w-0 flex-1 items-center gap-2 px-2 text-left' title={(turnMeta?.model || currentModel || '默认模型') + ' · ' + (streaming ? '正在生成' : '就绪')}>
        {streaming ? <span className='h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary' aria-label='生成中' /> : null}
        {title ? (
          <p className='min-w-0 truncate text-14 font-semibold leading-tight text-ink' title={title}>{title}</p>
        ) : streaming ? (
          <span role='status' aria-label='会话标题生成中' className='skeleton mx-auto block h-3 w-28 rounded-sm' />
        ) : (
          <p className='truncate text-13 font-semibold leading-tight text-ink-3'>新会话</p>
        )}
      </div>

      <Tip label='搜索会话内容 · Ctrl+F'>
        <Button variant='ghost' size='icon-sm' aria-label='搜索会话内容' onClick={() => useChatSearch.getState().show()}>
          <Search size={15} />
        </Button>
      </Tip>
      {/* 子智能体入口：小图标按钮 + popover，带运行中数量小徽标；不常驻展开、不占对话空间 */}
      <SubagentPopover />
      <Tip label={panelOpen ? '收起右侧栏' : '展开右侧栏'}>
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label={panelOpen ? '收起右侧栏' : '展开右侧栏'}
          aria-pressed={panelOpen}
          onClick={() => togglePanel()}
        >
          {panelOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
        </Button>
      </Tip>
      <Tip label='新会话 · Ctrl+N'>
        <Button variant='ghost' size='icon-sm' aria-label='新会话' onClick={() => void useSession.getState().newSession()}>
          <Plus size={15} />
        </Button>
      </Tip>
    </header>
  )
}

/** 浮标的进出时长（＝--motion-fast，和 CSS 里的 duration 对齐）与脉冲按住多久。 */
const LATEST_FADE_MS = 140
const LATEST_PULSE_MS = 260

/** 「到最新」浮标：浮在输入框右上方、贴着内容列右缘的小胶囊。
 *
 *  为什么从导航条底部那一格搬出来：① 这是**这一页**的通用动作（窄窗口下导航条整条不渲染，
 *  它也得在）；② 「我要下去了」这种动作的落点本来就该在输入框旁边，而不是缩在左边的小地图里。
 *  导航条因此少了一格：它就是一条轨道，高度＝轨道高度，自适应逻辑一个字没动。
 *
 *  出现 / 消失：不在底部时淡入（140ms，从下方 4px 浮上来，--ease-spring），
 *  已在底部时淡出并**卸载** —— 不占位、不留一个灰按钮。上翻期间来了新消息，轻轻脉冲一次。
 *  点击与 End 键走同一条 scrollChatToBottom()：**强制贴底** —— 解除冻结、置 stick=true、
 *  走列表自己的贴底路径（虚拟列表 scrollToIndex(最后一条)）、最后 rAF 兜一次。
 *  **生成期间照常可用**（很多人正是生成时想跳回底部）。Tab 可聚焦，Enter / Space 触发。
 *
 *  重渲染口径：这一层既不挂滚动监听、也不量 rect —— 它只读 useChatAtBottom()
 *  （components/chat/MessageNav.tsx）里的一个布尔值，而那一位由 MessageList 从**内部**上报
 *  （虚拟化走 Virtuoso 的 atBottomStateChange，非虚拟化走它自己的滚动事件）。
 *  上报端只在**翻转**时通知，所以这一层「静止不动」时一帧都不重渲染；
 *  两个 effect（进出场 + 脉冲）各带一个 rAF / 定时器，都在 cleanup 里取消，不留悬挂的回调。 */

const ScrollToLatest = memo(function ScrollToLatest() {
  const { atBottom, pulse } = useChatAtBottom()
  const open = !atBottom
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  const [bump, setBump] = useState(false)

  /** 挂载 → 下一帧再翻 class：进场那 140ms 的过渡才有起点（否则是一次闪现）。
      收回时先翻 class 淡出，140ms 之后才卸载。 */
  useEffect(() => {
    if (open) {
      setMounted(true)
      const frame = window.requestAnimationFrame(() => setShown(true))
      return () => window.cancelAnimationFrame(frame)
    }
    setShown(false)
    const timer = window.setTimeout(() => setMounted(false), LATEST_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  /** 上翻期间来了新消息：脉冲一次（序号变一次就来一次，轻轻放大一下再落回去）。 */
  useEffect(() => {
    if (!pulse) return
    setBump(true)
    const timer = window.setTimeout(() => setBump(false), LATEST_PULSE_MS)
    return () => window.clearTimeout(timer)
  }, [pulse])

  if (!mounted) return null
  return (
    <button
      type='button'
      data-scroll-latest
      /* 藏起来的那 140ms 里别让 Tab 落到它上面 */
      tabIndex={shown ? undefined : -1}
      aria-label='滚动到最新消息'
      title='滚动到最新消息 · End'
      onClick={() => scrollChatToBottom()}
      className={cn(
        /* 贴 Composer 区域的右上角：right-0 对齐的是**内容列**（外层 max-w-[var(--content-w)]），
           不是窗口右边；bottom-full + mb-2 ＝ 落在输入框上方 8px。
           z-30：浮标悬在消息列表（不是滚动容器内部）之上，层级必须高过列表与导航条 ——
           否则它虽然画得出来，pointer 事件却会落到下面那层滚动容器上（看起来就是「点了没反应」）；
           在场时显式 pointer-events-auto（淡出那 140ms 里才是 none，别让 Tab 与点击落在半个浮标上）。 */
        'absolute bottom-full right-0 z-30 mb-2 flex h-7 items-center gap-1 rounded-full border border-line bg-overlay px-2.5 text-11 text-ink-3 shadow-elev-2',
        'transition-[opacity,translate,scale,background-color,color,box-shadow] duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
        'hover:bg-hover hover:text-ink hover:shadow-elev-3 active:scale-95',
        shown ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-1 opacity-0',
        bump && 'scale-110 text-primary',
      )}
    >
      <ChevronDown size={12} className='shrink-0' />
      <span>最新</span>
    </button>
  )
})

export function ChatView() {
  const sloganFont = useUi((s) => s.prefs.welcomeSloganFont)
  const streaming = useSession((s) => s.streaming)
  const engineStatus = useEngine((s) => s.status)
  const lastError = useEngine((s) => s.lastError)
  const restart = useEngine((s) => s.restart)
  /// 引擎异常提示：只在「真的出错并持续 2 秒」后出现一次，正常/启动中一个字都不显示，
  /// 免得切页、新建会话时闪一下「引擎未启动」。
  const [showError, setShowError] = useState(false)
  useEffect(() => {
    if (engineStatus !== 'error') { setShowError(false); return }
    const timer = window.setTimeout(() => setShowError(true), 2000)
    return () => window.clearTimeout(timer)
  }, [engineStatus])
  const items = useChatItems()
  /// 当前会话的历史是否已经回读完。没读完之前不渲染 hero / 空态，只渲染骨架；
  /// 这也是「进历史会话先闪一下新对话界面」的根治点。
  /// 还没有会话（sessionId 为空）不算「在加载」：那时 hero 该立刻出现，用户可以先打草稿。
  const sessionId = useSession((s) => s.sessionId)
  /// 右侧栏开合：挂在 <main> 上给 CSS 当钩子，面板展开时主列只做一次极轻的淡入，
  /// 不做位移/宽度动画（宽度是侧栏自己的事，主列跟着动会显得整页在抖）。
  const panelOpen = useUi((s) => s.panelOpen)
  const historyLoaded = useSession((s) => s.historyLoaded[s.sessionId] === true)

  /// 会话内搜索：Ctrl/Cmd+F 打开（Ctrl+K 是命令面板，两者错开），Esc 关闭。
  /// 只挂在对话页上——其它页面按 Ctrl+F 不该冒出一个搜不到东西的搜索条。
  ///
  /// End ＝ 一键到底，与输入框右上方那个「最新」浮标（本文件的 ScrollToLatest）同一条路径
  /// （components/chat/MessageNav.tsx 的 scrollChatToBottom：**强制贴底** —— 解除冻结 +
  /// 置 stick=true + 走列表自己的贴底路径 + 下一帧兜一次；生成期间同样有效）。
  /// 放在页面层而不是导航条里：导航条在窄窗口下整条隐藏，而 End 是这一页的通用动作。
  /// 输入框 / 文本域里的 End 是「移到行尾」，一个字都不能抢，所以先看事件目标。
  useEffect(() => {
    const inField = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null
      if (!el || !el.tagName) return false
      return el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName)
    }
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        useChatSearch.getState().show()
        return
      }
      if (e.key === 'Escape' && useChatSearch.getState().open) useChatSearch.getState().hide()
      // 对话页不在前台时（App 把上一页留在 DOM 里）不接管 End：那是别的页面的按键。
      if (e.key === 'End' && !mod && !e.altKey && !e.shiftKey && !inField(e.target) && useUi.getState().view === 'chat') {
        e.preventDefault()
        scrollChatToBottom()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])


  const empty = items.length === 0
  const loadingHistory = !!sessionId && !historyLoaded

  /// 已有内容的那一支：消息列表 + 底部输入区。
  /// loadingHistory 时只有消息列表降透明度且不接事件（旧会话内容只是「还没换掉」，
  /// 不能让用户在过期内容上点重新生成）；输入框保持可打字，不跟着一起变灰。
  const conversation = (
    <>
      {/* relative：消息导航条挂在这一层里（绝对定位，不参与 flex、不进 MessageList：
          那边的渲染路径、虚拟化与「已见」记账一个字都不动）。
          data-chat-body 是导航条的定位基准（它按这一层做垂直居中），也是自检脚本量
          「轨道中心 vs 容器中心」时用的锚点——别删。 */}
      <div data-chat-body className={cn(
        'relative flex min-h-0 flex-1 flex-col',
        'transition-opacity duration-[var(--motion-base)] ease-[var(--ease-enter)]',
        loadingHistory && 'pointer-events-none opacity-45',
      )}
      // 侧边栏宽度变化时：消息列表内部重排不再级联到整个外壳（收侧边栏卡的主因之一）
      style={{ contain: 'layout' }}>
        {/* 会话区**自己的一层**错误边界：消息列表崩了只让这一块换成一张小卡片 + 重试，
            导航 / 会话列表 / 输入区 / 标题栏全都照常可用 —— 绝不把整屏一起带走。
            resetKey 跟着会话走：换个会话（或新建）自动复位，不用用户去点重试。 */}
        <ErrorBoundary scope='chat.messages' variant='section' label='会话内容' resetKey={sessionId}>
          <MessageList />
        </ErrorBoundary>
        <MessageNav />
      </div>
      {/* overflow-x-clip：只裁横向，不产生滚动条，也不影响输入框自带的阴影。
          [&_button:not(:last-child)]:min-w-0 让工具按钮在窄列里可以收缩，
          最后一个按钮（发送/停止）保持原尺寸，整行因此永远放得下。 */}
      <div className='workbench-composer-zone relative shrink-0 overflow-x-clip px-4 pb-5 pt-3 [&_button:not(:last-child)]:min-w-0'>
        <div className='workbench-composer-fade pointer-events-none absolute inset-x-0 -top-10 h-10' />
        {/* relative：里面的「到最新」浮标以**这一层**（＝内容列，max-w-[var(--content-w)] 居中）为准，
            所以它对齐的是输入框的右缘，不是窗口右边。 */}
        <div className='relative mx-auto w-full max-w-[var(--content-w)]'>
          <Composer />
          <ScrollToLatest />
        </div>
      </div>
    </>
  )

  // 主内容列：flex-1 min-w-0，并且自己裁剪横向溢出。
  // 输入框那一行的按钮在极窄窗口下宁可被裁在本列内，也绝不画到右侧栏上面。
  return (
    <main
      data-chat-col
      data-panel-open={panelOpen ? 'true' : 'false'}
      className='relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas'
    >
      {/* 对话页工具栏：本页自己的头部，跟着本页一起被裁在这条主列里（不会压到侧栏上） */}
      <ChatToolbar />
      {/* 异常提示条：出现时走统一的 rise-soft（--motion-base），不是「啪」地插入一整行 */}
      {showError ? (
        <div className='flex animate-bar items-center gap-2 border-b border-danger/30 bg-danger-soft px-4 py-1.5 text-12 text-danger'>
          <AlertTriangle size={13} />
          <span className='flex-1 truncate'>{streaming ? '引擎正在处理中（长任务较慢，请稍候…）' : `引擎异常：${lastError || '未知原因'}`}</span>
          {!streaming ? (
            <button
              type='button'
              className='rounded-[6px] px-2 py-0.5 transition-colors duration-[var(--motion-fast)] hover:bg-danger/10'
              onClick={() => void restart()}
            >
              重启引擎
            </button>
          ) : null}
        </div>
      ) : null}
      {/* 引擎重启恢复 / 崩溃中断：都贴在消息区上方，不挤占输入框 */}
      <EngineRestartBar />
      <CrashResumeBar />
      <ChatSearchBar />
      {/* 历史没回来之前：有旧内容就让旧内容留在原位（降透明度），没内容就画骨架；
          只有「确实加载完且真的没有消息」才渲染 hero。 */}
      {!empty ? conversation : loadingHistory ? (
        <MessageSkeleton />
      ) : (
        <div className='welcome-page min-h-0 flex-1 animate-page'>
          <div className='welcome-content'>
            <div className='welcome-heading'>
              <div className='welcome-brand'>
                <img data-theme-mascot='logo' src={logo} alt='' />
                {sloganFont === 'guofeng'
                  ? <span className='welcome-wordmark' role='img' aria-label='Coomi.'><span className='sr-only'>Coomi.</span></span>
                  : <span className='welcome-wordmark-text'>Coomi<span className='brand-dot'>.</span></span>}
              </div>
              <h1 className={cn('welcome-title', sloganFont === 'guofeng' && 'welcome-calligraphy')}>
                <span className={sloganFont === 'guofeng' ? 'sr-only' : undefined}>慎终如始，则无败事</span>
              </h1>
              <p className='welcome-description'>准备好了，就告诉我想做什么</p>
            </div>
            <Composer hero />
          </div>
        </div>
      )}
    </main>
  )
}
