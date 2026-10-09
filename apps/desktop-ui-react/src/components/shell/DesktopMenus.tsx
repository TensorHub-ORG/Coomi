import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Menu, type MenuEntry } from '../ui/Menu'
import { useUi } from '../../stores/ui'
import { useSession } from '../../stores/session'
import { ipc } from '../../lib/ipc'
import { openOnboarding } from '../onboarding/store'
import { LIST_MIN_VIEWPORT } from './dockShared'

const HelpView = lazy(() => import('../../views/HelpView').then((m) => ({ default: m.HelpView })))

/** Remember the editing target before the menu takes focus. */
export function DesktopMenus() {
  const [help, setHelp] = useState(false)
  const target = useRef<HTMLElement | null>(null)
  const selection = useRef<Range | null>(null)
  useEffect(() => {
    const remember = () => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body || el === document.documentElement || el.closest('[data-desktop-menus], [role="menu"]')) return
      target.current = el
      const current = window.getSelection()
      selection.current = current?.rangeCount ? current.getRangeAt(0).cloneRange() : null
    }
    document.addEventListener('focusin', remember)
    document.addEventListener('selectionchange', remember)
    return () => {
      document.removeEventListener('focusin', remember)
      document.removeEventListener('selectionchange', remember)
    }
  }, [])
  const run = (action: () => Promise<unknown>) => { void action().catch((e) => toast.error(e instanceof Error ? e.message : String(e))) }
  const edit = (command: string) => {
    // Wait for the menu's focus restoration before restoring the editor.
    window.setTimeout(() => {
      target.current?.focus()
      if (selection.current && !(target.current instanceof HTMLInputElement) && !(target.current instanceof HTMLTextAreaElement)) {
        const current = window.getSelection()
        current?.removeAllRanges()
        current?.addRange(selection.current)
      }
      if (command === 'paste') {
        run(async () => {
          const text = await navigator.clipboard.readText()
          if (!document.execCommand('insertText', false, text)) toast.error('请在输入框中使用 Ctrl+V 粘贴')
        })
      } else document.execCommand(command)
    }, 0)
  }
  const menus: Array<{ label: string; items: MenuEntry[] }> = [
    { label: '文件', items: [
      { label: '新建会话 · Ctrl+N', onSelect: () => run(async () => { useUi.getState().setView('chat'); await useSession.getState().newSession(); useUi.getState().focusComposer() }) },
      { label: '打开工作目录…', onSelect: () => run(async () => { const dir = await ipc<string | null>('pick_directory'); if (dir) await useSession.getState().applyCwd(dir) }) },
      { divider: true },
      { label: '设置', onSelect: () => useUi.getState().setView('settings') },
      { label: '收起到托盘', onSelect: () => run(() => ipc('win_close')) },
    ] },
    { label: '编辑', items: [
      { label: '撤销 · Ctrl+Z', onSelect: () => edit('undo') },
      { label: '重做 · Ctrl+Y', onSelect: () => edit('redo') },
      { divider: true },
      { label: '剪切 · Ctrl+X', onSelect: () => edit('cut') },
      { label: '复制 · Ctrl+C', onSelect: () => edit('copy') },
      { label: '粘贴 · Ctrl+V', onSelect: () => edit('paste') },
      { label: '全选 · Ctrl+A', onSelect: () => edit('selectAll') },
    ] },
    { label: '视图', items: [
      { label: '会话', onSelect: () => useUi.getState().setView('chat') },
      { label: '技能中心', onSelect: () => useUi.getState().setView('skills') },
      { label: '产物中心', onSelect: () => useUi.getState().setView('artifacts') },
      { divider: true },
      { label: '显示 / 隐藏会话列表', onSelect: () => { const ui = useUi.getState(); if (window.innerWidth < LIST_MIN_VIEWPORT) ui.setListDrawerOpen(!ui.listDrawerOpen); else ui.toggleListCollapsed() } },
      { label: '显示 / 隐藏右侧栏 · Ctrl+B', onSelect: () => useUi.getState().togglePanel() },
      { divider: true },
      { label: '亮色主题', onSelect: () => useUi.getState().setThemeMode('light') },
      { label: '深色主题', onSelect: () => useUi.getState().setThemeMode('dark') },
      { label: '跟随系统', onSelect: () => useUi.getState().setThemeMode('system') },
    ] },
    { label: '帮助', items: [
      { label: '帮助中心与快捷键', onSelect: () => setHelp(true) },
      { label: '隐私与使用说明', onSelect: () => openOnboarding() },
    ] },
  ]
  return <>
    <nav data-desktop-menus aria-label='应用菜单' className='no-drag desktop-menus'>
      {menus.map(({ label, items }) => <Menu key={label} align='start' items={items} onCloseAutoFocus={label === '编辑' ? (e) => { e.preventDefault(); target.current?.focus() } : undefined} trigger={<button type='button' className='desktop-menu-trigger'>{label}</button>} />)}
    </nav>
    {help ? <Suspense fallback={null}><HelpView open={help} onClose={() => setHelp(false)} /></Suspense> : null}
  </>
}
