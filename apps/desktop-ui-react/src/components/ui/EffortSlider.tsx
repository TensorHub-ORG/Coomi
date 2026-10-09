import { useEffect, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import * as RadixPopover from '@radix-ui/react-popover'
import { cn } from '../../lib/cn'
import { EFFORT_LABELS, useAgent, type ReasoningEffort } from '../../stores/agent'
import { useSession } from '../../stores/session'
import { Button } from './Button'

/** 档位下标 ↔ 取值。滑块只认下标，取值一律从 EFFORT_LABELS 取。 */
export function effortIndex(value: ReasoningEffort): number {
  const index = EFFORT_LABELS.findIndex((entry) => entry.value === value)
  return index < 0 ? 0 : index
}
export function effortAt(index: number): ReasoningEffort {
  const clamped = Math.min(EFFORT_LABELS.length - 1, Math.max(0, Math.round(index)))
  return (EFFORT_LABELS[clamped] ?? EFFORT_LABELS[0]).value
}

const panelCls = 'pop-surface z-50 w-[272px] overflow-hidden rounded-xl border border-line bg-overlay p-3 shadow-elev-3'

/**
 * 思考强度滑块。
 *
 * **外观与特效照搬 dsh-effort-switcher**（lemonorangeapple/dsh-effort-switcher 的 index.js）：
 *   26px 胶囊轨道 / 13px 圆角 / #4c8dff 填充 / 30px 纯白无阴影滑钮 / 4px 白点刻度 /
 *   315ms ease 过渡，以及**只有最高档才显形的蓝→紫渐变**（它的 .dsh-es-sliderBloom）。
 *   没有毛玻璃、没有常驻光晕 —— 我上一版加的 .effort-glass 与呼吸动画按这个基准删掉。
 *
 * 适配（不是照搬）的部分，因为它接的是 DSH 的 modelDirectories，这里接的是
 * ReasoningEffort + setEffort → /api/agent/preferences：
 *   · 档位是 CoomiPlus 固定六档（含最左的「自动」），不按模型公布；
 *   · 每一档都能选到：不过滤、不跳档；
 *   · 拖动只写本地 draft，松手才提交；提交后保留 pending 直到 store 追上 ——
 *     这是照抄它的防回弹做法（滑钮不会先弹回原位再跳过去）；
 *   · aria-valuenow 是下标、aria-valuetext 是中文档位名（W3C 离散滑块口径）。
 */
export function EffortSlider({ className }: { className?: string }) {
  const effort = useAgent((s) => s.effort)
  const setEffort = useAgent((s) => s.setEffort)
  const status = useAgent((s) => s.reasoningStatus)
  const saving = useAgent((s) => s.effortSaving)
  const error = useAgent((s) => s.effortError)
  const load = useAgent((s) => s.load)
  const provider = useSession((s) => s.currentProviderId)
  const model = useSession((s) => s.currentModel)
  const revision = useAgent((s) => s.providerRevision)
  useEffect(() => { void load() }, [load, provider, model, revision])
  const applicable = status && status.providerId === provider && status.model === model ? status : null
  const stored = effortIndex(effort)
  const [draft, setDraft] = useState<number | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  useEffect(() => {
    if (pending !== null && stored === pending) setPending(null)
  }, [pending, stored])
  useEffect(() => { setDraft(null); setPending(null) }, [provider, model])

  const index = draft ?? pending ?? stored
  const current = EFFORT_LABELS[index] ?? EFFORT_LABELS[0]
  const last = EFFORT_LABELS.length - 1
  const pct = last > 0 ? (index / last) * 100 : 0
  const atMax = index === last

  const commit = (): void => {
    if (draft === null) return
    const next = draft
    setDraft(null)
    if (next === stored) return
    setPending(next)
    const value = effortAt(next)
    if (value !== 'auto' && applicable && !applicable.selectableLevels.includes(value)) { setPending(null); return }
    void setEffort(value).finally(() => setPending(null))
  }

  return (
    <div className={cn('flex w-full flex-col', className)} data-effort-slider>
      <div className='es-head'>
        <span>思考强度</span>
        <strong>{current.label}</strong>
      </div>
      <div className='es-rail'>
        <div className='es-groove'>
          <div className='es-track' />
          {/* 填充宽度与滑钮位置共用同一个百分比，两条都走同一条 315ms 曲线，不会脱节。 */}
          <div className={cn('es-fill', atMax && 'es-fill-max')} style={{ width: pct + '%' }}>
            <div className='es-bloom' />
          </div>
          <div className='es-ticks'>
            {EFFORT_LABELS.map((entry) => <span key={entry.value} className='es-tick' />)}
          </div>
        </div>
        <div className='es-knob' style={{ left: pct + '%' }}>
          <div className='es-knob-face' />
        </div>
        {/* 原生 range 只当把手：透明、盖在轨道上，键盘/读屏/吸附全由它提供。 */}
        <input
          type='range'
          min={0}
          max={last}
          step={1}
          value={index}
          disabled={saving || applicable?.mode === 'unconfigured'}
          aria-label='思考强度'
          aria-valuetext={current.label}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className='es-input'
        />
      </div>
      <p className='es-desc'>{current.hint}</p>
      {effort !== 'auto' && applicable?.mode === 'unconfigured' ? (
        <Button size='sm' variant='ghost' disabled={saving} onClick={() => { void setEffort('auto') }}>恢复厂商默认</Button>
      ) : null}
      <p className='es-desc' role='status'>
        {saving ? '正在保存…' : error ? '未保存：' + error : !applicable ? '模型参数状态待确认'
          : applicable.mode === 'unconfigured' ? '当前模型尚未配置思考参数映射，无法发送此设置'
          : applicable.requested === 'auto' ? '自动：不发送强度覆盖，使用厂商默认'
          : !applicable.sent ? '该档位没有配置映射，不会发送'
          : '将发送 ' + applicable.field + ' = ' + JSON.stringify(applicable.wireValue) + (applicable.mode === 'standard-unverified' ? '（厂商支持待确认）' : '（模型配置映射）')}
      </p>
    </div>
  )
}

/**
 * 输入栏入口：点一下展开小面板，滑块在面板里。
 * 触发器对齐 DSH 的 PreferenceRow（当前值 + chevron），但**不合并模型选择** ——
 * CoomiPlus 里模型是独立控件，合并会改掉现有交互。
 */
export function EffortPicker({ className }: { className?: string }) {
  const effort = useAgent((s) => s.effort)
  const [open, setOpen] = useState(false)
  const current = EFFORT_LABELS[effortIndex(effort)] ?? EFFORT_LABELS[0]

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        <Button
          variant='ghost'
          size='sm'
          className={cn('shrink-0 gap-1 text-ink-3', className, open && 'bg-active text-ink')}
          aria-label={'思考强度：' + current.label}
          title={'思考强度：' + current.label + ' — ' + current.hint}
          data-effort-picker
        >
          <Brain size={14} className='shrink-0' />
          <span className='text-ink-3'>{current.label}</span>
          <ChevronDown size={12} className={cn('shrink-0 text-ink-4 transition-transform duration-[var(--motion-fast)]', open && 'rotate-180')} />
        </Button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content align='end' side='top' sideOffset={6} collisionPadding={8} className={panelCls}>
          <EffortSlider />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  )
}
