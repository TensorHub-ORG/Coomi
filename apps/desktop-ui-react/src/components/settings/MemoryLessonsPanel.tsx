/** 经验库：设置页「AI 能力」分组下的一小节 —— 引擎从**反复失败**里蒸馏出来的可复用经验。
 *
 *  为什么单独一块：长期记忆的开关只回答「记不记」，回答不了「记住了什么、值不值得留」。
 *  这些经验是有层级的（core / stable / candidate），而 candidate 根本不参与注入 ——
 *  不给用户看一眼的能力清单，等于把「引擎偷偷记了东西」这件事藏起来。
 *
 *  引擎接口（apps/coomi-rs/ui/src/web/mod.rs 的 list_memory / delete_memory）：
 *   · GET    /api/memory          → { builtin: true, memories: Memory[] }
 *   · DELETE /api/memory/{name}   → { ok: true, deleted: bool }（name 必须 encodeURIComponent）
 *
 *  生命周期（serde snake_case，小写）：core / stable 会被注入上下文，candidate 不注入；
 *  一条经验若总在失败的轮次里出现，引擎侧的 assign_lifecycle 会把它降级、直到不再注入 ——
 *  所以「效果分」是这里最该被看见的一栏，用户就是靠它判断要不要手动删掉。
 *
 *  读写一律走 stores/engine 的 api()：它自带 Bearer 鉴权、硬超时与壳内转发兜底，
 *  自己 fetch 拼 URL 会绕开这三件事（真机上有直连被系统拦下的场景）。
 *  「清空全部」必须先过 ConfirmDialog：一次性删光不可逆，但经验能重新积累，所以要说清楚。 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react'
import { Empty, Section } from '../ui/Card'
import { Badge } from '../ui/Input'
import { Button } from '../ui/Button'
import { ConfirmDialog } from '../ui/Overlay'
import { SkeletonRows } from '../ui/Controls'
import { cn } from '../../lib/cn'
import { useEngine } from '../../stores/engine'
import { withDisplayName } from '../../lib/stormProbe'

/** GET /api/memory 里的一条经验（字段名跟着引擎的 serde snake_case 走，lifecycle 也是小写）。 */
interface Memory {
  name: string
  description: string
  content: string
  scope: 'local' | 'project' | 'global' | null
  type: 'user' | 'feedback' | 'project' | 'reference'
  lifecycle: 'candidate' | 'stable' | 'core'
  hit_count: number
  last_triggered: string | null
  confidence: number
  evidence: string[]
  sessions: string[]
  outcomes_ok: number
  outcomes_bad: number
  created: string
  updated: string
}

interface MemoryList {
  builtin?: boolean
  memories?: Memory[]
}

/** 生命周期徽章语义：core 用 ok（绿，最醒目且是正面的「最高一档」），stable 走主色，
 *  candidate 走中性灰。不用 warn / danger —— 那是「出问题」的语义，而 candidate 只是还没验证。 */
interface LifecycleMeta {
  label: string
  tone: 'ok' | 'primary' | 'neutral'
  hint: string
}

function lifecycleMeta(lifecycle: string): LifecycleMeta {
  if (lifecycle === 'core') return { label: 'core', tone: 'ok', hint: '核心经验：已验证有效，会被注入上下文' }
  if (lifecycle === 'stable') return { label: 'stable', tone: 'primary', hint: '稳定经验：已验证有效，会被注入上下文' }
  if (lifecycle === 'candidate') return { label: 'candidate', tone: 'neutral', hint: '候选经验：还没经过验证，暂不注入上下文' }
  // 认不出的档位（引擎将来新增）回落成中性徽章：不崩、也不假装它是什么。
  return { label: lifecycle || '未知', tone: 'neutral', hint: '引擎返回了界面还不认识的档位' }
}

/** 排序权重：core → stable → candidate，认不出的垫底。 */
function lifecycleRank(lifecycle: string): number {
  if (lifecycle === 'core') return 0
  if (lifecycle === 'stable') return 1
  if (lifecycle === 'candidate') return 2
  return 3
}

/** confidence 是 0..1 的小数；缺字段 / NaN 时不编一个数字出来，显示占位「—」。 */
function confidenceText(confidence: number | undefined): string {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return '—'
  return Math.round(Math.max(0, Math.min(1, confidence)) * 100) + '%'
}

