/** 三步引导（首次启动时强制勾选；也充当「隐私与使用说明」的回看弹窗）。
 *
 *  两种模式，同一份实现与同一份文案：
 *   · blocking（第一次启动，或文案版本升级后的第一次）：右上角没有关闭按钮，
 *     Esc 与点遮罩都关不掉，必须勾选「我已阅读并同意」再点「进入」——
 *     这就是「强制勾选」的全部实现，除此之外什么都不拦（不登录、不注册）；
 *   · 非 blocking（从「设置 → 关于 → 隐私与使用说明」再看一次）：可以随时关闭。
 *
 *  无障碍与键盘：
 *   · 走 Radix Dialog（焦点陷阱、Esc、aria-modal、焦点归还都由它保证），
 *     因此两个模式共用同一套行为，只有「能不能关」这一处不同；
 *   · 步骤条是标准 tablist：左右方向键换步、Home / End 到首尾，选中项才进 Tab 序列（roving tabindex）；
 *   · 正文区自己可聚焦（tabIndex=0）—— 键盘用户能直接上下滚动长文案，不必去够滚动条；
 *   · 窄窗口：整个弹窗宽度按 min(620, 100vw-24) 收，正文区超高就自己滚，底部按钮换行不裁切。
 *
 *  组件本身是懒加载 chunk（见 OnboardingGate）：同意过之后的日常启动不会下载这份文案。
 */
import { useEffect, useId, useRef, useState } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, Database, ShieldCheck, Sparkles, TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from '../ui/Button'
import {
  CONSENT_HINT,
  CONSENT_LABEL,
  DISCLAIMER,
  GUIDE_STEPS,
  GUIDE_SUBTITLE,
  GUIDE_TITLE,
  REVIEW_HINT,
  type GuideGroup,
  type GuideItem,
} from '../../content/privacy'

export interface OnboardingGuideProps {
  /** 弹窗是否显示（Radix 需要在关闭时继续挂着，退场动画才播得出来）。 */
  open: boolean
  /** 阻断式：不给关闭入口。 */
  blocking: boolean
  /** 勾选状态（由外壳持有，同意之后要跨「重开」保持勾上）。 */
  agreed: boolean
  onAgreedChange: (v: boolean) => void
  /** 点了「进入」：落盘 + 关闭（由外壳负责）。 */
  onAccept: () => void
  /** 关闭（非阻断式下由关闭按钮 / Esc / 点遮罩触发）。 */
  onClose: () => void
}

/** 分组卡片的三种色调：默认中性，warn 是「要多看一眼」，ok 是「这条可以放心」。 */
const TONE_CLASS: Record<'plain' | 'warn' | 'ok', string> = {
  plain: 'border-line bg-muted',
  warn: 'border-warn/35 bg-warn-soft',
  ok: 'border-ok/30 bg-ok-soft',
}

/** 步骤条图标：顺序与 GUIDE_STEPS 一致（数量不符时最后一个兜底）。 */
const STEP_ICON = [Sparkles, Database, ShieldCheck]

/** 条目：主句 + 一句说明。路径类主句用等宽字体，逐字看得清。 */
function GuideRow({ item }: { item: GuideItem }) {
  return (
    <li className='flex gap-2 text-12 leading-[1.6] text-ink-2'>
      <span aria-hidden className='mt-[7px] size-[3px] shrink-0 rounded-full bg-ink-4' />
      <span className='min-w-0 break-words'>
        <span className={cn('text-ink', item.mono && 'font-mono text-11')}>{item.title}</span>
        {item.detail ? <span className='text-ink-3'> · {item.detail}</span> : null}
      </span>
    </li>
  )
}

/** 一块小卡片：标题 + 可选总述 + 条目列表。免责声明与「不会做的事」都用它。 */
function GuideBlock({ group }: { group: GuideGroup }) {
  const tone = group.tone ?? 'plain'
  return (
    <section className={cn('rounded-lg border px-4 py-3', TONE_CLASS[tone])}>
      <h3 className={cn('flex items-center gap-1.5 text-13 font-semibold text-ink', tone === 'warn' && 'text-warn')}>
        {tone === 'warn' ? <TriangleAlert size={13} className='shrink-0' aria-hidden /> : null}
        {group.heading}
      </h3>
      {group.lead ? <p className={cn('mt-1 text-12 leading-[1.6]', tone === 'warn' ? 'text-ink-2' : 'text-ink-3')}>{group.lead}</p> : null}
      {group.items && group.items.length > 0 ? (
        <ul className='mt-2 flex flex-col gap-1.5'>
          {group.items.map((item) => <GuideRow key={item.title} item={item} />)}
        </ul>
      ) : null}
    </section>
  )
}

