/**
 * 子智能体对话详情视图：点开某条子智能体后，在面板内部切换出来的那一屏。
 *
 * 数据不是主时间线派生的概览，而是引擎的只读接口：
 *   GET /api/agents/{id}/messages → SubagentDetail（200）/ 404。
 * 加载态用骨架；404 / 网络错给提示 + 重试。头部（名称 / 状态 / 用时 / 任务）
 * 优先用接口返回的权威字段，接口没回来前用面板条目的派生值兜底。
 *
 * 会话视图刻意比主对话简：没有 streaming / 引用 / 附件 / 操作条，
 * 但 messages 的**顺序必须保持** —— 按 role 逐条渲染（气泡 / 工具行 / 折叠块）。
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, Brain, ChevronRight, RefreshCw, Wrench } from 'lucide-react'
import { cn } from '../../lib/cn'
import { fmtDuration } from '../../lib/format'
import { useEngine } from '../../stores/engine'
import { Badge } from '../ui/Input'
import { Markdown } from './Markdown'
import type { SubagentDetail, SubagentMessage, SubagentMessageTool } from './subagents'
import type { SubagentEntry } from './subagents'

/** 状态词 → 界面文案 / 徽标色。引擎只发 running / completed / failed，
 *  未知状态原样显示、不猜（与概览列表同一口径）。 */
function statusView(raw: string): { text: string; tone: 'neutral' | 'primary' | 'ok' | 'warn' | 'danger' } {
  switch (raw) {
    case 'starting': return { text: '启动中', tone: 'primary' }
    case 'running': return { text: '运行中', tone: 'primary' }
    case 'completed': case 'done': case 'success': return { text: '已完成', tone: 'ok' }
    case 'failed': case 'error': return { text: '失败', tone: 'danger' }
    case 'closed': case 'cancelled': case 'canceled': return { text: '已结束', tone: 'neutral' }
    default: return { text: raw || '—', tone: 'neutral' }
  }
}

type LoadState = 'loading' | 'ok' | 'error'

export function SubagentDetail({ entry, onBack }: { entry: SubagentEntry; onBack: () => void }) {
  const [load, setLoad] = useState<LoadState>('loading')
  const [detail, setDetail] = useState<SubagentDetail | null>(null)
  const [error, setError] = useState('')

  const loadDetail = useCallback(async (): Promise<void> => {
    setLoad('loading')
    setError('')
    try {
      const data = await useEngine.getState().api<SubagentDetail>(
        '/api/agents/' + encodeURIComponent(entry.id) + '/messages',
      )
      setDetail(data)
      setLoad('ok')
    } catch (e) {
      // 404（HTTP 404：…）也走这条：错误卡给出「找不到」文案，两种都给重试。
      setError(e instanceof Error ? e.message : String(e))
      setLoad('error')
    }
  }, [entry.id])

  useEffect(() => { void loadDetail() }, [loadDetail])

  // 头部字段：接口没回来前用面板条目兜底（entry.name 已由配置解析成人话名）。
  const header = statusView(detail?.status ?? entry.status)
  const elapsedMs = detail?.elapsed_ms != null ? detail.elapsed_ms : entry.elapsedMs
  const task = detail?.task?.trim() || entry.task

  return (
    <div className='mt-1.5 overflow-hidden rounded-lg border border-line bg-surface shadow-elev-1'>
      {/* 头部：返回 / 名称 / 状态 / 用时 / 刷新；任务描述单独一行。 */}
      <div className='flex items-center gap-2 px-2.5 py-1.5'>
        <button
          type='button'
          onClick={onBack}
          className='flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-11 text-ink-3 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:bg-hover hover:text-ink'
        >
          <ArrowLeft size={12} />
          返回
        </button>
        <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70' />
        <span className='min-w-0 flex-1 truncate text-12 font-medium text-ink' title={'id: ' + entry.id}>{entry.name}</span>
        <Badge tone={header.tone}>{header.text}</Badge>
        <span className='shrink-0 tabular-nums text-11 text-ink-3'>{fmtDuration(elapsedMs)}</span>
        <button
          type='button'
          onClick={() => void loadDetail()}
          disabled={load === 'loading'}
          title='重新拉取对话'
          className='flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-11 text-ink-3 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:bg-hover hover:text-ink disabled:opacity-50'
        >
          <RefreshCw size={11} className={cn('shrink-0', load === 'loading' && 'animate-spin')} />
          刷新
        </button>
      </div>
      {task ? (
        <p className='border-t border-line-soft px-2.5 py-1.5 text-11 leading-relaxed text-ink-2'>
          <span className='text-ink-4'>任务：</span>{task}
        </p>
      ) : null}

      {/* 三态：加载骨架 / 错误重试 / 对话流。 */}
      {load === 'loading' ? <DetailSkeleton /> : null}
      {load === 'error' ? <DetailError message={error} onRetry={() => void loadDetail()} /> : null}
      {load === 'ok' && detail ? <MessageFlow detail={detail} /> : null}
    </div>
  )
}

