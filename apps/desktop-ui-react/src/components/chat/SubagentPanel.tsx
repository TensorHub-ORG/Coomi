/**
 * 对话页顶部的「子智能体」面板：可折叠，没有子智能体时整块隐藏。
 *
 * 数据全部来自引擎（见 ./subagents.ts 的说明）：
 * - GET /api/settings/subagents：已配置的子智能体（名称 / 模型），把 sub_agent_id 变成人话；
 * - 当前对话的 spawn_agent / wait_agent / close_agent 工具调用：谁被派发、什么状态、耗时、最近输出。
 * 这里不合成任何条目：一条都没有就不渲染。
 *
 * 中断：引擎目前没有「单独终止某个子智能体」的 HTTP/WS 接口（spawn_agent 派生的子 Agent
 * 由调度器持有，只能通过模型侧的 close_agent 工具关闭），所以这里的中断按钮走的是引擎
 * 真实存在的「取消本轮任务」——也就是对话的停止按钮那条路径，不是假装能杀单个子智能体。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, Plus, Sparkles, Square } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../lib/cn'
import { fmtDuration } from '../../lib/format'
import { ipc } from '../../lib/ipc'
import type { ChatItem } from '../../lib/chat'
import { useEngine } from '../../stores/engine'
import { useSession } from '../../stores/session'
import { Badge } from '../ui/Input'
import { Tip } from '../ui/Overlay'
import { secondNow, useStableTick } from '../ui/stableTick'
import { AgentState } from '../ai/AgentState'
import { deriveSubagents, isLive, type ConfiguredSubagent, type SubagentEntry, type SubagentStatus } from './subagents'
// 插件子智能体模板：新建区（名称 + 描述，点击即建；systemPrompt 由壳/引擎侧保存）。
import { describeIpcError, usePluginStore } from '../plugins/pluginStore'
import { collectPluginSubagentTemplates, type PluginSubagentTemplateItem } from '../plugins/subagentTemplates'

const STATUS_TEXT: Record<SubagentStatus, string> = {
  starting: '启动中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  closed: '已结束',
}

const STATUS_TONE: Record<SubagentStatus, 'neutral' | 'primary' | 'ok' | 'warn' | 'danger'> = {
  starting: 'primary',
  running: 'primary',
  completed: 'ok',
  failed: 'danger',
  closed: 'neutral',
}

/** 界面上的「还在跑」：有快照确认在跑，或者本轮确实还在跑（streaming）。
 *  spawn_agent 的返回值只说明引擎受理了派发，不代表它还活着——
 *  引擎的存活状态只从 wait_agent / close_agent 的快照里来。
 *  另外：本轮已经收尾（streaming=false 且 runState 回到 idle）时**一律不再算运行中**，
 *  否则快照里那条 status=running 会让计时器永远走字（「AI 都答完了，子智能体还在跑」。 */
function isRunningView(entry: SubagentEntry, streaming: boolean, turnIdle: boolean): boolean {
  if (!isLive(entry)) return false
  if (turnIdle) return false
  return entry.fromSnapshot || streaming
}

/** 标签只写能验证的事实：「只有派发记录 + 本轮已结束」显示「已派发」，不硬说运行中/启动中。 */
function statusView(entry: SubagentEntry, streaming: boolean, turnIdle: boolean): { text: string; tone: 'neutral' | 'primary' | 'ok' | 'warn' | 'danger' } {
  if (!isLive(entry)) return { text: STATUS_TEXT[entry.status], tone: STATUS_TONE[entry.status] }
  if (isRunningView(entry, streaming, turnIdle)) return { text: STATUS_TEXT[entry.status], tone: STATUS_TONE[entry.status] }
  // 本轮已经收尾：只能报「引擎有没有给出耗时」，状态不硬说运行中。
  return { text: turnIdle ? '已结束本轮' : '已派发', tone: 'neutral' }
}

function durationLabel(entry: SubagentEntry, now: number, streaming: boolean, turnIdle: boolean): string {
  if (isRunningView(entry, streaming, turnIdle) && entry.startedAt !== null) {
    return fmtDuration(Math.max(0, now - entry.startedAt))
  }
  return entry.elapsedMs === null ? '—' : fmtDuration(entry.elapsedMs)
}