/** 效果分 = 注入后该轮成功 : 失败。两边都为 0 ＝ 还没被注入过，说「尚未归因」而不是「0 : 0」。 */
function effectText(ok: number | undefined, bad: number | undefined): string {
  const good = ok ?? 0
  const failed = bad ?? 0
  if (good === 0 && failed === 0) return '尚未归因'
  return good + ' : ' + failed
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function MemoryLessonsPanel({ active }: { active: boolean }) {
  const engineReady = useEngine((s) => s.ready)

  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  /// 正在删除的名字：逐行禁用 + 转圈，避免重复点同一条发两次 DELETE。
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set<string>())
  /// 展开正文的名字：默认截断两行，展开态只放在组件里，不进 store（换个分组就重置无所谓）。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>())
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const engine = useEngine.getState()
    if (!engine.ready) {
      // 引擎没起来时给可读原因，而不是留一片空白：用户分不清「没有经验」和「没连上引擎」。
      setError('引擎还没就绪：启动完成后点右上角刷新，或稍等片刻重试')
      setLoaded(true)
      return
    }
    setLoading(true)
    try {
      const data = await engine.api<MemoryList>('/api/memory')
      setMemories(Array.isArray(data?.memories) ? data.memories : [])
      setError('')
    } catch (e) {
      // 读失败就摊原因；列表保持上一次的内容（没有就配合下面的空态说明），不静默空白。
      setError('读取经验库失败：' + errText(e))
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [])

  // 切到「AI 能力」这一组时才拉；引擎从「没起来」变成「就绪」时补一次（与 CompactionPanel 同一套时机）。
  useEffect(() => {
    if (!active) return
    void load()
  }, [active, engineReady, load])

  const sorted = useMemo(() => {
    // 排序：core → stable → candidate，同层按命中次数降序 —— 越靠上越值得先看。
    // 复制一份再排：直接 sort 会就地改 state 数组，和 React 的不可变约定打架。
    return [...memories].sort((a, b) => {
      const rank = lifecycleRank(a.lifecycle) - lifecycleRank(b.lifecycle)
      if (rank !== 0) return rank
      return (b.hit_count ?? 0) - (a.hit_count ?? 0)
    })
  }, [memories])

  /** 删一条并就地移除：成功才从列表里拿掉，不等整页刷新（滚动位置与展开态都保留）。 */
  const removeOne = useCallback(async (memory: Memory): Promise<boolean> => {
    try {
      await useEngine.getState().api('/api/memory/' + encodeURIComponent(memory.name), { method: 'DELETE' })
      setMemories((prev) => prev.filter((x) => x.name !== memory.name))
      return true
    } catch (e) {
      toast.error('删除「' + memory.name + '」失败：' + errText(e))
      return false
    }
  }, [])

  const handleRemove = useCallback(async (memory: Memory): Promise<void> => {
    setDeleting((prev) => new Set<string>(prev).add(memory.name))
    try {
      await removeOne(memory)
    } finally {
      setDeleting((prev) => {
        const next = new Set<string>(prev)
        next.delete(memory.name)
        return next
      })
    }
  }, [removeOne])

  /** 清空全部：逐条删（一条失败不影响后面，也不并发打满引擎）。 */
  const clearAll = useCallback(async (): Promise<void> => {
    setClearing(true)
    // 取快照再循环：循环里 setMemories 会改 memories，不能一边遍历一边改它。
    const targets = sorted
    let removed = 0
    let failed = 0
    for (const memory of targets) {
      setDeleting((prev) => new Set<string>(prev).add(memory.name))
      if (await removeOne(memory)) removed += 1
      else failed += 1
    }
    setDeleting(new Set<string>())
    setClearing(false)
    // 失败的那几条还在列表里；如实说清删了几条、剩了几条，不假装「已清空」。
    if (failed === 0) toast.success('已清空 ' + removed + ' 条经验')
    else toast.error('清空未完成：' + failed + ' 条没删掉，它们还在列表里')
  }, [removeOne, sorted])

  const toggleExpand = (name: string): void => {
    setExpanded((prev) => {
      const next = new Set<string>(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <Section
      className={active ? '' : 'hidden'}
      title='经验库'
      description='引擎从反复失败里总结出来的经验；只有 stable / core 会被注入上下文。'
      actions={
        <Button
          variant='ghost'
          size='icon-sm'
          title='重新读取经验库'
          disabled={loading || clearing}
          onClick={() => void load()}
        >
          <RefreshCw size={13} />
        </Button>
      }
    >
      <div className='flex min-w-0 flex-col gap-2.5 px-5 py-4' data-testid='memory-panel'>
        <p className='min-w-0 break-words text-12 leading-[1.7] text-ink-3'>
          这些是引擎从反复失败中总结出来的经验：只有 <span className='text-ink-2'>stable</span> /
          {' '}<span className='text-ink-2'>core</span> 会被注入上下文，candidate 只是候选、暂时不注入；
          一条经验如果总在失败的轮次里出现（效果分里失败占满），引擎会自动把它降级，直到不再注入。
        </p>

        {/* 加载失败 / 引擎未就绪：显式给原因。 */}
        {error ? (
          <p className='flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-12 leading-[1.65] text-danger'>
            <AlertTriangle size={13} className='mt-0.5 shrink-0' />
            <span className='min-w-0 break-all'>{error}</span>
          </p>
        ) : null}

        {/* 首次加载铺骨架；之后的刷新保留旧列表，只让右上角转圈，避免整块闪一下。 */}
        {loading && !loaded ? <SkeletonRows rows={3} /> : null}

        {loaded && !loading && sorted.length === 0 ? (
          <Empty
            compact
            art='tasks'
            title={error ? '暂时读不到经验库' : '还没有总结出经验'}
            description={error ? '连上引擎后点右上角刷新即可重新读取' : '任务出现重复失败时会自动总结'}
          />
        ) : null}

        {sorted.map((memory) => {
          const meta = lifecycleMeta(memory.lifecycle)
          const isOpen = expanded.has(memory.name)
          const busy = clearing || deleting.has(memory.name)
          const content = memory.content ?? ''
          // 短正文不套「展开 / 收起」：为三五行字多一个按钮，只是噪音。
          const clampable = content.trim().length > 80
          return (
            <div
              key={memory.name}
              data-testid='memory-row'
              className='flex min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-muted px-3.5 py-3'
            >
              <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
                <span className='min-w-0 truncate font-mono text-12 text-ink' title={memory.name}>{memory.name}</span>
                <Badge tone={meta.tone} title={meta.hint}>{meta.label}</Badge>
                <span className='shrink-0 text-11 text-ink-4' title='置信度：引擎对这条经验的把握程度'>
                  置信度 <span className='font-mono tabular-nums text-ink-2'>{confidenceText(memory.confidence)}</span>
                </span>
                <span className='shrink-0 text-11 text-ink-4' title='被检索命中的次数'>
                  命中 <span className='font-mono tabular-nums text-ink-2'>{memory.hit_count ?? 0}</span>
                </span>
                <span className='shrink-0 text-11 text-ink-4' title='注入后该轮成功 : 失败；两边都是 0 表示还没被注入过'>
                  效果 <span className='font-mono tabular-nums text-ink-2'>{effectText(memory.outcomes_ok, memory.outcomes_bad)}</span>
                </span>
                <span className='shrink-0 text-11 text-ink-4' title='证据条数：来自哪些轮次'>
                  证据 <span className='font-mono tabular-nums text-ink-2'>{memory.evidence?.length ?? 0}</span>
                </span>
                <Button
                  variant='ghost'
                  size='icon-sm'
                  className='ml-auto text-ink-3 hover:text-danger'
                  title='删除这条经验（删掉后不会再被注入）'
                  aria-label={'删除 ' + memory.name}
                  disabled={busy}
                  loading={deleting.has(memory.name)}
                  onClick={() => void handleRemove(memory)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
              {memory.description ? (
                <div className='min-w-0 truncate text-12 text-ink-3' title={memory.description}>{memory.description}</div>
              ) : null}
              {content.trim() ? (
                <>
                  <p
                    className={cn(
                      'min-w-0 whitespace-pre-wrap break-words text-12 leading-[1.65] text-ink-2',
                      clampable && !isOpen && 'line-clamp-2',
                    )}
                  >
                    {content}
                  </p>
                  {clampable ? (
                    <button
                      type='button'
                      onClick={() => toggleExpand(memory.name)}
                      className='self-start text-11 text-primary hover:underline'
                    >
                      {isOpen ? '收起' : '展开全文'}
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          )
        })}

        {sorted.length > 0 ? (
          <div className='mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line-soft pt-2.5'>
            <span className='min-w-0 flex-1 text-11 leading-[1.6] text-ink-4'>
              共 {sorted.length} 条经验。删掉后不会再被注入；以后再出现重复失败时，引擎会重新总结。
            </span>
            <Button
              variant='danger'
              size='sm'
              disabled={clearing || loading}
              loading={clearing}
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 size={13} /> 清空全部
            </Button>
          </div>
        ) : null}

        {/* 二次确认：这就是那句「删掉后不会再被注入，可随时重新积累」。 */}
        <ConfirmDialog
          open={confirmClear}
          onOpenChange={setConfirmClear}
          danger
          title='清空经验库？'
          description='这些经验删掉后不会再被注入上下文，引擎也不会再记住它们；以后再出现重复失败时会重新总结、重新积累。'
          confirmLabel='清空全部'
          onConfirm={() => { void clearAll() }}
        />
      </div>
    </Section>
  )
}

withDisplayName(MemoryLessonsPanel, 'MemoryLessonsPanel')