/** 加载骨架：形状模仿「用户气泡 + 几行回复」，静态灰底（与主对话骨架同一套 .skeleton）。 */
function DetailSkeleton() {
  return (
    <div aria-busy='true' aria-label='正在加载子智能体对话' className='space-y-3 border-t border-line-soft px-2.5 py-3'>
      <div className='skeleton ml-auto h-8 w-[38%] rounded-[18px] rounded-tr-[6px]' />
      <div className='space-y-2'>
        <div className='skeleton h-3.5 w-[86%] rounded' />
        <div className='skeleton h-3.5 w-[70%] rounded' />
        <div className='skeleton h-3.5 w-[55%] rounded' />
      </div>
      <div className='skeleton h-6 w-[60%] rounded-md' />
      <div className='space-y-2'>
        <div className='skeleton h-3.5 w-[80%] rounded' />
        <div className='skeleton h-3.5 w-[64%] rounded' />
      </div>
    </div>
  )
}

/** 错误卡：404 与其它错误分开给文案，都带重试（占位 id / 记录被清理都从这回来）。 */
function DetailError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const notFound = message.startsWith('HTTP 404')
  return (
    <div className='border-t border-line-soft px-2.5 py-3'>
      <div className='flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-12 text-danger'>
        <AlertTriangle size={13} className='mt-0.5 shrink-0' />
        <div className='min-w-0 flex-1'>
          <p className='font-medium'>{notFound ? '找不到该子智能体的对话记录' : '对话加载失败'}</p>
          <p className='mt-0.5 break-words text-11 leading-relaxed text-danger/75'>
            {notFound
              ? '可能是还没拿到真实 id（wait_agent / close_agent 快照到达后会自动更新列表），或记录已被清理。'
              : message}
          </p>
        </div>
        <button
          type='button'
          onClick={onRetry}
          className='shrink-0 rounded px-2 py-0.5 text-11 font-medium transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:bg-danger/10'
        >
          重试
        </button>
      </div>
    </div>
  )
}

/** 对话流：按接口给出的顺序逐条渲染，最后追加最终输出。长对话在面板里限高滚动。 */
function MessageFlow({ detail }: { detail: SubagentDetail }) {
  const messages = Array.isArray(detail.messages) ? detail.messages : []
  const output = detail.output?.trim()
  return (
    <div className='max-h-[min(52vh,560px)] overflow-y-auto border-t border-line-soft px-2.5 py-2'>
      {messages.length ? (
        <div className='flex flex-col gap-2.5'>
          {messages.map((msg, index) => <MessageRow key={index} msg={msg} />)}
        </div>
      ) : (
        <p className='py-3 text-center text-11 text-ink-4'>该子智能体还没有对话记录</p>
      )}
      {output ? <FinalOutput output={output} /> : null}
    </div>
  )
}

/** 按角色分发：user → 右对齐气泡，assistant → 正文 + 思考 + 工具行，tool → 结果行，system → 弱化提示行。
 *  顺序由数组下标决定，这里不做任何排序 / 合并。 */
function MessageRow({ msg }: { msg: SubagentMessage }) {
  switch (msg.role) {
    case 'system':
      return <SystemLine content={msg.content} />
    case 'user':
      return <UserBubble content={msg.content} />
    case 'assistant':
      return <AssistantBlock msg={msg} />
    case 'tool':
      return <ToolResult content={msg.content} />
    default:
      // 引擎以后可能加新角色：原样当文本渲染，保证顺序不丢。
      return msg.content.trim() ? <p className='text-12 text-ink-2'>{msg.content}</p> : null
  }
}

function SystemLine({ content }: { content: string }) {
  if (!content.trim()) return null
  return (
    <p className='rounded-md bg-muted/60 px-2.5 py-1.5 text-11 leading-relaxed text-ink-4'>
      <span className='mr-1.5 font-medium'>系统</span>
      {content}
    </p>
  )
}

/** 用户消息：沿用主对话气泡的样式类名（浅色主题下白底深墨，深色主题自动反色）。 */
function UserBubble({ content }: { content: string }) {
  if (!content.trim()) return null
  return (
    <div className='flex justify-end'>
      <div className='sel-text max-w-[82%] rounded-[18px] rounded-tr-[6px] border border-bubble-user-line bg-bubble-user px-3.5 py-2 text-13 leading-[1.7] whitespace-pre-wrap text-bubble-user-ink'>
        {content}
      </div>
    </div>
  )
}

/** 助手消息：思考（默认折叠）→ 正文（Markdown）→ 工具调用（默认折叠）。
 *  三样都没有就整条跳过（占位不可见，顺序不受影响）。 */
function AssistantBlock({ msg }: { msg: SubagentMessage }) {
  const hasText = msg.content.trim().length > 0
  const hasReasoning = !!msg.reasoning?.trim()
  const hasTools = Array.isArray(msg.tools) && msg.tools.length > 0
  if (!hasText && !hasReasoning && !hasTools) return null
  return (
    <div className='flex min-w-0 flex-col gap-1.5'>
      {hasReasoning ? <ReasoningBlock text={msg.reasoning ?? ''} /> : null}
      {hasText ? (
        <div className='min-w-0 max-w-[var(--reading-w)]'>
          <Markdown text={msg.content} />
        </div>
      ) : null}
      {hasTools ? <AssistantTools tools={msg.tools ?? []} /> : null}
    </div>
  )
}

