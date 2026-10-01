import { useEffect, useState } from 'react'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Input, Textarea } from '../ui/Input'
import { usePromptDialog } from '../../stores/dialogs'

/** 全局弹窗宿主：替代 window.prompt / window.confirm 的丑陋原生样式。
    两种形态：单行输入（Enter 提交）与多行输入（Cmd/Ctrl + Enter 提交，正文里的换行照旧）；
    没有输入框时就是一次确认框，按钮顺序固定「取消 → 确认」，危险操作用 danger 变体。 */
export function DialogHost() {
  const request = usePromptDialog((s) => s.request)
  const resolve = usePromptDialog((s) => s.resolve)
  const [value, setValue] = useState('')

  useEffect(() => { setValue(request?.value ?? '') }, [request?.id, request?.value])

  const confirm = (): void => resolve(value)
  const cancel = (): void => resolve(null)

  const isConfirm = !!request && !request.multiline && request.value === '' && !request.placeholder

  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => { if (!open) cancel() }}
      title={request?.title ?? ''}
      description={request?.description}
      width={request?.multiline ? 560 : 440}
      footer={
        <>
          <Button variant='ghost' onClick={cancel}>取消</Button>
          <Button variant={request?.danger ? 'danger' : 'primary'} onClick={confirm}>{request?.confirmLabel ?? '确定'}</Button>
        </>
      }
    >
      {request && !isConfirm ? (
        request.multiline ? (
          <div className='flex flex-col gap-1.5'>
            <Textarea
              autoFocus
              rows={8}
              value={value}
              placeholder={request.placeholder}
              aria-describedby='dialog-host-hint'
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); confirm() }
              }}
            />
            {/* 多行框里 Enter 是换行，提交得靠组合键——写在旁边，别让用户猜。 */}
            <p id='dialog-host-hint' className='text-11 text-ink-4'>Ctrl / ⌘ + Enter 提交，Enter 换行</p>
          </div>
        ) : (
          <div className='flex flex-col gap-1.5'>
            <Input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              aria-describedby='dialog-host-hint'
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirm() } }}
            />
            <p id='dialog-host-hint' className='text-11 text-ink-4'>Enter 提交</p>
          </div>
        )
      ) : null}
    </Dialog>
  )
}
