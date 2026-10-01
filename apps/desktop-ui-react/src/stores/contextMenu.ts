import { create } from 'zustand'

export interface CtxItem {
  label?: string
  icon?: React.ReactNode
  danger?: boolean
  divider?: boolean
  disabled?: boolean
  onSelect?: () => void
}

interface CtxState {
  open: boolean
  x: number
  y: number
  items: CtxItem[]
  show: (x: number, y: number, items: CtxItem[]) => void
  hide: () => void
}

/// 全局右键菜单：浏览器原生菜单在被接管后不该再出现（设置页/列表/消息区都要自己的菜单）。
export const useContextMenu = create<CtxState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  show: (x, y, items) => set({ open: true, x, y, items }),
  hide: () => set({ open: false, items: [] }),
}))

export function showContextMenu(x: number, y: number, items: CtxItem[]): void {
  useContextMenu.getState().show(x, y, items)
}
