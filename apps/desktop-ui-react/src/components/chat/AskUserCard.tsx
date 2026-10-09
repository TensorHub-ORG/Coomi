import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, CornerDownLeft, HelpCircle, PencilLine, SkipForward, TimerOff } from 'lucide-react'
import { useSession } from '../../stores/session'
import { askAnswerSummary, type AskAnswerItem, type AskQuestion, type ChatItem } from '../../lib/chat'
import { AgentState } from '../ai/AgentState'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { cn } from '../../lib/cn'

type AskItem = Extract<ChatItem, { kind: 'ask' }>

/** 选项左侧的数字键角标：数字键选选项这件事必须在画面上看得见，
    否则「按 1 能选」只有试过的人知道。 */
function KeyCap({ n, on }: { n: number; on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-[4px] border text-[10px] leading-none',
        on ? 'border-primary/40 bg-canvas text-primary' : 'border-line bg-sunken text-ink-4',
      )}
    >
      {n}
    </span>
  )
}

/**
 * AI 提问卡（对话流里的那一条）。
 *
 * 与「审批卡」（components/chat/Dialogs.tsx 的 ApprovalDialog）的分工：
 *   · 审批卡是弹窗 —— 挡住整屏、选完就关，因为它是**危险动作的闸门**；
 *   · 提问卡是对话流里的普通条目 —— 它不该打断你正在读的那段回答，更不该选完就消失：
 *     卡片答完**留在原地**显示「你选了什么」，回头翻记录时还看得到当时的选择。
 *
 * 键盘：数字键选当前这一问的选项、Enter 确认、Esc 跳过（只由 stores/session.ts
 * 认领出来的「最后一张没答的卡」接管，历史里答过的卡不会跟着抢按键）。
 * 在「其他（自己填）」输入框里打字时只让 Enter / Esc 生效，数字键照常输入。
 */