/** 思考折叠块：比主对话简单（没有 streaming 自动贴底 / 渐隐），只保留「已思考 · N 段」的折叠。 */
function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const steps = text.split(/\n{2,}/).filter(Boolean).length
  return (
    <div className='mb-1'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-12 text-ink-3 transition-colors duration-[var(--motion-hover)] ease-[var(--ease-spring)] hover:bg-hover hover:text-ink-2'
      >
        <Brain size={12} />
        <span>已思考 · {steps} 段</span>
        <span className={cn('inline-flex shrink-0 transition-transform duration-[var(--motion-base)] ease-[var(--ease-spring)]', open && 'rotate-90')}>
          <ChevronRight size={12} />
        </span>
      </button>
      {/* 折叠统一走 .collapse + data-open：高度与透明度同时收放（见 styles/base.css）。 */}
      <div className='collapse' data-open={open}>
        <div>
          <div className='mt-1.5 max-h-[min(40vh,320px)] overflow-y-auto border-l-2 border-line-strong pl-3 text-12 leading-[1.7] whitespace-pre-wrap text-ink-3'>
            {text}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 助手消息里的工具调用：一行摘要（N 个），展开看每个工具的名字 + 参数 JSON。 */
function AssistantTools({ tools }: { tools: SubagentMessageTool[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className='my-0.5 overflow-hidden rounded-md border border-line bg-muted/50'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-1.5 px-2 py-1 text-left text-12 text-ink-3 transition-colors duration-[var(--motion-hover)] ease-[var(--ease-spring)] hover:bg-hover hover:text-ink-2'
      >
        <Wrench size={12} className='shrink-0' />
        <span>工具调用 {tools.length} 个</span>
        <span className='flex-1' />
        <span className={cn('inline-flex shrink-0 transition-transform duration-[var(--motion-base)] ease-[var(--ease-spring)]', open && 'rotate-90')}>
          <ChevronRight size={12} />
        </span>
      </button>
      <div className='collapse' data-open={open}>
        <div>
          <div className='flex flex-col gap-1.5 border-t border-line-soft px-2 py-1.5'>
            {tools.map((tool, index) => (
              <div key={tool.id || index} className='min-w-0'>
                <span className='font-mono text-11 text-ink-2'>{tool.name}</span>
                {tool.arguments ? (
                  <pre className='mt-1 max-h-40 overflow-auto rounded bg-code px-2 py-1.5 font-mono text-11 leading-[1.6] text-code-fg'>{tool.arguments}</pre>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 工具结果行（role=tool）：默认折叠，表头给「几行 / 首行截断」的摘要，展开看全文。
 *  结果可能是整份文件内容，默认收起来避免把正文顶出屏幕。 */
function ToolResult({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  if (!content.trim()) return null
  const lines = content.split('\n').length
  const firstLine = content.trim().split('\n')[0] ?? ''
  const summary = lines > 1 ? lines + ' 行' : (firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine)
  return (
    <div className='my-0.5 overflow-hidden rounded-lg border border-line bg-surface'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-12 text-ink-3 transition-colors duration-[var(--motion-hover)] ease-[var(--ease-spring)] hover:bg-hover hover:text-ink-2'
      >
        <Wrench size={12} className='shrink-0 text-ink-4' />
        <span className='shrink-0 font-medium'>工具结果</span>
        <span className='min-w-0 flex-1 truncate text-11 text-ink-4'>{summary}</span>
        <span className={cn('inline-flex shrink-0 transition-transform duration-[var(--motion-base)] ease-[var(--ease-spring)]', open && 'rotate-90')}>
          <ChevronRight size={12} />
        </span>
      </button>
      <div className='collapse' data-open={open}>
        <div>
          <pre className='max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-line-soft bg-code px-2.5 py-2 font-mono text-11 leading-[1.6] text-code-fg'>{content}</pre>
        </div>
      </div>
    </div>
  )
}

/** 最终输出：接口的 output 字段非空时挂在对话末尾（默认展开，失败 / 出错时的结论一眼可见）。 */
function FinalOutput({ output }: { output: string }) {
  const [open, setOpen] = useState(true)
  return (
    <div className='mt-2.5 overflow-hidden rounded-lg border border-ok/25 bg-surface'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-12 transition-colors duration-[var(--motion-hover)] ease-[var(--ease-spring)] hover:bg-hover'
      >
        <span className='shrink-0 font-medium text-ok'>最终输出</span>
        <span className='flex-1' />
        <span className={cn('inline-flex shrink-0 text-ink-4 transition-transform duration-[var(--motion-base)] ease-[var(--ease-spring)]', open && 'rotate-90')}>
          <ChevronRight size={12} />
        </span>
      </button>
      <div className='collapse' data-open={open}>
        <div>
          <pre className='max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-line-soft bg-code px-2.5 py-2 font-mono text-11 leading-[1.7] text-ink-2'>{output}</pre>
        </div>
      </div>
    </div>
  )
}