export function OnboardingGuide({ open, blocking, agreed, onAgreedChange, onAccept, onClose }: OnboardingGuideProps) {
  const [step, setStep] = useState(0)
  const total = GUIDE_STEPS.length
  const last = total - 1
  const uid = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  /// 每次重新打开都从第一步开始；换步之后正文回到顶部（否则从第三步关掉再开，会停在半页中间）。
  useEffect(() => { if (open) setStep(0) }, [open])
  useEffect(() => { if (open) panelRef.current?.scrollTo({ top: 0 }) }, [step, open])

  const tabId = (i: number): string => uid + '-tab-' + i
  const panelId = uid + '-panel'

  /// tablist 的方向键：选中跟着焦点走（标准做法），Home / End 到首尾。
  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    let next: number | null = null
    if (event.key === 'ArrowRight') next = step === last ? 0 : step + 1
    else if (event.key === 'ArrowLeft') next = step === 0 ? last : step - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    setStep(next)
    tabRefs.current[next]?.focus()
  }

  /// 阻断式下所有「顺手关掉」的路子都堵死：只能勾选后点「进入」。
  const requestClose = (): void => { if (!blocking) onClose() }

  const current = GUIDE_STEPS[step]
  const StepIcon = STEP_ICON[step] ?? ShieldCheck

  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => { if (!next) requestClose() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className='dialog-scrim fixed inset-0 z-40 bg-black/35' />
        <RadixDialog.Content
          data-onboarding
          data-blocking={blocking ? 'true' : 'false'}
          data-step={step}
          style={{ width: 620, maxWidth: 'calc(100vw - 24px)' }}
          className='dialog-surface fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-line bg-overlay shadow-elev-4'
          onEscapeKeyDown={(event) => { if (blocking) event.preventDefault() }}
          onPointerDownOutside={(event) => { if (blocking) event.preventDefault() }}
          onFocusOutside={(event) => { if (blocking) event.preventDefault() }}
        >
          <div className='flex items-start gap-3 px-5 pt-4 pb-3'>
            <span aria-hidden className='mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-muted text-ink-2'>
              <StepIcon size={16} />
            </span>
            <div className='min-w-0 flex-1'>
              <RadixDialog.Title className='text-15 font-semibold text-ink'>{GUIDE_TITLE}</RadixDialog.Title>
              <RadixDialog.Description className='mt-1 text-12 text-ink-3'>{GUIDE_SUBTITLE}</RadixDialog.Description>
            </div>
            {/* 阻断式没有关闭按钮：这一处就是「必须勾选才能进入」在界面上的唯一体现。 */}
            {blocking ? null : (
              <RadixDialog.Close asChild>
                <Button variant='ghost' size='icon-sm' aria-label='关闭' data-onboarding-close className='-mr-2 -mt-1 text-ink-4 hover:text-ink'>
                  <X size={14} />
                </Button>
              </RadixDialog.Close>
            )}
          </div>

          {/* 步骤条：标准 tablist，方向键换步，选中项才进 Tab 序列。 */}
          <div
            role='tablist'
            aria-label='说明步骤'
            onKeyDown={onTabKey}
            className='flex flex-wrap items-center gap-1 border-b border-line-soft px-5 pb-3'
          >
            {GUIDE_STEPS.map((s, i) => {
              const on = i === step
              return (
                <button
                  key={s.id}
                  ref={(el) => { tabRefs.current[i] = el }}
                  type='button'
                  role='tab'
                  id={tabId(i)}
                  aria-selected={on}
                  aria-controls={panelId}
                  tabIndex={on ? 0 : -1}
                  data-onboarding-step={i}
                  onClick={() => setStep(i)}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-md border px-3 text-12 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
                    on ? 'border-line-strong bg-control font-medium text-ink shadow-elev-1' : 'border-transparent text-ink-3 hover:bg-hover hover:text-ink-2',
                  )}
                >
                  <span aria-hidden className={cn('grid size-4 place-items-center rounded-full text-10', on ? 'bg-primary text-white' : 'bg-sunken text-ink-3')}>{i + 1}</span>
                  {s.tab}
                </button>
              )
            })}
          </div>

          <div
            ref={panelRef}
            role='tabpanel'
            id={panelId}
            aria-labelledby={tabId(step)}
            tabIndex={0}
            className='flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain px-5 py-4'
          >
            {!blocking ? <p className='rounded-md border border-line bg-muted px-3 py-2 text-11 leading-[1.5] text-ink-3'>{REVIEW_HINT}</p> : null}
            <div>
              <h2 className='text-14 font-semibold text-ink'>{current.title}</h2>
              <p className='mt-1 text-12 leading-[1.6] text-ink-2'>{current.lead}</p>
            </div>
            {current.groups.map((group) => <GuideBlock key={group.heading} group={group} />)}
            {/* 免责声明只跟在最后一步后面：前面三步是「发生了什么」，它是最终的那条兜底措辞。 */}
            {step === last ? <GuideBlock group={DISCLAIMER} /> : null}
          </div>

          <div className='flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line-soft bg-muted px-5 py-3'>
            <label htmlFor={uid + '-agree'} className='flex min-w-0 flex-1 basis-[240px] cursor-pointer items-start gap-2'>
              <input
                id={uid + '-agree'}
                type='checkbox'
                data-onboarding-agree
                checked={agreed}
                onChange={(event) => onAgreedChange(event.currentTarget.checked)}
                className='mt-[3px] size-4 shrink-0 cursor-pointer accent-primary'
              />
              <span className='min-w-0'>
                <span className='block text-13 text-ink'>{CONSENT_LABEL}</span>
                <span className='mt-0.5 block text-11 leading-[1.5] text-ink-3'>{CONSENT_HINT}</span>
              </span>
            </label>
            <div className='flex shrink-0 flex-wrap items-center gap-2'>
              {step > 0 ? (
                <Button variant='ghost' data-onboarding-prev onClick={() => setStep(step - 1)}>
                  <ChevronLeft size={14} /> 上一步
                </Button>
              ) : null}
              {step < last ? (
                <Button variant='secondary' data-onboarding-next onClick={() => setStep(step + 1)}>
                  下一步 <ChevronRight size={14} />
                </Button>
              ) : null}
              {step === last ? (
                blocking ? (
                  // 没勾选就是禁用的：唯一一条进门的路，界面上不给出别的解释空间。
                  <Button variant='primary' data-onboarding-enter disabled={!agreed} onClick={() => { if (agreed) onAccept() }}>
                    进入
                  </Button>
                ) : (
                  <Button variant='primary' data-onboarding-done onClick={onClose}>完成</Button>
                )
              ) : null}
            </div>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
