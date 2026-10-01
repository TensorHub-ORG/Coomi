import { create } from 'zustand'

/// 全局确认/输入弹窗：把 window.confirm / window.prompt 全换掉，
/// 用同一个 store 驱动挂载在 App 根部的一对对话框。
interface PromptRequest {
  id: number
  title: string
  description?: string
  value: string
  placeholder?: string
  confirmLabel: string
  danger?: boolean
  multiline?: boolean
  resolve: (value: string | null) => void
}

interface DialogState {
  request: PromptRequest | null
  ask: (options: Omit<PromptRequest, 'id' | 'resolve' | 'value' | 'confirmLabel'> & { value?: string; confirmLabel?: string }) => Promise<string | null>
  resolve: (value: string | null) => void
}

let seq = 0

export const usePromptDialog = create<DialogState>((set, get) => ({
  request: null,
  ask: (options) =>
    new Promise<string | null>((resolve) => {
      set({
        request: {
          id: ++seq,
          title: options.title,
          description: options.description,
          value: options.value ?? '',
          placeholder: options.placeholder,
          confirmLabel: options.confirmLabel ?? '确定',
          danger: options.danger,
          multiline: options.multiline,
          resolve,
        },
      })
    }),
  resolve: (value) => {
    const current = get().request
    set({ request: null })
    current?.resolve(value)
  },
}))

/** 文本输入弹窗：返回 null 表示取消。 */
export function promptText(options: {
  title: string
  description?: string
  value?: string
  placeholder?: string
  confirmLabel?: string
  multiline?: boolean
}): Promise<string | null> {
  return usePromptDialog.getState().ask(options)
}

/** 确认弹窗：返回 true 表示用户确认。 */
export async function confirmAction(options: {
  title: string
  description?: string
  confirmLabel?: string
  danger?: boolean
}): Promise<boolean> {
  const value = await usePromptDialog.getState().ask({ ...options, value: '' })
  return value !== null
}