export function AskUserCard({ item }: { item: AskItem }) {
  const answerQuestion = useSession((s) => s.answerQuestion)
  const questions = item.questions
  /// 选中的选项值（按问题 id）：单选一进一出，多选可多个。
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  /// 「其他（自己填）」的文本（按问题 id）。
  const [custom, setCustom] = useState<Record<string, string>>({})
  /// 数字键作用在哪一问上：默认第一问，点过哪一问就跟着它走。
  const [activeIndex, setActiveIndex] = useState(0)

  const answer = item.answer
  /** 答过的卡不再接收任何交互：它现在的职责是「记录」，不是「输入」。 */
  const done = answer !== null
  const active = Math.min(activeIndex, Math.max(0, questions.length - 1))

  const buildItems = useCallback((): Record<string, AskAnswerItem> => {
    const out: Record<string, AskAnswerItem> = {}
    for (const q of questions) {
      const values = (picked[q.id] ?? []).filter(Boolean)
      const text = (custom[q.id] ?? '').trim()
      if (values.length || text) out[q.id] = { values, custom: text }
    }
    return out
  }, [picked, custom, questions])

  const submit = useCallback((): void => {
    const items = buildItems()
    // 什么都没选就按确认 = 跳过：不给「提交了一个空答案」这种含糊状态。
    answerQuestion({ items, skipped: Object.keys(items).length === 0 }, item.callId)
  }, [answerQuestion, buildItems, item.callId])

  const skip = useCallback((): void => {
    answerQuestion({ skipped: true }, item.callId)
  }, [answerQuestion, item.callId])

  /** 选中 / 取消一个选项：multi 是开关，单选是「再点一次取消」。 */
  const pick = useCallback((q: AskQuestion, value: string): void => {
    setPicked((prev) => {
      const now = prev[q.id] ?? []
      if (q.multi) return { ...prev, [q.id]: now.includes(value) ? now.filter((v) => v !== value) : [...now, value] }
      return { ...prev, [q.id]: now.length === 1 && now[0] === value ? [] : [value] }
    })
  }, [])

  /* 键盘只由「当前挂起的那一张」接管：item.pending 由 stores/session.ts 的 withAskState
     按「全表最后一张没答的卡」认领出来，所以同一时刻至多一张卡在听按键。 */
  useEffect(() => {
    if (done || !item.pending) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
      const target = event.target as HTMLElement | null
      const typing = !!target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName || ''))
      if (event.key === 'Escape') { event.preventDefault(); skip(); return }
      if (event.key === 'Enter') {
        // 多行输入框里的 Enter 是换行（本卡片目前没有 textarea，留着以后不被误伤）。
        if (target?.tagName === 'TEXTAREA') return
        event.preventDefault()
        submit()
        return
      }
      if (typing) return
      // 数字键：作用在「当前这一问」上；对应位置没有选项就不拦（让浏览器照常处理）。
      const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : 0
      if (!digit) return
      const q = questions[active]
      const option = q?.options[digit - 1]
      if (!option) return
      event.preventDefault()
      pick(q, option.value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [done, item.pending, questions, active, pick, submit, skip])

  const summary = useMemo(() => (answer ? askAnswerSummary(answer, questions) : ''), [answer, questions])

  return (
    <div
      data-ask-card={item.callId}
      data-ask-answered={done ? '1' : undefined}
      className='mx-auto w-full max-w-[var(--content-w)] px-6 py-2'
    >
      <div
        role='group'
        aria-label='AI 的提问'
        className={cn(
          'animate-bar flex flex-col gap-3 rounded-xl border p-3',
          done ? 'border-line bg-muted' : 'border-primary/35 bg-primary-soft elev-1',
        )}
      >
        <div className='flex items-start gap-2'>
          {done
            ? <Check size={15} className='mt-0.5 shrink-0 text-ok' />
            : <HelpCircle size={15} className='mt-0.5 shrink-0 text-primary' />}
          <div className='min-w-0 flex-1'>
            <p className='flex items-center gap-1.5 text-12 font-medium text-ink'>
              {done ? '你的回答' : 'AI 想先问你一句'}
              {!done ? <AgentState state='awaiting' size='xs' tone='primary' /> : null}
            </p>
            {/* 答过之后正文换成「你选了什么」：与问题一起留在卡片上，才是完整的记录。 */}
            <p className='mt-1 break-words text-13 leading-[1.6] text-ink-2' data-ask-summary={done ? '1' : undefined}>
              {done ? summary : (questions.length ? questions.length + ' 个问题在等你回答' : '请输入你的回答')}
            </p>
          </div>
        </div>

        {done ? null : (
          <div className='flex flex-col gap-3'>
            {questions.map((q, index) => {
              const values = picked[q.id] ?? []
              const mine = index === active
              return (
                <div
                  key={q.id}
                  data-ask-question={q.id}
                  onMouseDown={() => setActiveIndex(index)}
                  className={cn(
                    'rounded-lg border bg-surface/70 p-2.5 transition-colors duration-[var(--motion-fast)]',
                    mine && questions.length > 1 ? 'border-primary/40' : 'border-line-soft',
                  )}
                >
                  <p className='mb-2 flex items-start gap-1.5 text-13 text-ink'>
                    <span className='min-w-0 flex-1 break-words'>{q.header ? <span className='mr-1.5 text-ink-3'>[{q.header}]</span> : null}{q.question}</span>
                  </p>
                  {q.options.length ? (
                    <div className='flex flex-wrap gap-1.5'>
                      {q.options.map((option, at) => {
                        const on = values.includes(option.value)
                        return (
                          <button
                            key={option.value}
                            type='button'
                            data-ask-option={option.value}
                            aria-pressed={on}
                            onClick={() => { setActiveIndex(index); pick(q, option.value) }}
                            className={cn(
                              'flex h-7 max-w-full items-center gap-1.5 rounded-md border px-2 text-12 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
                              on
                                ? 'border-primary bg-primary-soft font-medium text-primary'
                                : 'border-line bg-surface text-ink-2 hover:bg-hover',
                            )}
                          >
                            <KeyCap n={at + 1} on={on} />
                            <span className='truncate'>{option.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                  {/* 「其他（自己填）」：始终在场 —— 选项永远不可能穷尽用户想说的话。 */}
                  <div className='mt-2 flex items-center gap-1.5'>
                    <PencilLine size={12} className='shrink-0 text-ink-4' />
                    <Input
                      data-ask-custom={q.id}
                      className='h-7 text-12'
                      value={custom[q.id] ?? ''}
                      placeholder='其他（自己填）'
                      aria-label='其他（自己填）'
                      onFocus={() => setActiveIndex(index)}
                      onChange={(e) => setCustom((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {done ? (
          <p className='flex items-center gap-1.5 text-11 text-ink-4'>
            {answer?.timedOut
              ? <><TimerOff size={12} /> 等待超时，已按跳过处理（可在设置里改「提问等待超时」）</>
              : <><Check size={12} /> 已回答 · 这张卡会留在会话里</>}
          </p>
        ) : (
          <div className='flex items-center justify-end gap-1.5'>
            <span className='mr-auto hidden items-center gap-2 text-11 text-ink-4 sm:flex'>
              <span className='flex items-center gap-1'><KeyCap n={1} on={false} /> 选</span>
              <span className='flex items-center gap-1'><CornerDownLeft size={11} /> 确认</span>
              <span>Esc 跳过</span>
            </span>
            <Button variant='ghost' size='sm' data-ask-skip onClick={skip}><SkipForward size={12} /> 跳过</Button>
            <Button variant='primary' size='sm' data-ask-submit onClick={submit}>{questions.length > 1 ? '提交' : '确认'}</Button>
          </div>
        )}
      </div>
    </div>
  )
}
