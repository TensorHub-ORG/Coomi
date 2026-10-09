import { Fragment, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import {
  AlertTriangle, Check, ChevronRight, ChevronUp, Clock3, Copy, FileText, FolderOpen, GitBranch, Globe,
  MoreHorizontal, Pencil, Play, Quote, RefreshCw, RotateCcw, Save, Search, Slash, Sparkles, ThumbsDown, ThumbsUp, Wrench,
} from 'lucide-react'
import { m, type MotionProps } from 'motion/react'
import { cn } from '../../lib/cn'
import { fmtDuration, fmtTime, fmtTokens } from '../../lib/format'
import { motionOn, staggerSeconds } from '../../lib/motionPref'
import { EASE_OUT_QUINT, SEC_BASE, SPRING_POP } from '../ui/motion'
import { useChatItems, useSession, type RenderItem, type UserChatItem } from '../../stores/session'
import { useEngine } from '../../stores/engine'
import { registerSearchController, useChatSearch, type SearchController } from '../../stores/chatSearch'
import { registerMessageScroller } from '../../lib/msgScroll'
import { navPauseBusy, useNavPause } from '../shell/navPause'
import { promptText } from '../../stores/dialogs'
import { showContextMenu, type CtxItem } from '../../stores/contextMenu'
import { ipc } from '../../lib/ipc'
import { useUi } from '../../stores/ui'
import { chatWindowTail, friendlyErrorText, markGroupSeen, markItemsSeen, splitProcessAnswer, toolSeenKey, type ChatItem, type ToolCall } from '../../lib/chat'
// 吸底唯一入口：新消息 / 内容增长 / turn_end / 强制贴底都收在它里面。
import { useStickToBottom } from './useStickToBottom'
import { ArtifactList } from './ArtifactCard'
// AI 提问卡：对话流里的一条普通条目（答完留在原地，见组件顶部说明）。
import { AskUserCard } from './AskUserCard'
import { ProcessBlock } from './ProcessBlock'
import { markCollapseMotion, toggleTransition } from './collapseMotion'
// 生成中的三点跳动：只要还在流式就挂在内容末尾，替代原来的「正在思考…」。
import { TypingDots } from './TypingDots'
import { type TurnArtifact } from '../../stores/artifacts'
import { useCapabilities } from '../../stores/capabilities'
import { Markdown } from './Markdown'
import { AttachmentCard, parseLegacyAttachments, type AttachmentRef } from './AttachmentCard'
import { QuoteBlock, parseLegacyQuotes, type QuoteRef } from './QuoteBlock'
import { AgentState, type AgentStateKind } from '../ai/AgentState'
// 助手默认头像（插件主题 mascot.avatar 的可替换挂点，见组件内 data-theme-mascot=avatar）。
import assistantAvatar from '../../assets/coomi-logo.png'
import { Button } from '../ui/Button'
import { Menu, type MenuEntry } from '../ui/Menu'
// 插件主题 parts（v1.7）：消息气泡的圆角 / 阴影经它订阅。
import { useThemeParts } from '../plugins/PluginThemeEngine'

/* ── 窗口化（本组件**不用**虚拟列表，这是有意为之，勿贸然恢复）──
   做法：直接渲染最后 WINDOW_STEP 条（默认 60），顶部「加载更早」按钮每次 +60。
   长会话的 DOM 体量因此与「看得到的部分」成正比，而不再与整条会话成正比。

   ── 为什么 react-virtuoso 被移除（2026-10 复查结论）──
   仓库只有一个基线提交，两份发布源码包（1.0.0 / 1.0.2）里的本文件也**已经是移除之后**的版本，
   所以拿不到「移除前」的源码逐行对比；下面是代码里**白纸黑字写着的**移除理由，
   逐条都能在别处对上号：
     ① 「测量节点 contain: layout 量出 0」
        —— base.css 渲染隔离那一段至今留着这条警告：虚拟列表的 item wrapper 一旦被
        contain: layout 裁成布局根，量出来的高度就是 0。而本项目为了性能到处在加 contain，
        这条与虚拟化是直接冲突的。
     ② 「流式期间逐帧重量」
        —— 本组件整套「冻结测量窗口」（html[data-msg-collapse] / [data-msg-freeze]，
        见下面 markCollapseMotion）就是为这件事写的：流式正文与折叠块在动画期间逐帧变高，
        虚拟列表每一帧都要照着新高度重量一次，长会话里表现就是「一边流式一边滚，整屏在抖」。
     ③ 「跳位」
        —— 视口上方的行一旦被量高，整段内容会往下平移。技能中心那条自己写的窗口化
        （components/skills/useVirtualList.ts 顶部）专门为此写了 pendingAnchor 锚点校正，
        它自己就两百行以内；对话列表要补齐这套还得额外处理吸底、搜索跳转与折叠块联动。
   另有一条同族的坑：给消息行加 content-visibility:auto **试过并失败**（2026-09-27 真机取证：
   视口内的整行被判成「与用户无关」而永久跳过绘制，用户看到「我发的消息消失了」），
   回归断言 tests/check-msg-visibility.mjs 从源码层面拦住它被加回来。

   ── 因此的处置 ──
   **不恢复**虚拟化。理由是上面三条坑都还在，且恢复虚拟化会让聊天列表的观感与交互
   （吸底 / 会话内搜索跳转 / 折叠块 / 划选浮条）重新进入「可能跳位」的区间。
   真要恢复，属于需要用户明确拍板的改动（是否接受「跳位」与「流式期间重量」这两个坑），
   不能由性能优化单方面做主。
   侧栏收放卡顿改用 contain: layout 止血（见 base.css 的「侧栏收放卡顿的止血」一段）：
   它不改变 DOM 体量，也不引入跳位；代价是「每行重新断行」这笔开销仍在。 */

/** 入场动效：8px 的 rise。时长/缓动取 components/ui/motion.ts 里的令牌值
    （= CSS 的 --motion-base + --ease-out-quint），两套动画的手感必须同一个来源。
    新消息这块面积大、又不是「弹出来」的小东西，所以用 tween + out-quint，不上 spring。
    **只动位移，绝不动不透明度**：动画被打断/暂停时停在半路，用户看到的就是「这条回复
    颜色很淡」甚至「消息不见了」（opacity 停在 0）。位移停住最多是差几像素，内容永远看得清。
    设置里关掉动效或系统「减少动态效果」时返回 null，调用方走静态渲染（不跑第二套）。 */
function riseProps(delay = 0): MotionProps | null {
  if (!motionOn()) return null
  return {
    initial: { y: 6 },
    animate: { y: 0 },
    transition: { duration: SEC_BASE, delay, ease: EASE_OUT_QUINT },
  }
}

/** 不播入场时用的 motion 属性：仍然渲染同一个 m.div，只是把 initial 关掉。
    **元素类型绝不能由 fresh 决定**——「这一帧播入场的 m.div」在下一帧换成普通 div，
    React 会把整棵子树重挂，里面工具行 / 提示卡的入场跟着再播一遍；
    切回旧会话时看起来就是「AI 又把回答输出了一遍」。 */
const NO_ENTER: MotionProps = { initial: false }

/** 入场属性：要播就给 rise，不播就给 NO_ENTER（元素类型恒定）。 */
function enterProps(fresh: boolean, delay = 0): MotionProps {
  return (fresh ? riseProps(delay) : null) ?? NO_ENTER
}


/* ── 冻结测量：滚动流畅度与虚拟列表共用的一道闸门 ──
   行高在两种时候是逐帧变的：**流式正文在长**、**折叠块在开合**。虚拟列表每一帧都会照着
   新高度重量一次，长会话里表现出来的就是「一边流式一边滚，整屏在抖」和
   「点开思考链，视口跳一下」。策略只有一句：变高的那段时间**不量**。
   判据写在 html 属性上（与 shell/navPause 的 data-nav-busy 同一套做法）：
     · html[data-msg-collapse='1']  折叠动画窗口，下面 markCollapseMotion() 写，220ms 后摘；
     · [data-msg-freeze='1']        流式 / 切页过渡，挂在消息列表容器上（组件里给）。
   CSS 读的是同两个属性（base.css 的「滚动流畅度」那段把折叠块换成固定高度占位），
   JS 与 CSS 因此不会各判一套。 */


/** 瞬时滚动：程序化滚动里除「跳转」以外**全部**用它（贴底、恢复位置、校正）。 */
const INSTANT: ScrollBehavior = 'instant'



/** 程序化滚动的行为：**只有「跳转」才平滑**，其余一律瞬时。
    流式期间连跳转也不平滑 —— 一边在长内容一边滑过去，落点永远追不上，看起来就是「一直在飘」；
    关掉动效 / 系统「减少动态效果」时同样直接落位。 */
function jumpBehavior(smooth: boolean): ScrollBehavior {
  return smooth && motionOn() ? 'smooth' : INSTANT
}


/* ── 思考链：默认折叠，点了才展开 ──
   展开后必须给高度上限：思考可以很长，不封顶会一路把正文顶出屏幕。
   框内自己滚，流式中自动贴底；用户一旦手动上滚就停止跟随（否则没法回看已经想过的部分）。 */

const DOT: Record<ToolCall['status'], string> = {
  queued: 'bg-ink-4',
  running: 'bg-primary',
  done: 'bg-ok',
  error: 'bg-danger',
  denied: 'bg-warn',
}

/* ── 「安静」类工具：读 / 写 / 改 / 搜 / 查 / 抓 用一条细信息表达，不占一个卡片 ── */
type QuietKind = 'read' | 'write' | 'edit' | 'search' | 'find' | 'fetch'

const QUIET_TOOLS: Record<string, QuietKind> = {
  read: 'read', read_file: 'read', read_text_file: 'read', readfile: 'read', cat: 'read',
  view: 'read', view_file: 'read', open_file: 'read', fs_read: 'read', read_multiple_files: 'read',
  write: 'write', write_file: 'write', writefile: 'write', create_file: 'write', save_file: 'write',
  fs_write: 'write', append_file: 'write',
  edit: 'edit', edit_file: 'edit', replace_in_file: 'edit', str_replace: 'edit', str_replace_editor: 'edit',
  apply_patch: 'edit', multi_edit: 'edit', patch_file: 'edit', notebook_edit: 'edit',
  grep: 'search', search: 'search', search_files: 'search', ripgrep: 'search', code_search: 'search',
  search_code: 'search', find_in_files: 'search', content_search: 'search', context_search: 'search',
  glob: 'find', find: 'find', ls: 'find', list: 'find', list_dir: 'find', list_files: 'find',
  list_directory: 'find', directory_tree: 'find', file_search: 'find',
  web_fetch: 'fetch', fetch: 'fetch', http_get: 'fetch', read_url: 'fetch',
}

/** 工具名可能带前缀（fs.read_file / mcp__fs__read），取最后一段再判类型。 */
function quietKind(name: string): QuietKind | null {
  const key = name.toLowerCase().trim().replace(/[.\-/]+/g, '_').replace(/^mcp_+/, '')
  const tail = key.split('_').slice(-2).join('_')
  return QUIET_TOOLS[key] ?? QUIET_TOOLS[key.split('_').pop() ?? ''] ?? QUIET_TOOLS[tail] ?? null
}

/** 细条工具用哪套状态语言：读 / 写 / 搜 各有点阵自己的动效，扫一眼就能分辨。 */
const QUIET_STATE: Record<QuietKind, AgentStateKind> = {
  read: 'reading',
  write: 'writing',
  edit: 'writing',
  search: 'searching',
  find: 'searching',
  fetch: 'searching',
}

const QUIET_META: Record<QuietKind, { verb: string; icon: typeof FileText }> = {
  read: { verb: '读取', icon: FileText },
  write: { verb: '写入', icon: Save },
  edit: { verb: '修改', icon: Pencil },
  search: { verb: '搜索', icon: Search },
  find: { verb: '查找', icon: FolderOpen },
  fetch: { verb: '抓取', icon: Globe },
}

/* ── 安静类工具的**分色** ──
   读 / 写 / 改 / 搜 / 抓 各用一支语义色，token 全部来自 styles/theme.css 的
   「写入类工具的语义色」（--tool-read / --tool-write / --tool-edit / --tool-search / --tool-fetch，
   明暗两套值 + 各自的 -soft 浅底），这里只消费类名，不再自己写色值。
   写入与修改**明显加深**：左侧 2px 色条满色 + 整行压一层同色浅底 + 图标 / 动词 / 目标都用对应色，
   其余几类只染图标与动词（色条半透明），一眼能分出「只是看看」和「动了文件」。
   出错一律回到 --tool-error 的那一种红，不参与分色——错误必须是全场最显眼的那个信号。 */
const QUIET_TONE: Record<QuietKind, { text: string; bar: string; soft: string; strong: boolean }> = {
  read: { text: 'text-tool-read', bar: 'bg-tool-read', soft: 'bg-tool-read-soft', strong: false },
  write: { text: 'text-tool-write', bar: 'bg-tool-write', soft: 'bg-tool-write-soft', strong: true },
  edit: { text: 'text-tool-edit', bar: 'bg-tool-edit', soft: 'bg-tool-edit-soft', strong: true },
  search: { text: 'text-tool-search', bar: 'bg-tool-search', soft: 'bg-tool-search-soft', strong: false },
  find: { text: 'text-tool-search', bar: 'bg-tool-search', soft: 'bg-tool-search-soft', strong: false },
  fetch: { text: 'text-tool-fetch', bar: 'bg-tool-fetch', soft: 'bg-tool-fetch-soft', strong: false },
}

/** 从参数里挑出「对象」：文件路径 / 搜索词 / URL。 */
function toolTarget(tool: ToolCall, kind: QuietKind): string {
  try {
    const args = JSON.parse(tool.args || '{}') as Record<string, any>
    const pick = (keys: string[]): string => {
      for (const key of keys) {
        const value = args[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
      return ''
    }
    if (kind === 'search') return pick(['pattern', 'query', 'regex', 'q', 'keyword', 'text'])
    if (kind === 'find') return pick(['pattern', 'glob', 'path', 'dir', 'directory', 'query'])
    if (kind === 'fetch') return pick(['url', 'uri', 'href'])
    return pick(['path', 'file_path', 'filePath', 'filename', 'file', 'target_file', 'notebook_path'])
  } catch { return '' }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

/** 状态落定时的「弹一下」：只动 transform（不再动 opacity —— 同理，打断后停在半路会发淡），行高不跳。
    用**真弹性**（SPRING_POP = stiffness 520 / damping 30），不用 tween + duration：
    状态是异步落定的，动画随时可能被下一次状态变化打断，spring 能从当前速度接着走。
    动效关掉时退回普通 span —— 不再同时挂 CSS 的 animate-check-in，两套动画不并存。 */
function Pop({ children, className }: { children: React.ReactNode; className?: string }) {
  if (!motionOn()) return <span className={className}>{children}</span>
  return (
    <m.span
      className={className}
      initial={{ scale: 0.62 }}
      animate={{ scale: 1 }}
      transition={SPRING_POP}
    >
      {children}
    </m.span>
  )
}

/** 工具状态标记：running 交给 AgentState 的点阵（细条工具按读/写/搜分派），
    done 播一次成功勾，error / denied 用语义色图标。
   queued 是「还没轮到它」，给个静态点（不假装在跑）。 */
function ToolMark({ status, kind }: { status: ToolCall['status']; kind?: QuietKind | null }) {
  if (status === 'running') {
    return <AgentState state={kind ? QUIET_STATE[kind] : 'running'} size='xs' tone='primary' className='shrink-0' />
  }
  if (status === 'done') return <Pop className='inline-flex shrink-0'><Check size={12} className='text-ok' /></Pop>
  if (status === 'error') return <Pop className='inline-flex shrink-0'><AlertTriangle size={12} className='text-danger' /></Pop>
  return (
    <Pop className='inline-flex shrink-0'>
      <span className={cn('h-1.5 w-1.5 rounded-full', DOT[status])} />
    </Pop>
  )
}

/* ── 工具调用：读/写/改/搜/查/抓 是一条细信息；其余工具仍然给一张可展开的卡 ── */
function ToolRow({ tool, fresh, defaultOpen }: { tool: ToolCall; fresh: boolean; defaultOpen?: boolean }) {
  /// 出错与被拒都算「不该被折叠藏起来」：默认摊开参数 / 结果。
  const bad = tool.status === 'error' || tool.status === 'denied'
  const [open, setOpen] = useState(!!defaultOpen || bad)
  /// 只自动摊开一次：用户之后手动收起，不该被「还是失败」反复强开回来。
  const autoOpened = useRef(bad)
  useEffect(() => {
    if (!bad || autoOpened.current) return
    autoOpened.current = true
    setOpen(true)
  }, [bad])
  const kind = quietKind(tool.name)
  /// 只有「这一行是刚出现的」才播入场：滚回来 / 重挂载的旧工具行不播。
  const enter = enterProps(fresh)
  const detail = (
    <div className={kind ? 'mb-1 ml-2 border-l border-line pl-3' : 'border-t border-line px-3 py-2'}>
      {tool.args && tool.args !== '{}' ? (
        <pre className='sel-text mb-2 max-h-40 overflow-auto rounded bg-code px-2 py-1.5 font-mono text-11 leading-[1.6] text-code-fg'>{tool.args}</pre>
      ) : null}
      {tool.preview ? (
        <pre className='sel-text max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-11 leading-[1.6] text-ink-2'>{tool.preview}</pre>
      ) : <p className='text-12 text-ink-4'>没有输出</p>}
    </div>
  )

  if (kind) {
    const meta = QUIET_META[kind]
    const Icon = meta.icon
    const target = toolTarget(tool, kind)
    const tone = QUIET_TONE[kind]
    const failed = tool.status === 'error'
    /// 错误优先：只有这一种红，压过一切分色。
    const textClass = failed ? 'text-tool-error' : tone.text
    const strong = tone.strong && !failed
    const line = tool.preview ? tool.preview.split('\n').length : 0
    const summary = tool.status === 'running'
      ? '进行中'
      : tool.status === 'error'
        ? '失败'
        : tool.preview
          ? line > 1 ? line + ' 行' : fmtSize(tool.preview.length)
          : ''
    return (
      <m.div className='group/quiet my-0.5' {...enter}>
        <button
          type='button'
          onClick={() => { markCollapseMotion(); setOpen((v) => !v) }}
          className={cn(
            'relative flex w-full items-center gap-1.5 overflow-hidden rounded-md py-1 pl-2.5 pr-1.5 text-left text-12 transition-colors duration-[var(--motion-hover)] ease-[var(--ease-spring)] hover:bg-hover',
            // 整行文字继承这一支语义色：图标、动词、写入类的目标路径一起上色。
            textClass,
          )}
        >
          {/* 左侧 2px 色条：分色的主信号。写入 / 修改满色，读 / 搜 / 抓 半透明。 */}
          <span
            aria-hidden
            className={cn(
              'absolute inset-y-0 left-0 w-[2px] rounded-full transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
              failed ? 'bg-tool-error' : tone.bar,
              !failed && !strong && 'opacity-50',
            )}
          />
          {/* 写入 / 修改：整行再压一层同色浅底——「这条动过文件」要一眼看出来 */}
          {strong ? (
            <span aria-hidden className={cn('pointer-events-none absolute inset-0', tone.soft)} />
          ) : null}
          <Icon size={12} className='relative shrink-0' />
          <span className='relative shrink-0 font-medium'>{meta.verb}</span>
          {/* 目标（路径 / 搜索词 / URL）跟着这一行的语义色走：分色要能一眼扫出「这一行在干什么」。 */}
          {target ? <span className='relative min-w-0 truncate font-mono text-11'>{target}</span> : null}
          {tool.cacheHit ? <span className='shrink-0 text-11 text-ink-4'>缓存命中</span> : null}
          <span className='flex-1' />
          {tool.elapsedMs != null ? <span className='shrink-0 text-11 text-ink-4'>{tool.elapsedMs}ms</span> : null}
          {summary ? <span className={cn('shrink-0 text-11 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]', failed ? 'text-tool-error' : 'text-ink-4')}>{summary}</span> : null}
          {/* key=status：状态一变就重挂一次，Pop 的入场才会重播（正在跑 -> 完成） */}
          <ToolMark key={tool.status} status={tool.status} kind={kind} />
          {/* 悬停才露出的箭头：透明度走 CSS 的 hover 档，旋转走 spring（连点不卡） */}
          <span className={cn('inline-flex shrink-0 text-ink-4 opacity-0 transition-opacity duration-[var(--motion-hover)] ease-[var(--ease-spring)] group-hover/quiet:opacity-100', open && 'opacity-100')}>
            <m.span className='inline-flex' initial={false} animate={{ rotate: open ? 90 : 0 }} transition={toggleTransition()}>
              <ChevronRight size={12} />
            </m.span>
          </span>
        </button>
        <div className='collapse' data-open={open}><div>{detail}</div></div>
      </m.div>
    )
  }

  return (
    <m.div className='my-2 overflow-hidden rounded-lg border border-line bg-surface' {...enter}>
      <button type='button' onClick={() => { markCollapseMotion(); setOpen((v) => !v) }} className='flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover'>
        <Wrench size={13} className='shrink-0 text-ink-4' />
        <span className='truncate font-mono text-12 text-ink-2'>{tool.name}</span>
        {tool.cacheHit ? <span className='shrink-0 text-11 text-ink-4'>缓存</span> : null}
        <span className='flex-1' />
        {tool.elapsedMs != null ? <span className='shrink-0 text-11 text-ink-4'>{tool.elapsedMs}ms</span> : null}
        <ToolMark key={tool.status} status={tool.status} />
        <m.span className='inline-flex shrink-0 text-ink-4' initial={false} animate={{ rotate: open ? 90 : 0 }} transition={toggleTransition()}>
          <ChevronRight size={12} />
        </m.span>
      </button>
      <div className='collapse' data-open={open}><div>{detail}</div></div>
    </m.div>
  )
}

/** ToolCallList 的注入点：单个工具行始终交给现有 ToolRow 渲染 ——
    `ToolMark`（状态点）、`toolTarget`（目标）以及「展开看参数 / 结果」都在它内部，
    折叠列表只提供外壳与摘要，不重画第二套行渲染（改一处不会漏一处）。 */
function renderToolRow(tool: ToolCall, fresh: boolean, defaultOpen: boolean): React.ReactNode {
  return <ToolRow key={tool.callId} tool={tool} fresh={fresh} defaultOpen={defaultOpen} />
}

/* ── 消息悬浮工具条：复制 / 引用 / 编辑重发 / 重新生成 / 分支 ── */
/* ── 消息下方一行操作：默认半透明，hover 该消息时点亮 ──
   宽度不够时**整组收进一个「⋯」下拉**（不是折行、也不是把按钮藏掉）：
   元信息行因此永远单行。判据是 @container 的**容器宽度**（＝元信息行的列宽 --content-w），
   不是窗口宽度 —— 会话列表 / 侧栏开合让正文列变窄时同样要收。
   两套并列渲染、由 CSS 断点决定露哪一套：不跑 ResizeObserver，也就没有
   「先画错一帧再纠正」的闪动，也不需要在渲染期间读写 DOM。
   860px 这个值是**列宽**（不是视口）：平铺六个按钮约 380px，加上元信息里
   永不隐藏的时间与模型名（模型名上限 12rem），两样一起放得下才值得平铺。 */
function MsgActions({ onCopy, onQuote, onEdit, onBranch, onRegenerate, onFeedback, align }: {
  onCopy: () => void
  onQuote?: () => void
  onEdit?: () => void
  onBranch?: () => void
  onRegenerate?: () => void
  onFeedback?: (good: boolean) => void
  align: 'left' | 'right'
}) {
  const btn = (label: string, icon: React.ReactNode, onClick: () => void, danger = false) => (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        // whitespace-nowrap + shrink-0：按钮自己绝不折行，也不参与收缩（宽度不够交给「⋯」）。
        'flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-11 text-ink-3 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
        danger ? 'hover:bg-danger-soft hover:text-danger' : 'hover:bg-hover hover:text-ink',
      )}
    >
      {icon}
      {label}
    </button>
  )
  /// 「⋯」里的那一套：与平铺那排**逐项对齐**（有才给，没有就不占位）。
  const entries: MenuEntry[] = [
    { label: '复制', icon: <Copy size={12} />, onSelect: onCopy },
    ...(onQuote ? [{ label: '引用', icon: <Quote size={12} />, onSelect: onQuote }] : []),
    ...(onEdit ? [{ label: '编辑重发', icon: <Pencil size={12} />, onSelect: onEdit }] : []),
    ...(onRegenerate ? [{ label: '重新生成', icon: <RotateCcw size={12} />, onSelect: onRegenerate }] : []),
    ...(onBranch ? [{ label: '分支', icon: <GitBranch size={12} />, onSelect: onBranch }] : []),
    ...(onFeedback
      ? [
        { label: '不错', icon: <ThumbsUp size={12} />, onSelect: () => onFeedback(true) },
        { label: '有问题', icon: <ThumbsDown size={12} />, onSelect: () => onFeedback(false) },
      ]
      : []),
  ]
  return (
    <div
      className={cn(
        // has-[[data-state=open]]：下拉开着时焦点在 portal 里的菜单上，focus-within 收不到，
        // 少了这一条「⋯」会在菜单展开的瞬间自己淡出（看起来像菜单浮在空气里）。
        'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-spring)] group-hover/msg:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100',
        align === 'right' ? 'justify-end' : 'justify-start',
      )}
    >
      {/* 平铺：容器够宽才出现 */}
      <div className='hidden items-center gap-0.5 @min-[860px]:flex'>
        {btn('复制', <Copy size={12} />, onCopy)}
        {onQuote ? btn('引用', <Quote size={12} />, onQuote) : null}
        {onEdit ? btn('编辑重发', <Pencil size={12} />, onEdit) : null}
        {onRegenerate ? btn('重新生成', <RotateCcw size={12} />, onRegenerate) : null}
        {onBranch ? btn('分支', <GitBranch size={12} />, onBranch) : null}
        {onFeedback ? btn('不错', <ThumbsUp size={12} />, () => onFeedback(true)) : null}
        {onFeedback ? btn('有问题', <ThumbsDown size={12} />, () => onFeedback(false)) : null}
      </div>
      {/* 收拢：不够宽时只剩一个「⋯」，元信息行因此永远单行 */}
      <div className='flex items-center @min-[860px]:hidden'>
        <Menu
          align={align === 'right' ? 'end' : 'start'}
          side='top'
          items={entries}
          trigger={(
            <button
              type='button'
              aria-label='更多操作'
              title='更多操作'
              className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:bg-hover hover:text-ink'
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        />
      </div>
    </div>
  )
}
function UserMessage({ item }: { item: UserChatItem }) {
  /// v1.7：parts.bubbles.user —— 用户气泡的圆角 / 阴影（内联样式覆盖内置 rounded-[18px] 等）。
  const userBubble = useThemeParts()?.bubbles?.user
  const setDraft = useSession((s) => s.setDraft)
  const addQuote = useSession((s) => s.addQuote)
  const editAndResend = useSession((s) => s.editAndResend)
  const branchFrom = useSession((s) => s.branchFrom)

  /* ── 附件与引用的两条来源 ──
     ① 结构化字段（item.attachments / item.quotes）：新协议发出的消息、或引擎历史里带的，
        由 stores/session.ts 的 useChatItems 挂到条目上；
     ② 旧消息：当年是把「> 引用」与「附件：<路径>」**拼进正文**的，这里在渲染层把它们
        升级成引用块与附件卡片，并把正文还原成用户真正打的那段字。
     structured 标记表示「这条是新协议发的」：正文里出现「> 」只是用户自己写的引用，不能误升级。 */
  const legacyQuotes = item.structured ? { body: item.text, quotes: [] as string[] } : parseLegacyQuotes(item.text)
  const legacyFiles = item.structured ? { body: legacyQuotes.body, attachments: [] as AttachmentRef[] } : parseLegacyAttachments(legacyQuotes.body)
  /// 正文：升级后剩下的那一段（旧消息不再显示「附件：…」这些机器拼上去的行）。
  const body = legacyFiles.body
  const quotes: QuoteRef[] = item.quotes?.length
    ? item.quotes
    : legacyQuotes.quotes.map((text, index) => ({ id: 'legacy-q' + index, text }))
  const attachments: AttachmentRef[] = item.attachments?.length ? item.attachments : legacyFiles.attachments

  const edit = async (): Promise<void> => {
    if (!item.msgId) { setDraft(body); return }
    const next = await promptText({
      title: '编辑后重新发送',
      description: '这条之后的内容会被移除，并从这里重新回答。',
      value: body,
      multiline: true,
      confirmLabel: '重新发送',
    })
    if (next === null) return
    if (!next.trim()) { toast.error('内容不能为空'); return }
    try { await editAndResend(item.msgId, next) }
    catch (e) { toast.error('重发失败：' + (e instanceof Error ? e.message : String(e))) }
  }

  /// 右键菜单：接管浏览器原生菜单，给消息自己的操作。
  const userMenu = (): CtxItem[] => [
    { label: '复制', onSelect: () => { void navigator.clipboard.writeText(body); toast.success('已复制') } },
    { label: '引用到输入框', onSelect: () => addQuote({ text: body, msgId: item.msgId, at: item.at }) },
    ...(item.msgId ? [{ label: '编辑重发', onSelect: () => void edit() }] : []),
    ...(item.msgId ? [{ label: '从这里分支', onSelect: () => void branchFrom(item.msgId as string).catch(() => {}) }] : []),
  ]

  return (
    <div
      className='workbench-msg workbench-msg-user group/msg mx-auto flex w-full max-w-[var(--content-w)] flex-col items-end py-3 pl-4 pr-2'
      onContextMenu={(e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, userMenu()) }}
    >
      {/* 引用 → 正文 → 附件：与发送时的语义顺序一致，气泡本身还是原来那一个。 */}
      <div className='flex w-full max-w-[82%] flex-col items-end gap-1.5'>
        {quotes.length ? (
          <div className='flex w-full flex-col gap-1'>
            {quotes.map((quote, index) => (
              <QuoteBlock key={quote.id || 'quote-' + index} text={quote.text} msgId={quote.msgId} at={quote.at} className='w-full' />
            ))}
          </div>
        ) : null}
        {body ? (
          <div
            className='sel-text max-w-full rounded-[18px] rounded-tr-[6px] border border-bubble-user-line bg-bubble-user px-3.5 py-2 text-13 leading-[1.7] whitespace-pre-wrap text-bubble-user-ink'
            style={userBubble ? {
              borderRadius: userBubble.radius != null ? userBubble.radius + 'px' : undefined,
              boxShadow: userBubble.shadow ?? undefined,
            } : undefined}
          >
            {body}
          </div>
        ) : null}
        {attachments.length ? (
          <div className='flex w-full flex-wrap justify-end gap-1.5'>
            {attachments.map((file, index) => (
              <AttachmentCard
                key={file.path || 'file-' + index}
                path={file.path}
                name={file.name}
                size={file.size}
                className='max-w-full'
              />
            ))}
          </div>
        ) : null}
      </div>
      {/* 元信息与操作并排一行，避免在消息和下一段之间留出空档。
          与助手那条同一套规矩：@container 判**列宽**（不是窗口宽度）、永远单行、
          宽度不够把操作收进「⋯」；时间永不隐藏也不折行。 */}
      <div className='@container mt-1 w-full'>
        <div data-msg-meta className='flex w-full flex-nowrap items-center justify-end gap-2'>
          <div className='flex min-w-0 flex-nowrap items-center gap-2 text-11 text-ink-4'>
            {/* 运行中插话：这条已经发给引擎、排在本轮后面等它跑完（引擎开跑时标记被摘掉）。 */}
            {item.queued ? (
              // 排队徽标也一样走真弹性：它是「刚被放进来的一条」，弹一下才读得出「新增」，
              // 平铺淡入看起来像本来就在那儿。
              <Pop className='inline-flex shrink-0'>
                <span className='flex items-center gap-1 whitespace-nowrap rounded-full border border-primary/30 bg-primary-soft px-1.5 py-0.5 text-10 text-primary'>
                  <Clock3 size={9} className='shrink-0' />
                  排队中
                </span>
              </Pop>
            ) : null}
            {item.at ? <span data-msg-time className='shrink-0 whitespace-nowrap tabular-nums'>{fmtTime(item.at)}</span> : null}
          </div>
          <MsgActions
            align='right'
            onCopy={() => { void navigator.clipboard.writeText(body); toast.success('已复制') }}
            onQuote={() => addQuote({ text: body, msgId: item.msgId, at: item.at })}
            onEdit={() => void edit()}
            onBranch={item.msgId ? () => { void branchFrom(item.msgId as string).then(() => toast.success('已从这条消息分出新的对话')).catch((e) => toast.error('分支失败：' + String(e))) } : undefined}
          />
        </div>
      </div>
    </div>
  )
}
/* ── 助手消息尾部的运行态小标记（三态，对标 DSH 的回复状态）──
   · 流式中 —— 呼吸点：与左侧会话列表的「运行中」同一套（animate-pulse + bg-primary +
     data-loop-anim），不新写 keyframes；动效关 / 系统减少动态时 base.css 把它停成静态点，
     「还在生成」的信息仍在（与 TypingDots 同一降级口径）；
   · 落定 —— 什么都不画（spec 允许「对勾/无」：对勾留给 ToolMark 那种单次状态，
     历史消息每行挂对勾是噪音）；
   · 中断 —— 斜杠（Slash，warn 色）：比底部那条「已中断」提示条更早被扫到，且不占那行的位置。
   中断是全局本轮态（stores/session.ts 的 interrupted），只该出现在**最后一条**助手消息上，
   所以调用方传 interrupted && isLast。 */
function RunStateMark({ streaming, interrupted }: { streaming: boolean; interrupted: boolean }) {
  if (!streaming && !interrupted) return null
  if (streaming) {
    return (
      <span aria-hidden title='生成中' className='inline-flex shrink-0'>
        <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-primary' data-loop-anim />
      </span>
    )
  }
  return (
    <span aria-hidden title='已中断' className='inline-flex shrink-0 items-center'>
      <Slash size={11} className='text-warn' />
    </span>
  )
}

function AssistantMessage({ item, isLast, modelLabel, fresh, toolFresh, artifacts }: {
  item: Extract<ChatItem, { kind: 'assistant' }>
  /** 本轮产出的文件（turn_end 的 artifacts 字段，见 stores/artifacts）：
      只挂在列表里**最后一条有正文的回复**下面，历史回复一律传 undefined —— 卡片只属于刚跑完的这一轮。
      没产出时是 undefined（调用方算好的），这里因此连一个空容器都不渲染。 */
  artifacts?: TurnArtifact[]
  /** 是不是列表里最后那条助手消息（本轮的耗时 / 速度 / 操作条只挂在它上面）。
      传**布尔值**而不是「上一条本身」：条目对象每次提交都会重折一份新的，
      传对象等于给所有助手条目发一张每次都会变的 prop，memo 就白加了。 */
  isLast: boolean
  modelLabel: string
  /** 这一条消息是不是这次才出现的（决定「正在思考…」「已中断」这类条目的入场）。 */
  fresh: boolean
  /** 工具行是不是这次才出现的：切回会话 / 重挂载的旧工具行不得重播入场。 */
  toolFresh: (callId: string) => boolean
}) {
  const addQuote = useSession((s) => s.addQuote)
  const regenerate = useSession((s) => s.regenerate)
  const branchFrom = useSession((s) => s.branchFrom)
  const turnMeta = useSession((s) => s.turnMeta)
  const interrupted = useSession((s) => s.interrupted)
  const send = useSession((s) => s.send)
  // 只给“最后一条助手消息”挂本轮的耗时/速度，历史消息不重复显示。
  // 只有出现真正的正文才挂元信息/操作；流式期间常见「只有空白字符」的片段，
  // 那时它就会错挂到「已思考」那一行下面。
  const hasText = item.text.trim().length > 0
  /* ── 过程 / 答案分离（照搬 DSH 的 Turn process 模型）──
     **最后一段正文 = 答案**，它之前的一切（思考 / 叙述 / 工具）= 过程。
     答案独立在后、永不参与折叠，所以生成中途从「纯思考」变成「思考 + 正文」时位置不翻转；
     用了工具的轮次也不会再把思考整段吞掉（旧实现走的是另一条分支，思考直接不渲染）。
     判据放在 lib/chat.ts 的 splitProcessAnswer —— 纯逻辑，node 可以单跑（tests/check-*.mjs）。 */
  const { answer, members } = splitProcessAnswer(item)
  const hasAnswer = answer.trim().length > 0
  const hasProcess = members.length > 0 || item.reasoning.trim().length > 0 || item.tools.length > 0
  /// 元信息行的时间：本条的落库时间；最后一条还没落库时用本轮的结束时间。
  const atMs = item.at ?? (isLast && turnMeta ? turnMeta.endedAt : undefined)
  /// 模型名**永不隐藏**：宽度不够时只截断（title 给全名），不折行、也不整段消失。
  const modelName = (isLast && turnMeta ? turnMeta.model : '') || modelLabel

  /// v1.7：parts.bubbles.assistant —— 助手正文容器的圆角 / 阴影（内联样式覆盖）。
  const assistantBubble = useThemeParts()?.bubbles?.assistant

  const assistantMenu = (): CtxItem[] => [
    { label: '复制回复', onSelect: () => { void navigator.clipboard.writeText(item.text); toast.success('已复制') } },
    { label: '引用到输入框', onSelect: () => addQuote({ text: item.text, msgId: item.msgId, at: item.at }) },
    ...(item.msgId ? [{ label: '重新生成', onSelect: () => void regenerate(item.msgId as string).catch(() => {}) }] : []),
    ...(item.msgId ? [{ label: '从这里分支', onSelect: () => void branchFrom(item.msgId as string).catch(() => {}) }] : []),
  ]

  /* 顺序段的渲染搬进了 ProcessBlock：过程成员（叙述 / 工具组）在那里按事件先后铺开，
     **顺序仍然就是事件顺序**，只是整块折在答案上方。
     这里不再自己拼 segments —— 两份实现会让「段的位置」与「折叠归属」再次分叉。 */

  return (
    <div
      className='workbench-msg workbench-msg-assistant group/msg mx-auto flex w-full max-w-[var(--content-w)] flex-col py-3 pl-2 pr-4'
      onContextMenu={(e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, assistantMenu()) }}
    >
      <div className='flex min-w-0 items-start gap-2.5'>
        {/* 助手头像：插件主题 mascot.avatar 的替换挂点 —— 引擎把原 src 缓存进
            dataset.themeOrig 再换上插件图，卸载 / 清空主题时恢复默认 logo。 */}
        <img
          data-theme-mascot='avatar'
          src={assistantAvatar}
          alt=''
          draggable={false}
          className='workbench-avatar mt-[3px] h-6 w-6 shrink-0 rounded-full bg-line/40 object-contain p-[3px]'
        />
        <div className='min-w-0 flex-1'>
        {/* ── 顺序固定为：过程（思考 + 叙述 + 工具）→ 答案 → 生成物 → 元信息 ──
            ① 过程在前：它整块折在答案**上方**（对标 DSH 的 Turn process）。
               旧实现把这一块挂在正文下方，与本文件早先写下的顺序注释正好相反。 */}
        {hasProcess ? (
          <ProcessBlock
            reasoning={item.reasoning}
            reasoningStreaming={!!item.reasoningStreaming}
            tools={item.tools}
            members={members}
            live={item.streaming}
            toolFresh={toolFresh}
            renderTool={renderToolRow}
            enter={enterProps(item.tools.some((t) => toolFresh(t.callId)))}
          />
        ) : null}
        {/* ② 答案：最后一段正文。**始终可见** —— 它不是过程成员，折叠开合动不了它。
            正文限制在阅读宽度（--reading-w），代码块在 Markdown 内部自行放宽到 --content-wide-w。 */}
        {hasAnswer ? (
          <div
            className='min-w-0 max-w-[var(--reading-w)]'
            style={assistantBubble ? {
              borderRadius: assistantBubble.radius != null ? assistantBubble.radius + 'px' : undefined,
              boxShadow: assistantBubble.shadow ?? undefined,
            } : undefined}
          >
            <Markdown text={answer} streaming={item.streaming} />
          </div>
        ) : null}
        {/* 生成物卡片：**最后一条有正文的回复**下面列出本轮产出的文件（入口在下面工具行之后，
            与正文 + 元信息行同一条阅读动线）。artifacts 为空时这一块只做一次判断，
            ArtifactList 返回 null —— 不画空态、不留占位，上下间距与以前完全一样。 */}
        {hasText && artifacts?.length ? <ArtifactList items={artifacts} /> : null}
        {/* 生成中的存活信号：只要这条还在流式，三点就挂在**内容末尾**。
            有正文 = 正文 + 三点；没正文也没工具 = 三点单独顶着（不再另写「正在思考…」，
            否则同一个存活信号会在同一处出现两遍）。reduced-motion 下三点退化为静态，信息仍在。 */}
        {item.streaming ? (
          <m.div className={cn('flex items-center gap-2 text-12 text-ink-3', hasText && 'mt-1')} {...enterProps(fresh)}>
            <TypingDots />
          </m.div>
        ) : null}
        {/* 元信息行搬到了这条消息的**最后**：原来是「思考 → 元信息 → 正文」，
            模型名 / 耗时 / 操作条夹在思考内容与答案中间（用户报的 bug）。
            顺序固定为：思考 → 正文 → 工具 → 生成物卡片 → 元信息 + 操作。
            只挪位置：宽度参照物（外层 min-w-0 flex-1）没变，@container 的列宽语义
            与「tok → tok/s → 耗时 → ⋯」的优先级收纳规则全部照旧。 */}
        {/* 元信息与操作只跟随「回复正文」：没有正文（纯工具调用）时不显示，
            避免出现「工具卡下面挂着模型名和复制按钮」的错位感。 */}
        {/* ── 元信息行：**永远单行** ──
            ① 它**不在正文的阅读宽度容器里**：正文继续由 --reading-w 限宽，
               这一行和操作条吃的是**列宽 --content-w**，两件事互不影响
               （窄列下把元信息挤进 reading-w 正是折行的来源）。
            ② 这一层是容器查询的参照物（@container），下面的断点判的是**它的宽度**，
               不是窗口宽度 —— 侧栏 / 会话列表开合、消息列宽度档位变化都算数。
            ③ 宽度不够**按优先级收**：tok → tok/s → 耗时 / 首 token，最后把操作收进「⋯」；
               **时间与模型名永不隐藏**（模型名只截断）。 */}
        {hasText ? (
          <div className='@container mt-1 w-full'>
            <div data-msg-meta className='flex w-full flex-nowrap items-center gap-2'>
              <div className='flex min-w-0 flex-nowrap items-center gap-2 text-11 text-ink-4'>
                {/* 三态运行标记（见 RunStateMark）：流式中＝呼吸点；落定＝不渲染；中断＝斜杠。 */}
                <RunStateMark streaming={item.streaming} interrupted={interrupted && isLast} />
                {/* 时间：永不隐藏、绝不折行；tabular-nums 让秒数跳动时这一行不左右抖。 */}
                {atMs ? <span data-msg-time className='shrink-0 whitespace-nowrap tabular-nums'>{fmtTime(atMs)}</span> : null}
                {/* 模型名：永不隐藏。max-w-[12rem] + truncate，全名在 title 里。 */}
                <span data-msg-model title={modelName} className='min-w-0 max-w-[12rem] truncate'>{modelName}</span>
                {/* 首 token 延迟与生成耗时**分开**显示：一个回答「多久开的口」，
                    一个回答「说了多久」。两个数字都只认引擎口径（见 lib/chat.ts），
                    取不到或越界时 fmtDuration 给「—」，不再拿挂钟差值硬凑一个数。
                    这两项属于同一个优先级档（「耗时」），窄到放不下时与 tok/s、tok 一起收。 */}
                {isLast && turnMeta ? <span className='hidden shrink-0 whitespace-nowrap tabular-nums @min-[520px]:inline'>首 token {fmtDuration(turnMeta.firstTokenMs)}</span> : null}
                {isLast && turnMeta ? <span className='hidden shrink-0 whitespace-nowrap tabular-nums @min-[520px]:inline'>生成 {fmtDuration(turnMeta.generationMs)}</span> : null}
                {isLast && turnMeta?.outputTokensPerSecond ? <span className='hidden shrink-0 whitespace-nowrap tabular-nums @min-[560px]:inline'>{turnMeta.outputTokensPerSecond.toFixed(0)} tok/s</span> : null}
                {isLast && turnMeta?.totalTokens ? <span className='hidden shrink-0 whitespace-nowrap tabular-nums @min-[600px]:inline'>{fmtTokens(turnMeta.totalTokens)} tok</span> : null}
              </div>
              <span className='min-w-0 flex-1' />
              <MsgActions
                align='left'
                onCopy={() => { void navigator.clipboard.writeText(item.text); toast.success('已复制') }}
                onQuote={() => addQuote({ text: item.text, msgId: item.msgId, at: item.at })}
                onRegenerate={item.msgId ? () => { void regenerate(item.msgId as string).catch((e) => toast.error('重新生成失败：' + String(e))) } : undefined}
                onBranch={item.msgId ? () => { void branchFrom(item.msgId as string).then(() => toast.success('已从这里分支')).catch((e) => toast.error('分支失败：' + String(e))) } : undefined}
                onFeedback={(good) => {
                  try {
                    const list = JSON.parse(localStorage.getItem('coomi.feedback.v1') ?? '[]') as unknown[]
                    list.push({ at: Date.now(), good, text: item.text.slice(0, 400) })
                    localStorage.setItem('coomi.feedback.v1', JSON.stringify(list.slice(-200)))
                  } catch { /* 忽略 */ }
                  toast.success(good ? '已记录：这条不错' : '已记录：这条有问题')
                }}
              />
            </div>
          </div>
        ) : null}
        </div>
      </div>
      {/* 中断提示条：rise 入场，别突然冒出来 */}
      {isLast && interrupted ? (
        <m.div className='mt-1.5 flex items-center gap-2 rounded-lg border border-line bg-muted px-3 py-1.5 text-12 text-ink-3' {...enterProps(fresh)}>
          <span className='h-1.5 w-1.5 rounded-full bg-warn' />
          <span>已中断</span>
          <span className='flex-1' />
          <button
            type='button'
            className='rounded px-2 py-0.5 text-primary transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:bg-primary-soft'
            onClick={() => send('继续')}
          >
            继续生成
          </button>
        </m.div>
      ) : null}
    </div>
  )
}
/* ── 重试倒计时（对标 DSH 的 ModelRetryItem）──
   渲染时锚定：组件挂载 / key（新的 attempt 或 delayMs）变化那一刻定死 deadline = Date.now() + delayMs，
   之后每秒减一次，纯本地读数、**不触发任何请求**。
   为什么不能每帧都重算 Date.now() + delayMs：任何一次无关重渲染（tick 触发的 setState 也是）
   都会把 deadline 往后挪，倒计时就永远走不完 —— 所以 deadline 只在 key 变化时由 effect 重锚。 */
/** 引擎给的重试上限：255 表示「无限」（引擎 provider_retry_count 哨兵语义），显示成 ∞。 */
function retryMaxLabel(maxAttempts: number): string {
  return maxAttempts === 255 ? '∞' : String(maxAttempts)
}

function useRetryCountdown(delayMs: number | null, key: string): number {
  const [remaining, setRemaining] = useState(delayMs == null ? 0 : Math.max(0, Math.ceil(delayMs / 1000)))
  useEffect(() => {
    if (delayMs == null) { setRemaining(0); return }
    // key 变 = 新的等待窗口（connection_retry 每来一次就是一次新退避）：重新锚定再从头减。
    const deadline = Date.now() + delayMs
    const tick = (): void => {
      setRemaining((prev) => {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
        return prev === left ? prev : left
      })
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [delayMs, key])
  return remaining
}

function Notice({ item, live, fresh, lastErrorNoticeId }: {
  item: Extract<ChatItem, { kind: 'notice' }>
  live?: boolean
  fresh: boolean
  /** 列表里最新那条错误条的 **id**（'' ＝ 一条都没有）：重试倒计时的兜底只挂在这条上。 */
  lastErrorNoticeId: string
}) {
  const retryLast = useSession((s) => s.retryLast)
  const error = item.tone === 'error'
  /// 数据层同事新增的字段，这里**只消费、不在 lib/chat.ts 定义**：
  /// resolved —— 本轮后续成功吸收了该错误（渲染降级，但条目保留、可追溯）；
  /// rateLimited —— 上游 429 / 限流（错误条内加提示与重试建议）。
  /// 字段还没进类型定义，用局部窄化读取；同事合入类型后这几行原样可留。
  const resolved = Boolean((item as { resolved?: boolean }).resolved)
  const rateLimited = Boolean((item as { rateLimited?: boolean }).rateLimited)
  /// 重试倒计时数据源：retryInfo（chat.ts 挂的 per-card 数据）优先；兜底会话层 retrying ——
  /// stores/session.ts 的 connection_retry 分支只写全局态、不把事件送进消息管线（连接层不动，
  /// 由并行同事维护），所以生产环境里倒计时实际从 retrying 读；全局态一次只属于**最新那条**
  /// 错误条（lastErrorNoticeId 由列表层算好传下来），历史错误卡不挂倒计时。
  const retrying = useSession((s) => s.retrying)
  const retrySource = item.retryInfo
    ? { attempt: item.retryInfo.attempt, maxAttempts: item.retryInfo.maxAttempts, delayMs: item.retryInfo.delayMs ?? null }
    : retrying && error && !resolved && item.id === lastErrorNoticeId
      // delayMs 用 ?? 而不是 ||：0 是「立刻重试」（倒计时直接显示「正在重试…」），
      // 不是「缺失」——与上面 retryInfo 那条路径的 ?? null 同一口径。
      ? { attempt: retrying.attempt, maxAttempts: retrying.max, delayMs: retrying.delayMs ?? null }
      : null
  /// key 换新（新的 attempt / delayMs）＝新的等待窗口，重新锚定再从头减（见 useRetryCountdown）。
  const retryRemaining = useRetryCountdown(
    retrySource?.delayMs ?? null,
    retrySource ? retrySource.attempt + ':' + (retrySource.delayMs ?? 0) : 'none',
  )
  /// 已恢复的错误卡默认只露一行摘要，点开看完整文案。
  const [detailsOpen, setDetailsOpen] = useState(false)
  /// 压缩卡：引擎只在压缩真的发生时给一条 notice（没有「开始压缩」事件），
  /// 所以点阵只在它刚出现、本轮还在跑的时候收拢，之后落成一个静态点。
  const compacted = !error && item.text.startsWith('上下文已压缩')
  return (
    <div className='mx-auto w-full max-w-[var(--content-w)] px-6 py-2'>
      {/* 提示卡 / 错误卡入场：8px 的 rise，不闪不跳。
          已恢复的错误走**降级样式**：muted 色调 + 小一号字，不用错误红（错误已被本轮吸收）。 */}
      <m.div
        className={cn(
          'flex items-start gap-2 rounded-lg border px-3 py-2',
          resolved ? 'border-line bg-muted text-11 text-ink-3'
            : error ? 'border-danger/30 bg-danger-soft text-12 text-danger'
              : 'border-line bg-muted text-12 text-ink-3',
        )}
        {...enterProps(fresh)}
      >
        {resolved ? (
          /* 已恢复用对勾示意「这一关过了」：muted 色，不抢注意力。 */
          <Check size={13} className='mt-0.5 shrink-0 text-ink-4' />
        ) : compacted ? (
          <AgentState state={live ? 'compacting' : 'idle'} size='xs' tone='primary' className='mt-0.5' />
        ) : error ? (
          <AlertTriangle size={13} className='mt-0.5 shrink-0' />
        ) : (
          <Sparkles size={13} className='mt-0.5 shrink-0' />
        )}
        {resolved ? (
          /* 可点击展开详情：默认一行摘要（line-clamp-1），点开看完整文案。
             错误真实发生过，不从列表移除，留痕可追溯。 */
          <button
            type='button'
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen(!detailsOpen)}
            className={cn('sel-text min-w-0 flex-1 text-left', detailsOpen ? '' : 'line-clamp-1')}
          >
            <span className='text-ink-4'>（已恢复）</span> {item.text}
            {rateLimited ? <RateLimitedTag muted /> : null}
          </button>
        ) : (
          <span className='sel-text min-w-0 flex-1'>
            <span className='flex items-start gap-1'>
              {friendlyErrorText(item)}
              {rateLimited ? <RateLimitedTag /> : null}
            </span>
            {/* 限流建议：文案说明即可；重试按钮照旧可点。倒计时在场时用倒计时替掉它（两者同义）。 */}
            {rateLimited && !retrySource ? (
              <span className='mt-1 block text-11 text-ink-4'>建议等待后重试</span>
            ) : null}
            {/* 重试倒计时：数据源与锚定见 useRetryCountdown / retrySource 的说明。
                引擎没给 delay（retry_confirmation 的 delay_ms 可缺）时不倒数、只显示第 X/Y 次；
                倒计时走到 0 显示「正在重试…」，不假装还在倒数。 */}
            {retrySource ? (
              <span className='mt-1 block text-11 text-ink-4'>
                {retrySource.delayMs == null
                  ? '自动重试中（第 ' + retrySource.attempt + '/' + retryMaxLabel(retrySource.maxAttempts) + ' 次）'
                  : retryRemaining > 0
                    ? <>将在 <span className='font-medium tabular-nums'>{retryRemaining}</span> 秒后自动重试（第 {retrySource.attempt}/{retryMaxLabel(retrySource.maxAttempts)} 次）</>
                    : '正在重试…'}
              </span>
            ) : null}
          </span>
        )}
        {error && !resolved ? (
          <div className='flex shrink-0 items-center gap-1'>
            {/* 「继续这一轮」：本轮是被上游中断/工具轮次用尽打断的（不是用户停的），
                点它就把「继续」作为新一轮发出去，接着原任务往下跑。 */}
            {item.resume ? (
              <Button variant='secondary' size='sm' onClick={() => useSession.getState().resumeInterruptedTurn()}>
                <Play size={12} /> 继续这一轮
              </Button>
            ) : null}
            {item.retryable ? (
              <Button variant='ghost' size='sm' onClick={() => void retryLast()}><RefreshCw size={12} /> 重试</Button>
            ) : null}
            <Button variant='ghost' size='sm' onClick={() => useUi.getState().setView('settings')}>换模型</Button>
            <Button
              variant='ghost' size='sm'
              onClick={() => { void ipc<string | null>('engine_log_path').then((p) => { if (p) void ipc('open_path', { path: p }) }) }}
            >
              看日志
            </Button>
          </div>
        ) : null}
      </m.div>
    </div>
  )
}

/** 「上游限流」小角标：错误条内的小提示，不改变卡片底色。
 *  错误卡 = danger 色；已恢复卡（muted 色调）用中性色，避免红色角标抢注意力。 */
function RateLimitedTag({ muted }: { muted?: boolean }) {
  return muted
    ? <span className='shrink-0 rounded bg-sunken px-1 py-px text-10 text-ink-4'>上游限流</span>
    : <span className='shrink-0 rounded bg-danger/10 px-1 py-px text-10 font-medium'>上游限流</span>
}

/* ── 拖选文字后的浮条：引用 / 提问 / 复制 ──
   定位用「选区那一帧的 client 坐标」，并且 **portal 挂到 body**：
   留在消息树里的话，带 transform 的祖先（motion 的行容器）会成为 position: fixed 的包含块，
   left/top 按视口算、却按那个祖先的坐标系摆，浮条就跑到别的地方去了；portal 出去顺带也躲开了
   消息区的 overflow 裁剪。
   滚动不追着浮条跑：一滚就收起（消息容器内部的滚动也算，scroll 不冒泡、只能挂捕获阶段），
   于是不存在「浮条停在旧坐标」的问题。收起统一走 .fade-exit（--motion-fast 档淡出）。 */
/** 退场窗口（ms）：必须 ≥ --motion-fast。JS 读不到 CSS 变量，所以这里写数，
 *  但它跟 ContextMenuHost 的 EXIT_MS 是同一条约束——改 --motion-fast 就得同步改，
 *  否则浮条会在淡出还没播完时被摘掉（看起来就是「啪」地消失）。 */
const TOOLBAR_EXIT_MS = 140

function SelectionToolbar() {
  const addQuote = useSession((s) => s.addQuote)
  const focusComposer = useUi((s) => s.focusComposer)
  const [box, setBox] = useState<{ x: number; y: number; text: string } | null>(null)
  const [closing, setClosing] = useState(false)
  const bar = useRef<HTMLDivElement | null>(null)
  /// 浮条是不是「在场上」：淡出那 TOOLBAR_EXIT_MS 里它还得渲染着，但不能重复再收一次。
  const live = useRef(false)
  const exitTimer = useRef<number | null>(null)

  const hide = useCallback((): void => {
    if (!live.current) return
    live.current = false
    setClosing(true)
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current)
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null
      setClosing(false)
      setBox(null)
    }, TOOLBAR_EXIT_MS)
  }, [])

  const show = useCallback((next: { x: number; y: number; text: string }): void => {
    if (exitTimer.current !== null) { window.clearTimeout(exitTimer.current); exitTimer.current = null }
    live.current = true
    setClosing(false)
    setBox(next)
  }, [])

  useEffect(() => {
    /// Esc 之后按着的那个选区：keyup 会紧跟着再来一次 refresh，不记住它就会「按下 Esc 又弹回来」。
    /// 下一次按下鼠标（新的一次划选）就作废。
    let escaped = ''

    /// 现在的选区撑不撑得起一条浮条：折叠 / 太短 / 量不到矩形都算不行。
    const read = (): { x: number; y: number; text: string } | null => {
      const sel = window.getSelection()
      const text = sel?.toString().trim() ?? ''
      if (!sel || sel.isCollapsed || !sel.rangeCount || text.length < 2) return null
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (!rect.width && !rect.height) return null
      return { x: rect.left + rect.width / 2, y: rect.top, text }
    }
    const refresh = (): void => {
      const sel = window.getSelection()
      if (escaped && sel?.toString().trim() === escaped) return
      const next = read()
      if (next) show(next)
      else hide()
    }

    /// 点选区外面收起：点在选区内（微调选区）和点在浮条上都不算「外面」。
    const insideSelection = (x: number, y: number): boolean => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return false
      for (const rect of Array.from(sel.getRangeAt(0).getClientRects())) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true
      }
      return false
    }
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (target && bar.current?.contains(target)) return
      escaped = ''
      if (insideSelection(e.clientX, e.clientY)) return
      hide()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      escaped = window.getSelection()?.toString().trim() ?? ''
      hide()
    }
    /// 选区一折叠就收起（在别处点一下、引用完 removeAllRanges 都会走到这里）。
    const onSelectionChange = (): void => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount || sel.toString().trim().length < 2) hide()
    }
    const onScroll = (): void => hide()

    document.addEventListener('mouseup', refresh)
    document.addEventListener('keyup', refresh)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKey)
    document.addEventListener('selectionchange', onSelectionChange)
    /// 捕获阶段挂 scroll（passive）：滚动事件不冒泡，只有捕获才收得到消息容器内部的滚动。
    document.addEventListener('scroll', onScroll, { passive: true, capture: true })
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mouseup', refresh)
      document.removeEventListener('keyup', refresh)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current)
    }
  }, [hide, show])

  if (!box) return null
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    fn()
    hide()
    window.getSelection()?.removeAllRanges()
  }

  return createPortal(
    <div
      ref={bar}
      data-side='top'
      className={cn(
        'fixed z-50 flex -translate-x-1/2 -translate-y-[calc(100%+8px)] items-center gap-0.5 rounded-lg border border-line bg-surface p-1 shadow-menu',
        closing ? 'fade-exit' : 'pop-surface',
      )}
      style={{ left: box.x, top: Math.max(box.y, 48) }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* 引用 / 提问都只往输入框加一枚引用芯片，**不再把文字拼进正文**：
          正文始终是用户自己打的那段话，引用作为结构化字段随消息一起发出去。
          提问额外把光标交给输入框——用户的下一步就是打字。 */}
      <Button variant='ghost' size='sm' onClick={act(() => addQuote({ text: box.text }))}><Quote size={13} /> 引用</Button>
      <Button variant='ghost' size='sm' onClick={act(() => { addQuote({ text: box.text }); focusComposer() })}><Sparkles size={13} /> 提问</Button>
      <Button variant='ghost' size='sm' onClick={act(() => { void navigator.clipboard.writeText(box.text); toast.success('已复制') })}><Check size={13} /> 复制</Button>
    </div>,
    document.body,
  )
}

