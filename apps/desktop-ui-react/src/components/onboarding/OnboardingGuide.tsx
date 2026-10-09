import { useEffect, useId, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Database, Globe, ShieldCheck, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { DISCLAIMER, GUIDE_STEPS, type GuideGroup } from '../../content/privacy'

export interface OnboardingGuideProps {
  open: boolean
  blocking: boolean
  agreed: boolean
  onAgreedChange: (v: boolean) => void
  onAccept: () => void
  onClose: () => void
}

function DetailsGroup({ group }: { group: GuideGroup }) {
  return <section className='py-3'>
    <h3 className='text-13 font-medium text-ink'>{group.heading}</h3>
    {group.lead && <p className='mt-2 text-12 leading-relaxed text-ink-3'>{group.lead}</p>}
    {group.items && <ul className='mt-2 space-y-2 text-12 leading-relaxed text-ink-3'>
      {group.items.map((item) => <li key={item.title}><span className='text-ink-2'>{item.title}</span>{item.detail ? '：' + item.detail : ''}</li>)}
    </ul>}
  </section>
}

export function OnboardingGuide({ open, blocking, agreed, onAgreedChange, onAccept, onClose }: OnboardingGuideProps) {
  const uid = useId()
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { if (open) setExpanded(false) }, [open])
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !blocking) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className='dialog-scrim fixed inset-0 z-40 bg-black/35' />
      <Dialog.Content data-onboarding data-blocking={String(blocking)}
        className='dialog-surface fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-overlay shadow-elev-4'
        onEscapeKeyDown={(e) => { if (blocking) e.preventDefault() }}
        onPointerDownOutside={(e) => { if (blocking) e.preventDefault() }}>
        <header className='flex items-start gap-4 px-8 pt-8 pb-5'>
          <div className='flex-1'>
            <p className='mb-5 text-20 font-semibold tracking-tight text-ink'>Coomi<span className='text-primary'>.</span></p>
            <Dialog.Title className='text-20 font-semibold text-ink'>开始之前</Dialog.Title>
            <Dialog.Description className='mt-2 text-13 text-ink-3'>了解数据与权限，然后开始你的第一个会话。</Dialog.Description>
          </div>
          {!blocking && <Dialog.Close asChild><Button variant='ghost' size='icon-sm' aria-label='关闭说明' data-onboarding-close><X size={16} /></Button></Dialog.Close>}
        </header>
        <div className='min-h-0 overflow-y-auto px-8 pb-6'>
          <div className='divide-y divide-line-soft'>
            {[
              { icon: Database, title: '数据保存在本机', text: '会话、设置和记忆保存在本地，可自行备份。' },
              { icon: Globe, title: '模型由你选择', text: '提问与相关上下文会发往所选服务商，可能产生费用。' },
              { icon: ShieldCheck, title: '操作权限由你决定', text: 'AI 可读写文件、执行命令与联网；重要操作请复核。' },
            ].map(({ icon: Icon, title, text }) => <div key={title} className='flex gap-4 py-4'>
              <Icon size={19} strokeWidth={1.6} className='mt-0.5 shrink-0 text-ink-3' />
              <div><h2 className='text-13 font-medium text-ink'>{title}</h2><p className='mt-1 text-12 leading-relaxed text-ink-3'>{text}</p></div>
            </div>)}
          </div>
          <button type='button' className='mt-4 text-12 text-primary underline-offset-4 hover:underline' aria-expanded={expanded} aria-controls={uid + '-details'} onClick={() => setExpanded(!expanded)}>{expanded ? '收起完整说明' : '阅读隐私与使用说明 →'}</button>
          {expanded && <div id={uid + '-details'} className='mt-5 border-t border-line-soft pt-3'>
            {GUIDE_STEPS.map((step) => <section key={step.id} className='mb-5'><h2 className='text-14 font-semibold text-ink'>{step.title}</h2><p className='mt-2 text-12 text-ink-3'>{step.lead}</p>{step.groups.map((g) => <DetailsGroup key={g.heading} group={g} />)}</section>)}
            <DetailsGroup group={DISCLAIMER} />
          </div>}
        </div>
        <footer className='flex flex-wrap items-center justify-between gap-4 border-t border-line-soft px-8 py-5'>
          {blocking ? <><label className='flex cursor-pointer items-center gap-2 text-12 text-ink-2'><input type='checkbox' data-onboarding-agree checked={agreed} onChange={(e) => onAgreedChange(e.currentTarget.checked)} className='size-4 accent-primary' />我已阅读并同意使用说明</label><Button data-onboarding-enter variant='primary' disabled={!agreed} onClick={() => { if (agreed) onAccept() }}>开始使用</Button></> : <><span className='text-12 text-ink-3'>可随时从「帮助」重新查看</span><Button variant='primary' data-onboarding-done onClick={onClose}>完成</Button></>}
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