export function SubagentPanel({ items }: { items: ChatItem[] }) {
  const ready = useEngine((s) => s.ready)
  const streaming = useSession((s) => s.streaming)
  /// 本轮是否真的已经收尾：streaming=false 且没有待审批/待回答。
  /// 这是「状态条与子智能体面板同步收尾」的判据——turn_end 一到两边一起停。
  const runState = useSession((s) => s.runState)
  const approval = useSession((s) => s.approval)
  const question = useSession((s) => s.question)
  const turnIdle = !streaming && runState === 'idle' && !approval && !question
  const cancel = useSession((s) => s.cancel)
  const [configured, setConfigured] = useState<ConfiguredSubagent[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [openId, setOpenId] = useState('')
  /// 计时起点：只在「第一次看见这个子智能体」时记一次（每次渲染都会重折列表）。
  const observed = useRef(new Map<string, number>())
  const observedAt = useCallback((id: string): number => {
    const seen = observed.current.get(id)
    if (seen !== undefined) return seen
    const stamp = Date.now()
    observed.current.set(id, stamp)
    return stamp
  }, [])

  /// 已配置的子智能体只在引擎就绪时取一次（配置改动走设置页，这里没必要轮询）。
  useEffect(() => {
    if (!ready) { setConfigured([]); return }
    let alive = true
    void (async () => {
      try {
        const data = await useEngine.getState().api<{ agents?: ConfiguredSubagent[] }>('/api/settings/subagents')
        if (alive) setConfigured(Array.isArray(data?.agents) ? data.agents : [])
      } catch {
        // 引擎没就绪/接口不可用：名称退化成 agent id，列表本身照常显示。
        if (alive) setConfigured([])
      }
    })()
    return () => { alive = false }
  }, [ready])

  const entries = useMemo(
    () => deriveSubagents(items, configured, observedAt),
    [items, configured, observedAt],
  )
  const live = entries.filter((entry) => isRunningView(entry, streaming, turnIdle))
  /// 插件子智能体模板：新建区（已启用插件声明的 subagents 项）。
  /// 只订阅 store 的稳定引用，派生结果用 useMemo 缓存，引用只在真正变化时更新。
  const pluginEntries = usePluginStore((s) => s.plugins)
  const pluginPrefs = usePluginStore((s) => s.prefs)
  const pluginTemplates = useMemo(
    () => collectPluginSubagentTemplates(pluginEntries, pluginPrefs),
    [pluginEntries, pluginPrefs],
  )
  /// 正在创建的模板 key（点击即建；等待壳回执期间锁住新建区）。
  const [creatingKey, setCreatingKey] = useState('')

  const createFromTemplate = async (t: PluginSubagentTemplateItem): Promise<void> => {
    if (creatingKey) return
    setCreatingKey(t.key)
    try {
      // systemPrompt 由壳/引擎侧按 templateId 保存，这里只把「插件 + 模板」指过去。
      await ipc('plugin_spawn_subagent', { pluginId: t.pluginId, templateId: t.id ?? t.name })
      toast.message('已创建子智能体「' + t.name + '」')
    } catch (e) {
      toast.error(describeIpcError('plugin_spawn_subagent', e))
    } finally {
      setCreatingKey('')
    }
  }

  /* 走字用的「现在」：只有「运行中」才开一秒的节拍，而且只在**秒真的翻过去**时才提交
     （secondNow 把时间按秒量化，同一秒里读多少次都相等）。原来是
     setInterval(() => setNow(Date.now()), 1000)：每一拍都是新时间戳，静止时也在提交。
     见 components/ui/stableTick.ts 的三条硬规矩。 */
  const now = useStableTick(live.length > 0, 1000, secondNow, secondNow())

  // 一条都没有就不渲染；有插件子智能体模板时面板照常显示（新建区在展开区里）。
  if (!entries.length && !pluginTemplates.length) return null

  const onInterrupt = (): void => {
    // 引擎没有「终止单个子智能体」的接口，这里是真实存在的「取消本轮任务」，
    // 与输入框的停止按钮同一条路径（引擎在父任务取消/结束时收尾派生的子 Agent）。
    cancel()
    toast.message('已请求中断本轮任务')
  }

  return (
    <div className='shrink-0 border-b border-line bg-surface/60 px-3 py-1.5'>
      <div className='mx-auto w-full max-w-[var(--content-w)]'>
        <button
          type='button'
          onClick={() => setCollapsed((v) => !v)}
          className='flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-12 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:bg-hover'
        >
          <Bot size={13} className='shrink-0 text-primary' />
          <span className='font-medium text-ink'>子智能体</span>
          <span className='text-ink-3'>{entries.length} 个</span>
          {live.length ? (
            <Badge tone='primary'>{live.length} 运行中</Badge>
          ) : (
            <Badge tone='neutral'>无运行中</Badge>
          )}
          <ChevronDown
            size={13}
            className={cn('ml-auto shrink-0 text-ink-4 transition-transform duration-[var(--motion-base)] ease-[var(--ease-spring)]', collapsed ? '-rotate-90' : '')}
          />
        </button>

        {collapsed ? null : (
          <>
            {/* 插件子智能体模板：名称 + 描述，点击即建；systemPrompt 由壳/引擎侧保存。 */}
            {pluginTemplates.length ? (
              <div className='mt-1.5 rounded-lg border border-dashed border-line-strong bg-muted/50 px-2.5 py-2'>
                <p className='mb-1 flex items-center gap-1.5 text-11 text-ink-4'>
                  <Sparkles size={11} className='text-primary' /> 插件子智能体模板
                </p>
                <div className='flex min-w-0 flex-wrap gap-1.5'>
                  {pluginTemplates.map((t) => (
                    <button
                      key={t.key}
                      type='button'
                      disabled={creatingKey !== ''}
                      title={t.description || ('来自插件 ' + t.plugin)}
                      onClick={() => void createFromTemplate(t)}
                      className={cn(
                        'flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-left text-11 text-ink-2',
                        'transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:border-primary/40 hover:text-ink',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                      )}
                    >
                      <Plus size={11} className='shrink-0 text-primary' />
                      <span className='min-w-0 truncate font-medium'>{t.name}</span>
                      {t.description ? <span className='hidden min-w-0 max-w-[180px] truncate text-ink-4 lg:inline'>— {t.description}</span> : null}
                      <span className='shrink-0 text-ink-4'>{t.plugin}</span>
                      {creatingKey === t.key ? <span className='shrink-0 text-primary'>创建中…</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <ul className='mt-1.5 flex flex-col gap-1.5'>
            {entries.map((entry) => {
              const expanded = openId === entry.id
              const canInterrupt = streaming && isLive(entry) && !turnIdle
              const view = statusView(entry, streaming, turnIdle)
              const spinning = isRunningView(entry, streaming, turnIdle)
              return (
                <li key={entry.id} className='rounded-lg border border-line bg-surface shadow-elev-1'>
                  <div className='flex items-center gap-2 px-2.5 py-1.5'>
                    {spinning
                      ? <AgentState state='subagents' size='xs' tone='primary' className='shrink-0' />
                      : <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', entry.status === 'failed' ? 'bg-danger' : entry.status === 'completed' ? 'bg-ok' : 'bg-ink-4')} />}
                    <span className='min-w-0 flex-1 truncate text-12 text-ink' title={entry.task || entry.name}>{entry.name}</span>
                    {entry.model ? <span className='hidden shrink-0 text-11 text-ink-4 sm:inline'>{entry.model}</span> : null}
                    <span className='shrink-0 tabular-nums text-11 text-ink-3'>{durationLabel(entry, now, streaming, turnIdle)}</span>
                    <Badge tone={view.tone}>{view.text}</Badge>
                    <button
                      type='button'
                      onClick={() => setOpenId(expanded ? '' : entry.id)}
                      className='shrink-0 rounded px-1.5 py-0.5 text-11 text-ink-3 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:bg-hover hover:text-ink'
                    >
                      {expanded ? '收起' : '输出'}
                    </button>
                    {canInterrupt ? (
                      <Tip label='中断本轮任务（引擎在父任务取消/结束时收尾派生的子 Agent）'>
                        <button
                          type='button'
                          onClick={() => onInterrupt()}
                          className='shrink-0 rounded px-1.5 py-0.5 text-11 text-danger transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:bg-danger-soft'
                        >
                          <Square size={10} className='inline-block align-[-1px]' /> 中断
                        </button>
                      </Tip>
                    ) : null}
                  </div>
                  {expanded ? (
                    <div className='border-t border-line-soft px-2.5 py-2'>
                      {entry.task ? (
                        <p className='mb-1.5 text-11 leading-relaxed text-ink-2'><span className='text-ink-4'>任务：</span>{entry.task}</p>
                      ) : null}
                      {entry.output ? (
                        <pre className='max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-2 py-1.5 font-mono text-11 leading-relaxed text-code-fg'>{entry.output}</pre>
                      ) : (
                        <p className='text-11 text-ink-4'>还没有拿到输出：子智能体的输出要等 wait_agent / close_agent 把引擎快照带回来。</p>
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