/** 一条消息的全部可搜文本：命中数在数据层统计（窗口里可能没有全部命中）。 */
function searchableText(item: ChatItem): string[] {
  if (item.kind === 'user') return [item.text]
  if (item.kind === 'reminder') return [item.text]
  if (item.kind === 'notice') return [item.text]
  // 提问卡：问题正文 + 你当时选了什么，都该被搜到。
  if (item.kind === 'ask') return [item.prompt, ...item.questions.map((q) => q.question)]
  const out = [item.text, item.reasoning]
  for (const tool of item.tools) out.push(tool.name, tool.args, tool.preview ?? '')
  return out
}

/** 属性选择器里的值转义：消息 id 一般是 uuid，但别假设它一定是。 */
function attrValue(id: string): string {
  return id.replace(/["\\]/g, '\\$&')
}

/** 引擎注入的**目标复述**：不是用户消息，画成一条安静的系统细线。
 *
 *  为什么要有这个东西：引擎每 6 轮把「原始目标 + 未完成的计划步骤」推回上下文尾部（防止长任务跑偏）。
 *  它带的是 user 角色，前端以前不认识内部的 `internal` / `reminder` 标记，就当成用户消息画了出来 ——
 *  表现是对话里突然冒出一条「用户：<goal-reminder> 原始目标……」的气泡，像用户自己发了条控制台指令。
 *  现在按机器可读标记渲染成系统行，默认只占一行（每 6 轮来一次，全展开会把对话冲乱）。
 *  发给模型的上下文一个字节都没改。 */
function ReminderNote({ item }: { item: Extract<ChatItem, { kind: 'reminder' }> }) {
  const [open, setOpen] = useState(false)
  const label = item.label === 'goal' ? '目标提醒' : item.label
  return (
    <div data-reminder={item.label} className='mx-auto flex w-full max-w-[var(--content-w)] flex-col py-1 pl-2 pr-4'>
      <button
        type='button'
        onClick={() => { markCollapseMotion(); setOpen((v) => !v) }}
        aria-expanded={open}
        className='flex w-fit items-center gap-1.5 rounded-md px-1.5 py-0.5 text-11 text-ink-4 transition-colors hover:text-ink-3'
      >
        <Sparkles size={11} className='shrink-0' />
        <span>{label} · 引擎自动注入</span>
        <m.span className='inline-flex shrink-0' initial={false} animate={{ rotate: open ? 90 : 0 }} transition={toggleTransition()}>
          <ChevronRight size={11} />
        </m.span>
      </button>
      <div className='collapse' data-open={open}>
        <div>
          <div className='mt-1 max-h-[30vh] overflow-y-auto border-l border-line pl-2.5 text-11 leading-[1.7] whitespace-pre-wrap break-words text-ink-4'>
            {item.text}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 单条消息：index 写在 data-msg-index 上，会话内搜索跳转后要靠它找回这一条的 DOM 挂高亮。 */
function ChatRow({ item, index, fromEnd, lastAssistantId, lastErrorNoticeId, modelLabel, streaming, fresh, toolFresh, artifacts }: {
  item: RenderItem
  index: number
  fromEnd: number
  /** 列表里最后那条助手条目的 **id**（'' ＝ 一条都还没有）。见 AssistantMessage 的同名说明。 */
  lastAssistantId: string
  /** 列表里最新那条错误条的 **id**（'' ＝ 一条都还没有）：Notice 的倒计时兜底只认它。 */
  lastErrorNoticeId: string
  modelLabel: string
  streaming: boolean
  /** 本次渲染才首次出现的条目：只有它值得播入场。 */
  fresh: boolean
  /** 工具行级别的「首次出现」，透传给 AssistantMessage。 */
  toolFresh: (callId: string) => boolean
  /** 本轮产出（同 AssistantMessage.artifacts）：只有最后那条助手条目拿得到，其余传 undefined。
      这个 prop 与 items 无关，所以历史条目不会因为「卡片换了」而重渲染。 */
  artifacts?: TurnArtifact[]
}) {
  const body =
    item.kind === 'user' ? <UserMessage item={item} />
      : item.kind === 'reminder' ? <ReminderNote item={item} />
      : item.kind === 'assistant' ? <AssistantMessage item={item} isLast={item.id === lastAssistantId} modelLabel={modelLabel} fresh={fresh} toolFresh={toolFresh} artifacts={artifacts} />
        : item.kind === 'ask' ? <AskUserCard item={item} />
          : <Notice item={item} live={fromEnd === 0 && streaming} fresh={fresh} lastErrorNoticeId={lastErrorNoticeId} />

  // 入场只给「新到的末尾三条」：历史回读整屏挂载时不会一屏消息依次冒出来。
  // 元素类型只由全局动效开关决定，**不由 fresh 决定**：fresh 在新条目挂载后的下一帧
  // 就会变成 false，那时若换成普通 div，整棵子树会被重挂（工具行的入场会重播一遍）。
  // data-msg-id：消息导航条按 msgId 找 DOM（窗口外的目标先扩窗再找）；
  // notice 没有 msgId，属性自动省略。
  const msgId = item.kind === 'notice' || item.kind === 'ask' || item.kind === 'reminder' ? undefined : item.msgId
  if (!motionOn()) return <div data-msg-index={index} data-msg-id={msgId}>{body}</div>
  const enter = fresh && fromEnd < 3 ? riseProps(fromEnd * staggerSeconds(0.03)) : null
  return <m.div data-msg-index={index} data-msg-id={msgId} {...(enter ?? NO_ENTER)}>{body}</m.div>
}

/** 条目「渲染等价」判定：**显式比较**，不能靠默认的浅比较。
    lib/chat.ts 每次提交都会把消息重折一遍（历史条目也一样重折），条目对象于是每次都是新的，
    memo 默认比引用永远为假 —— 长会话里流式期间整棵树照旧全部重渲染。
    这里按**内容**比：只要这一条肉眼可见的东西一个字都没变，就跳过重渲染。
    判据一律「宁可多渲染，不可少渲染」：拿不准的一律返回 false。 */
function sameItem(a: RenderItem, b: RenderItem): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || a.id !== b.id) return false
  if (a.kind === 'notice' && b.kind === 'notice') {
    // resolved / rateLimited 是数据层新字段：不参与比较的话字段一变不会触发重渲染，
    // 错误条会一直停在旧样式上。字段尚未进类型定义，用局部窄化读取（只消费、不定义）。
    const aResolved = Boolean((a as { resolved?: boolean }).resolved)
    const bResolved = Boolean((b as { resolved?: boolean }).resolved)
    const aRl = Boolean((a as { rateLimited?: boolean }).rateLimited)
    const bRl = Boolean((b as { rateLimited?: boolean }).rateLimited)
    // retryInfo 同样要参与比较：connection_retry 每来一次（attempt / delayMs 变）都必须重渲染，
    // 否则倒计时永远停在第一次的数值上（memo 会把它当成「没变化」直接跳过）。
    const aRI = a.retryInfo
    const bRI = b.retryInfo
    const riSame = aRI === bRI || (!!aRI && !!bRI && aRI.attempt === bRI.attempt
      && aRI.maxAttempts === bRI.maxAttempts && aRI.delayMs === bRI.delayMs)
    return a.text === b.text && a.tone === b.tone && a.retryable === b.retryable
      && aResolved === bResolved && aRl === bRl && riSame
  }
  if (a.kind === 'reminder' && b.kind === 'reminder') {
    return a.text === b.text && a.label === b.label && a.at === b.at
  }
  if (a.kind === 'user' && b.kind === 'user') {
    return a.text === b.text && a.at === b.at && a.msgId === b.msgId && a.queued === b.queued
      && a.structured === b.structured && a.attachments === b.attachments && a.quotes === b.quotes
  }
  // 提问卡：正文与问题在卡片生命周期里不变，会变的只有「答没答」与挂起状态。
  // 按引用比 answer（store 里那份对象是稳定的）——比内容更省，也不会漏判。
  if (a.kind === 'ask' && b.kind === 'ask') {
    return a.callId === b.callId && a.answer === b.answer && a.pending === b.pending && a.questions === b.questions
  }
  if (a.kind === 'assistant' && b.kind === 'assistant') {
    if (a.text !== b.text || a.reasoning !== b.reasoning) return false
    if (a.at !== b.at || a.msgId !== b.msgId) return false
    if (a.streaming !== b.streaming || a.reasoningStreaming !== b.reasoningStreaming) return false
    // segments 现在决定「哪一段是答案」，必须参与比较：
    // 只比 text/tools 会漏掉「段边界变了但拼接后的正文没变」那种提交，
    // 结果就是过程/答案的切分停在旧位置上（症状：折叠栏下面的正文少一段）。
    const aSeg = a.segments ?? []
    const bSeg = b.segments ?? []
    if (aSeg.length !== bSeg.length) return false
    for (let i = 0; i < aSeg.length; i += 1) {
      const left = aSeg[i]
      const right = bSeg[i]
      if (left.kind !== right.kind) return false
      if (left.kind === 'text' && right.kind === 'text' && left.text !== right.text) return false
      if (left.kind === 'tools' && right.kind === 'tools') {
        if (left.callIds.length !== right.callIds.length) return false
        for (let k = 0; k < left.callIds.length; k += 1) {
          if (left.callIds[k] !== right.callIds[k]) return false
        }
      }
    }
    if (a.tools.length !== b.tools.length) return false
    for (let i = 0; i < a.tools.length; i += 1) {
      const left = a.tools[i]
      const right = b.tools[i]
      if (left === right) continue
      if (left.callId !== right.callId || left.name !== right.name || left.args !== right.args) return false
      if (left.status !== right.status || left.preview !== right.preview) return false
      if (left.elapsedMs !== right.elapsedMs || left.cacheHit !== right.cacheHit) return false
      if ((left.images?.length ?? 0) !== (right.images?.length ?? 0)) return false
    }
    return true
  }
  return false
}

/** 单条消息的 memo 版：props 里只有 fresh / lastAssistantId / streaming 这类**标量**与两个函数
    （fresh 是调用方算好的布尔值，toolFresh 是 useCallback 固定的引用），
    所以比较器只需要处理「条目内容」这一件事。
    超长会话里这就是「流式期间只重画最后那条正在生成的消息」的落地点：
    前面的条目每来一个 chunk 都会被比一次，内容没变就整棵子树原样留着（Markdown 不重解析）。 */
const ChatRowMemo = memo(ChatRow, (prev, next) => (
  prev.index === next.index
  && prev.fromEnd === next.fromEnd
  && prev.lastAssistantId === next.lastAssistantId
  && prev.lastErrorNoticeId === next.lastErrorNoticeId
  && prev.modelLabel === next.modelLabel
  && prev.streaming === next.streaming
  && prev.fresh === next.fresh
  && prev.toolFresh === next.toolFresh
  // 产出清单按**引用**比（stores/artifacts 在没有产出时始终返回同一个空数组）：
  // 传下来的只有最后那条助手条目，历史条目两边都是 undefined，因此这里的比较恒为真。
  && prev.artifacts === next.artifacts
  && sameItem(prev.item, next.item)
))

/** 列表末尾的状态行：只有引擎没就绪时才有内容（普通列表自己渲染这一行）。 */
function EngineFooter({ context }: { context: boolean }) {
  if (context) return null
  return (
    <div className='mx-auto flex max-w-[var(--content-w)] items-center gap-2 px-3 py-2 text-12 text-ink-3'>
      <AgentState state='reconnecting' size='xs' label='引擎启动中' /> 引擎启动中，稍等片刻…
    </div>
  )
}

export function MessageList() {
  const liveItems = useChatItems()
  /** 流式期间把列表更新降级成**低优先级**：每一次提交（≈30fps，见 stores/session.ts 的节流）
      都会换一份 items，同步渲染等于把这棵树顶在关键路径上。
      useDeferredValue 让 React 先用手上那一份把画面稳住、有闲再换成新的。 */
  const deferredItems = useDeferredValue(liveItems)
  const engineReady = useEngine((s) => s.ready)
  const currentModel = useSession((s) => s.currentModel)
  const turnMeta = useSession((s) => s.turnMeta)
  const streaming = useSession((s) => s.streaming)
  /// 不在流式时**直接用最新的一份**：轮结束那一帧的最后一段正文必须立刻画出来
  /// （还等 deferred 的话就是「AI 停了，最后几个字晚一帧才出来」）。
  const items = streaming ? deferredItems : liveItems
  /// 搜索打开时不能把视图硬拽到底部，否则一边流式输出一边就没法看命中项。
  const searching = useChatSearch((s) => s.open)
  /// 当前会话与它的历史是否已经回读完成。
  /// **历史没就绪之前一律不做任何自动滚动**（骨架阶段不吸底）。
  const sessionId = useSession((s) => s.sessionId)
  const historyReady = useSession((s) => s.historyLoaded[s.sessionId] === true)
  /// 当前列表的滚动容器与内容包装：useStickToBottom / 搜索 / 消息跳转共用。
  const scroller = useRef<HTMLElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  /// 切页过渡闸门（components/shell/navPause）：过渡那 250ms 主线程要拍旧页快照、合成两张、
  /// 挂目标页正文；冻结标记让路，吸底由 useStickToBottom 自行判断。
  const navBusy = useNavPause()
  /// 平滑滚动的世代号：用户一动手就 +1，还在排队的补位滚动据此自行作废。
  const jumpGen = useRef(0)
  /// 排队的补位滚动（跳转目标没渲染出来时）。
  const nudge = useRef<number | null>(null)
  /// 流式标记的最新值（回调里读，不跟着闭包停在一帧）。
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming

  /* ── 窗口化：默认最后 60 条 + 顶部「加载更早」（每次 +60）──
     直接渲染 messages（单一事实来源）的窗口切片，不再有虚拟列表。 */
  const WINDOW_STEP = 60
  const [windowSize, setWindowSize] = useState(WINDOW_STEP)
  /// 切会话时回到默认窗口。
  useEffect(() => { setWindowSize(WINDOW_STEP) }, [sessionId])
  const shownItems = useMemo(() => chatWindowTail(items, windowSize) as RenderItem[], [items, windowSize])
  const canLoadEarlier = items.length > shownItems.length
  /** 目标条目（全量下标）在不在窗口里：不在就先扩窗（至少盖到那一条），返回是否已渲染。 */
  const ensureIndexRendered = useCallback((index: number): boolean => {
    if (index < items.length - windowSize) {
      setWindowSize((w) => Math.max(w, items.length - index))
      return false
    }
    return true
  }, [items.length, windowSize])

  /// 吸底：唯一滚动入口（新消息 / 内容增长 / turn_end / 强制贴底都收在它里面）。
  useStickToBottom({
    scrollerRef: scroller,
    contentRef: content,
    historyReady,
    searching,
    sessionId,
    streaming,
    itemCount: items.length,
  })

  /** 用户一动手，立刻取消正在跑的平滑滚动。
      滚轮 / 触摸 / 指针按下三种都是「我要自己滚」的信号，谁先来都算 ——
      「我已经在滚了，它还在自己慢慢滑过去」是滚动发涩里最刺眼的一种。 */
  const cancelSmoothScroll = useCallback((): void => {
    jumpGen.current += 1
    if (nudge.current !== null) { window.clearTimeout(nudge.current); nudge.current = null }
    const el = scroller.current
    if (!el) return
    el.scrollTo({ top: el.scrollTop, left: el.scrollLeft, behavior: INSTANT })
  }, [])
  useEffect(() => {
    /// 捕获 + passive：滚动容器的指针事件落在列表内部，只有捕获阶段在 window 上收得到。
    const opts: AddEventListenerOptions = { passive: true, capture: true }
    window.addEventListener('wheel', cancelSmoothScroll, opts)
    window.addEventListener('touchstart', cancelSmoothScroll, opts)
    window.addEventListener('pointerdown', cancelSmoothScroll, opts)
    return () => {
      window.removeEventListener('wheel', cancelSmoothScroll, true)
      window.removeEventListener('touchstart', cancelSmoothScroll, true)
      window.removeEventListener('pointerdown', cancelSmoothScroll, true)
    }
  }, [cancelSmoothScroll])

  /// 见过的条目 id + 工具调用 id（lib/chat.ts 的 markItemsSeen 统一登记）：
  /// 用来判断「这条是这次才出现的」，切会话 / 重挂载的旧条目、旧工具行都不算。
  const seen = useRef<Set<string>>(new Set())
  const seenGroup = useRef('')
  const seenKey = sessionId + (historyReady ? '#1' : '#0')
  seenGroup.current = markGroupSeen(seen.current, seenGroup.current, seenKey, shownItems)
  const fresh = (id: string): boolean => !seen.current.has(id)
  /// 工具行同理：同一个 callId 已经出现过就不再播入场（切会话 / 重挂载都不重播）。
  const toolFresh = useCallback((callId: string): boolean => !!callId && !seen.current.has(toolSeenKey(callId)), [])
  useEffect(() => {
    markItemsSeen(seen.current, shownItems)
  }, [shownItems])

  /// 冻结窗口的可见标记：CSS（base.css 的「滚动流畅度」段）据此把折叠块换成固定高度占位。
  /// 只写流式与切页过渡这两条；折叠窗口那 220ms 由 html[data-msg-collapse] 自己表达。
  const freezeOn = streaming || navBusy
  /// 滚动容器上的标记：data-msg-scroller 开滚动锚定；data-msg-freeze 冻结测量窗口。
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    el.dataset.msgScroller = ''
    if (freezeOn) el.dataset.msgFreeze = '1'
    else delete el.dataset.msgFreeze
  }, [freezeOn, sessionId, historyReady])

  /// 会话内搜索：命中数在数据层统计（窗口里可能没有全部命中），
  /// 跳转先扩窗把目标渲染出来，落定后再在它内部做 DOM 级高亮。
  useEffect(() => {
    let hosts: HTMLElement[] = []
    let hitIndexes: number[] = []
    let flashTimer: number | null = null
    /// 世代号：目标条目迟迟没渲染出来时的重试会因为换代而自行放弃，不碰已经卸载的 DOM。
    let gen = 0

    const clearHighlights = (): void => {
      if (flashTimer !== null) { window.clearTimeout(flashTimer); flashTimer = null }
      for (const el of hosts) el.classList.remove('search-hit')
      hosts = []
    }

    const findHosts = (scope: ParentNode, needle: string): HTMLElement[] => {
      const found: HTMLElement[] = []
      // 空针必须先收手：indexOf('') 恒返回同一个位置，游标不推进 —— 这就是最标准的同步死循环
      // （主线程被占死，界面表现就是「点哪儿都没反应」）。
      if (!needle) return found
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue ?? ''
        if (!text) continue
        const host = node.parentElement
        // 不可见的节点（display:none / 空行内元素）不参与命中；折叠中的内容 rect 仍然存在，
        // 要单独判一次，否则会「搜到 3 个」却一个都看不见。
        if (
          !host ||
          host.closest('[data-search-skip]') ||
          host.closest('.collapse[data-open="false"]') ||
          !host.getClientRects().length
        ) continue
        const haystack = text.toLowerCase()
        // 命中扫描：读游标**严格递增** + 轮数硬上限（文本长度 × 2），任一不成立就 break + 告警。
        const budget = haystack.length * 2
        let scans = 0
        let at = haystack.indexOf(needle)
        while (at >= 0) {
          scans += 1
          if (scans > budget) {
            console.warn('[MessageList] 命中扫描超过硬上限，强制收手', { needle, length: haystack.length, scans })
            break
          }
          found.push(host)
          const next = at + needle.length
          if (!(next > at)) {
            console.warn('[MessageList] 命中扫描游标没有推进，强制收手', { needle, at })
            break
          }
          at = haystack.indexOf(needle, next)
        }
      }
      return found
    }

    const flash = (el: HTMLElement | undefined): void => {
      if (!el) return
      // 命中项摆正算「跳转」，但流式期间同样不平滑（见 jumpBehavior 的注释）。
      el.scrollIntoView({ block: 'center', behavior: jumpBehavior(!streamingRef.current) })
      // 先摘掉再挂上并强制重排：连续点「下一条」时高亮动画要重新播一遍。
      el.classList.remove('search-hit')
      void el.offsetWidth
      el.classList.add('search-hit')
      if (flashTimer !== null) window.clearTimeout(flashTimer)
      flashTimer = window.setTimeout(() => { el.classList.remove('search-hit'); flashTimer = null }, 1600)
    }

    /** 目标条目不在窗口里：先扩窗，等它真的渲染出来再点亮第一条命中。 */
    const highlightItem = (index: number, needle: string, mine: number, tries = 0): void => {
      if (mine !== gen) return
      const scope = scroller.current?.querySelector('[data-msg-index="' + index + '"]')
      if (!scope) {
        if (tries >= 12) return
        // 切页过渡那一拍不滚：主线程要留给过渡本身（tries 不 +1，窗口最多几百毫秒）。
        if (navPauseBusy()) { window.setTimeout(() => highlightItem(index, needle, mine, tries), 120); return }
        // 目标还在窗口外：扩窗后下一拍再找（扩窗本身异步）。
        if (!ensureIndexRendered(index)) { window.setTimeout(() => highlightItem(index, needle, mine, tries + 1), 120); return }
        window.setTimeout(() => highlightItem(index, needle, mine, tries + 1), 120)
        return
      }
      const found = needle ? findHosts(scope, needle) : []
      hosts = found.length ? found : scope instanceof HTMLElement ? [scope] : []
      flash(hosts[0])
    }

    const controller: SearchController = {
      search: (query) => {
        clearHighlights()
        hitIndexes = []
        const needle = query.trim().toLowerCase()
        if (!needle) return 0
        items.forEach((item, index) => {
          let count = 0
          for (const text of searchableText(item)) {
            const haystack = text.toLowerCase()
            // 与 findHosts 同一套护栏：游标严格递增 + 轮数硬上限（文本长度 × 2）。
            const budget = haystack.length * 2
            let scans = 0
            let at = haystack.indexOf(needle)
            while (at >= 0) {
              scans += 1
              if (scans > budget) {
                console.warn('[MessageList] 命中计数超过硬上限，强制收手', { needle, length: haystack.length, scans })
                break
              }
              count += 1
              const next = at + needle.length
              if (!(next > at)) {
                console.warn('[MessageList] 命中计数游标没有推进，强制收手', { needle, at })
                break
              }
              at = haystack.indexOf(needle, next)
            }
          }
          for (let n = 0; n < count; n += 1) hitIndexes.push(index)
        })
        return hitIndexes.length
      },
      focus: (index) => {
        const target = hitIndexes[index]
        if (target === undefined) return
        /// 空查询绝不点亮任何东西（findHosts 也拒空针）。
        const need = useChatSearch.getState().query.trim().toLowerCase()
        if (!need) return
        const mine = gen
        highlightItem(target, need, mine)
      },
      clear: () => { clearHighlights(); hitIndexes = [] },
    }

    registerSearchController(controller)
    return () => {
      gen += 1
      controller.clear()
      registerSearchController(null)
    }
  }, [items, windowSize, ensureIndexRendered])

  /// 消息定位：把实现交给 lib/msgScroll，消息导航条（会话内跳转 / 上一条下一条）用它跳转。
  /// 目标不在窗口里（窗口化）先扩窗，等它渲染出来再平滑滚过去。
  useEffect(() => {
    const jump = (msgId: string): void => {
      const index = items.findIndex((it) => it.kind !== 'notice' && it.kind !== 'ask' && it.kind !== 'reminder' && it.msgId === msgId)
      if (index < 0) return
      /// 跳转是**唯一**允许平滑的一族：其余（贴底 / 恢复位置 / 量高补正）全是瞬时。
      /// 流式期间连跳转都不平滑，见 jumpBehavior。
      const smooth = jumpBehavior(!streamingRef.current) === 'smooth'
      /// 世代号：用户一动手指就把补位滚动作废（见 cancelSmoothScroll）。
      const mine = jumpGen.current
      if (nudge.current !== null) { window.clearTimeout(nudge.current); nudge.current = null }
      const host = scroller.current?.querySelector('[data-msg-id="' + attrValue(msgId) + '"]')
      if (host instanceof HTMLElement) {
        host.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : INSTANT })
        return
      }
      if (!ensureIndexRendered(index)) {
        // 扩窗之后目标才渲染：重试几次，落定后摆到视口中间。
        const retry = (tries: number): void => {
          if (mine !== jumpGen.current) return
          if (tries >= 12) return
          const found = scroller.current?.querySelector('[data-msg-id="' + attrValue(msgId) + '"]')
          if (found instanceof HTMLElement) {
            found.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : INSTANT })
            return
          }
          nudge.current = window.setTimeout(() => { nudge.current = null; retry(tries + 1) }, 120)
        }
        retry(0)
        return
      }
      // 已渲染但没命中 data-msg-id（理论兜底）：按条目下标定位一次。
      const fallback = scroller.current?.querySelector('[data-msg-index="' + index + '"]')
      if (fallback instanceof HTMLElement) fallback.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : INSTANT })
    }
    const unregister = registerMessageScroller(jump)
    return () => {
      if (nudge.current !== null) { window.clearTimeout(nudge.current); nudge.current = null }
      unregister()
    }
  }, [items, windowSize, ensureIndexRendered])

  const modelLabel = turnMeta?.model || currentModel || '默认模型'
  /// 最后那条助手条目的 **id**（不是对象）：对象每个提交都会重折一份新的，
  /// 当 prop 传下去会让超长会话里每来一个 chunk 就重渲染一遍所有助手条目。
  const lastAssistantId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'assistant') return it.id
    }
    return ''
  }, [items])
  /// 最新那条错误条的 **id**（同上只取 id，不取对象）：重试倒计时的兜底（全局 retrying）
  /// 一次只属于一条卡 —— 只给最新那条，历史错误卡不挂倒计时（见 Notice 的说明）。
  const lastErrorNoticeId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'notice' && it.tone === 'error') return it.id
    }
    return ''
  }, [items])

  /** 本轮产出：turn_end 的 artifacts 字段（stores/session 解析后存在 state 里）。
      showArtifacts 关掉就是「没有」——用户明确不要这排卡片。
      引用稳定：state 里空产出时是共享常量 NO_ARTIFACTS，这里短路成 undefined，
      所以卡片不出现时任何一行都不会因为它重渲染。 */
  const showArtifacts = useCapabilities((s) => s.caps.showArtifacts)
  const turnArtifacts = useSession((s) => s.turnArtifacts)
  const artifactList = showArtifacts && turnArtifacts.length ? turnArtifacts : undefined

  const row = (it: RenderItem, index: number) => (
    <ChatRowMemo
      item={it}
      index={index}
      fromEnd={items.length - 1 - index}
      lastAssistantId={lastAssistantId}
      lastErrorNoticeId={lastErrorNoticeId}
      modelLabel={modelLabel}
      streaming={streaming}
      fresh={fresh(it.id)}
      toolFresh={toolFresh}
      // 卡片只属于「最后那条助手条目」：其余条目（含更早的助手回复）传 undefined。
      artifacts={it.id === lastAssistantId ? artifactList : undefined}
    />
  )

  /// 窗口内第一条的全量下标：渲染与 data-msg-index 都用它（搜索 / 跳转按全量下标找 DOM）。
  const baseIndex = items.length - shownItems.length

  return (
    <>
      <div
        ref={(el) => {
          scroller.current = el
          if (el) el.dataset.msgScroller = ''
        }}
        className='min-h-0 flex-1 overflow-y-auto'
      >
        <div ref={content} className='py-5'>
          {/* 顶部「加载更早」：窗口外还有更早的消息时出现，每次 +60。 */}
          {canLoadEarlier ? (
            <div className='mx-auto flex w-full max-w-[var(--content-w)] justify-center px-4 pt-2'>
              <button
                type='button'
                data-load-earlier
                onClick={() => setWindowSize((w) => w + WINDOW_STEP)}
                className='flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-12 text-ink-3 transition-colors duration-[var(--motion-hover)] ease-[var(--ease-spring)] hover:bg-hover hover:text-ink-2'
              >
                <ChevronUp size={12} className='shrink-0' />
                加载更早
              </button>
            </div>
          ) : null}
          {shownItems.map((it, i) => {
            const index = baseIndex + i
            return <Fragment key={it.id}>{row(it, index)}</Fragment>
          })}
          <EngineFooter context={engineReady} />
        </div>
      </div>
      <SelectionToolbar />
    </>
  )
}

