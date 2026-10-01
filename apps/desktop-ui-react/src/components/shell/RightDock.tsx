/**
 * 右侧侧栏：贴边图标条 + 可展开的面板。
 * 两者都是 flex 兄弟节点（图标条固定 40px、面板宽度由外层 Panel 决定），
 * 不用 absolute/fixed 覆盖主内容列，因此输入框永远不会被压在侧栏下面。
 *
 * 切页动效：这一块整体是**外壳**——登记为命名元素（view-transition-name: app-dock）
 * 并在新旧快照里 animation:none 定住，再叠 contain: layout paint，
 * 所以切页时它零位移，只有内容列在动。规则在 base.css 的「页面级过渡」一节。
 */
import type { RefObject } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { cn } from '../../lib/cn'
import { useUi } from '../../stores/ui'
import { Tip } from '../ui/Overlay'
import { PreviewPanel } from './PreviewPanel'
import { DOCK_TABS, openDockTab, useDockTab, useRunningTaskCount } from './dockShared'

export function RightDock({ panelRef }: {
  /** 外层 dock 面板的句柄：展开/收起 = 把面板 resize 到「图标条 + 预览宽」或只剩图标条。 */
  panelRef?: RefObject<PanelImperativeHandle | null>
}) {
  const open = useUi((s) => s.panelOpen)
  const togglePanel = useUi((s) => s.togglePanel)
  const tab = useDockTab()
  const runningTasks = useRunningTaskCount(true)

  // 展开/收起的面板宽度同步在 App 里统一做（见那里的「面板宽度对齐」）：
  // 宽度是布局层的事，放在这儿会和列表面板的对齐抢方向盘。
  return (
    <div data-dock-root data-shell-part='dock' data-shell-frozen className='flex h-full w-full min-w-0 items-stretch'>
      <PreviewPanel panelRef={panelRef} />
      <div data-dock-bar data-shell-part='dockbar' data-shell-frozen className='flex w-10 shrink-0 flex-col items-center gap-1 border-l border-line bg-side py-3'>
        {DOCK_TABS.map((item) => {
          const on = open && tab === item.key
          // 收起态点一下＝展开并切到这个页签；展开态点当前页签＝收起。
          // 这样右侧栏本身就是入口，标题栏不必再挂一个重复的开关。
          return (
            <Tip key={item.key} label={item.label} side='left'>
              <button
                type='button'
                aria-label={item.label}
                aria-pressed={on}
                onClick={() => (on ? togglePanel(false) : openDockTab(item.key))}
                className={cn(
                  'relative grid h-8 w-8 place-items-center rounded-lg transition-colors duration-[var(--motion-fast)]',
                  on ? 'bg-selected text-ink' : 'text-ink-3 hover:bg-hover hover:text-ink-2',
                )}
              >
                {item.icon}
                {/* 有任务在跑时给「任务」页签点一个小圆点，不用打开面板也知道有活干 */}
                {item.key === 'tasks' && runningTasks > 0 ? (
                  <span className='absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary' />
                ) : null}
              </button>
            </Tip>
          )
        })}
      </div>
    </div>
  )
}
