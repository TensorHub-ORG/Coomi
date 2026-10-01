import { useEffect } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import * as RadixTabs from '@radix-ui/react-tabs'
import { Puzzle } from 'lucide-react'
import { cn } from '../lib/cn'
import { PluginManager } from '../components/plugins/PluginManager'
import { PluginMarket } from '../components/plugins/PluginMarket'
import { usePluginStore } from '../components/plugins/pluginStore'
import { withDisplayName } from '../lib/stormProbe'

/* 插件中心：由左侧导航栏（Rail）打开的全屏浮层（Portal 到 body，避开 60px 导航条的裁剪）。
   打开时刷一次列表（启动时根部已刷过，这里补安装/卸载后的最新状态）；
   两个页签：已安装（PluginManager）/ 市场（PluginMarket，plugin_market_list / plugin_install_from_url）。
   壳命令缺失（浏览器直跑 / 旧壳）时由各组件 / store 内部友好降级。 */

/** 页签的观感：选中项带一条主题色底线；未选中 hover 出浅色。 */
const tabCls =
  'h-8 rounded-t-md px-3 text-12 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] ' +
  'text-ink-3 hover:text-ink data-[state=active]:font-medium data-[state=active]:text-ink ' +
  'data-[state=active]:border-b-2 data-[state=active]:border-primary'

export function PluginsView({ open, onClose }: { open: boolean; onClose: () => void }) {
  const refresh = usePluginStore((s) => s.refresh)

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className='dialog-scrim fixed inset-0 z-40 bg-black/35' />
        <RadixDialog.Content
          data-plugins-center
          style={{ width: 'min(980px, calc(100vw - 40px))', height: 'min(80vh, 780px)' }}
          className={cn(
            'dialog-surface fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
            'rounded-lg border border-line bg-overlay shadow-elev-4',
          )}
        >
          <div className='flex min-w-0 items-center gap-3 border-b border-line-soft px-5 py-3'>
            <Puzzle size={16} className='shrink-0 text-primary' />
            <div className='min-w-0 flex-1'>
              <RadixDialog.Title className='text-15 font-semibold text-ink'>插件</RadixDialog.Title>
              <RadixDialog.Description className='mt-0.5 text-11 text-ink-3'>
                已安装：启停、卸载、设为当前主题；市场：从仓库 URL 拉清单并按 zipUrl 安装
              </RadixDialog.Description>
            </div>
          </div>
          <RadixTabs.Root defaultValue='installed' className='flex min-h-0 flex-1 flex-col'>
            <RadixTabs.List className='flex shrink-0 items-center gap-1 border-b border-line-soft px-5 pt-2'>
              <RadixTabs.Trigger value='installed' className={tabCls}>已安装</RadixTabs.Trigger>
              <RadixTabs.Trigger value='market' className={tabCls}>市场</RadixTabs.Trigger>
            </RadixTabs.List>
            <RadixTabs.Content value='installed' className='min-h-0 flex-1 overflow-y-auto overscroll-contain p-5'>
              <PluginManager />
            </RadixTabs.Content>
            <RadixTabs.Content value='market' className='min-h-0 flex-1 overflow-y-auto overscroll-contain p-5'>
              <PluginMarket />
            </RadixTabs.Content>
          </RadixTabs.Root>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
withDisplayName(PluginsView, 'PluginsView')
