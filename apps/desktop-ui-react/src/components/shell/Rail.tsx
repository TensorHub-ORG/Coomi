import { Suspense, lazy, useEffect, useState } from 'react'
import {
  MessageSquare, Sparkles, Package, Settings, CircleHelp, Puzzle,
  FileText, Globe, Star, BookOpen, Activity, Image as ImageIcon, LayoutGrid,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { useUi, type ViewKey } from '../../stores/ui'
import { usePluginViews } from '../../stores/pluginViews'
import { useEngine } from '../../stores/engine'
// 插件主题 parts（v1.7）：侧栏 logo 圆角 / 导航图标颜色经它订阅。
import { useThemeParts } from '../plugins/PluginThemeEngine'
import { Tip } from '../ui/Overlay'
import logo from '../../assets/coomi-logo.png'

/* 帮助中心：和页面级 chunk 一样懒加载 —— 六篇正文加上一套 Markdown 渲染不该压进首屏主包，
   而它只有用户真的点了「帮助」之后才有用。 */
const HelpView = lazy(() => import('../../views/HelpView').then((m) => ({ default: m.HelpView })))
const PluginsView = lazy(() => import('../../views/PluginsView').then((m) => ({ default: m.PluginsView })))

const NAV: Array<{ key: ViewKey; label: string; icon: React.ReactNode }> = [
  { key: 'chat', label: '对话', icon: <MessageSquare size={18} /> },
  { key: 'skills', label: '技能中心', icon: <Sparkles size={18} /> },
  { key: 'artifacts', label: '产物中心', icon: <Package size={18} /> },
]

/* ── 插件页面（v2.1）──
   plugin.json 的 views 声明经壳写入 <home>/plugin-views.json，引擎经 /api/plugins/views 给前端。
   图标按名字映射到内置图标集（认不出的用默认方块）—— 插件不引入额外图标资源，
   也不用把 SVG 塞进清单里。 */
const VIEW_ICONS: Record<string, React.ReactNode> = {
  puzzle: <Puzzle size={18} />,
  file: <FileText size={18} />,
  text: <FileText size={18} />,
  globe: <Globe size={18} />,
  star: <Star size={18} />,
  book: <BookOpen size={18} />,
  activity: <Activity size={18} />,
  image: <ImageIcon size={18} />,
  grid: <LayoutGrid size={18} />,
}
function pluginIcon(name: string): React.ReactNode {
  return VIEW_ICONS[name.toLowerCase()] ?? <Puzzle size={18} />
}

/** 左侧图标导航栏（60px）：只做一级导航，不放任何跟具体页面内容有关的东西。
    原来这里还挂过一个「展开会话列表」图标（会话列表收起来时当召回入口），
    但收放属于对话页自己的事，入口已经跟着对话页工具栏走了，这里删掉，免得同一个开关两处都有。
    宽度由外层 Panel 固定成 60px，导航自己铺满。 */
export function Rail() {
  const view = useUi((s) => s.view)
  const setView = useUi((s) => s.setView)
  // v1.7：parts.rail —— logoRadius 给 logo 圆角；iconColor 经 CSS 变量 --rail-icon 下发图标颜色。
  const rail = useThemeParts()?.rail
  const iconColor = rail?.iconColor
  /** 导航图标按钮的底色 / 图标色：有 iconColor 时图标一律用 --rail-icon（选中态保留底色）。 */
  const navBtn = (on: boolean): string => cn(
    'relative grid h-9 w-9 place-items-center rounded-lg transition-colors duration-[var(--motion-fast)]',
    iconColor
      ? on ? 'bg-selected text-[var(--rail-icon)]' : 'text-[var(--rail-icon)] hover:bg-hover'
      : on ? 'bg-selected text-ink' : 'text-ink-3 hover:bg-hover hover:text-ink-2',
  )
  /* 帮助入口以前是 window.open('https://github.com/')——点了等于没点（那也不是本项目）。
     现在它打开下面的帮助中心：打开过一次之后就保持挂载，Radix 的退场动画要有那一帧才播得出来。 */
  const [helpOpen, setHelpOpen] = useState(false)
  const [helpReady, setHelpReady] = useState(false)
  useEffect(() => { if (helpOpen) setHelpReady(true) }, [helpOpen])
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [pluginsReady, setPluginsReady] = useState(false)
  useEffect(() => { if (pluginsOpen) setPluginsReady(true) }, [pluginsOpen])

  // 插件页面：引擎就绪后拉一次（老引擎没有这个接口时保持空表，侧边栏与以前一模一样）。
  const engineReady = useEngine((s) => s.ready)
  const pluginViews = usePluginViews((s) => s.views)
  const loadPluginViews = usePluginViews((s) => s.load)
  useEffect(() => { if (engineReady) void loadPluginViews() }, [engineReady, loadPluginViews])

  const item = (key: ViewKey, label: string, icon: React.ReactNode) => {
    const on = view === key
    return (
      <Tip key={key} label={label} side='right'>
        <button
          type='button'
          // data-nav-key：App 在指针按下时就按它预热目标页 chunk（见 App 的导航预取）
          data-nav-key={key}
          onClick={() => setView(key)}
          className={navBtn(on)}
          aria-label={label}
        >
          {on ? <span className='absolute -left-[11px] h-4 w-[2px] rounded-full bg-primary' /> : null}
          {icon}
        </button>
      </Tip>
    )
  }

  // data-shell-part：显式登记为「外壳部件」，CSS 据此给这一条 view-transition-name。
  // 原来靠 [data-app-shell] > nav 这种结构选择器找它，而 Rail 外面还套着面板组与 Panel
  // 两层 div，`>` 根本命中不了——于是它没拿到名字、被算进根快照，切页时跟着整张快照横移
  // （「最左侧栏跟着动」就是这么来的）。
  return (
    <nav
      data-shell-part='rail'
      className='flex h-full w-full flex-col items-center gap-1 border-r border-line bg-side py-3'
      style={iconColor ? ({ '--rail-icon': iconColor } as React.CSSProperties) : undefined}
    >
      {/* data-theme-mascot=logo：插件主题 mascot.logo 替换侧栏 logo 的挂点（引擎缓存原 src，卸载恢复）。
          v1.7：parts.rail.logoRadius 覆盖 logo 圆角（内联样式优先于内置 rounded-xl）。 */}
      <img
        data-theme-mascot='logo'
        src={logo}
        alt='Coomi'
        className='mb-2 h-9 w-9 rounded-xl object-contain'
        style={rail?.logoRadius != null
          ? { borderRadius: typeof rail.logoRadius === 'number' ? rail.logoRadius + 'px' : rail.logoRadius }
          : undefined}
      />
      {NAV.map((n) => item(n.key, n.label, n.icon))}
      {/* 插件注册的页面：分隔线只在真的有插件页时出现，平时一个像素都不多。 */}
      {pluginViews.length ? <div className='my-1 h-px w-6 shrink-0 bg-line-soft' /> : null}
      {pluginViews.map((v) => item(v.key, v.title, pluginIcon(v.icon)))}
      <div className='flex-1' />
      {item('settings', '设置', <Settings size={18} />)}
      <Tip label='插件' side='right'>
        <button
          type='button'
          data-plugins-entry
          aria-expanded={pluginsOpen}
          onClick={() => setPluginsOpen(true)}
          className={navBtn(pluginsOpen)}
          aria-label='插件'
        >
          <Puzzle size={18} />
        </button>
      </Tip>
      <Tip label='帮助' side='right'>
        <button
          type='button'
          data-help-entry
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen(true)}
          className={navBtn(helpOpen)}
          aria-label='帮助'
        >
          <CircleHelp size={18} />
        </button>
      </Tip>
      {/* 帮助中心 Portal 到 body，所以挂在这个 60px 宽的导航条里也不会被外层裁掉。 */}
      {helpReady ? (
        <Suspense fallback={null}>
          <HelpView open={helpOpen} onClose={() => setHelpOpen(false)} />
        </Suspense>
      ) : null}
      {pluginsReady ? (
        <Suspense fallback={null}>
          <PluginsView open={pluginsOpen} onClose={() => setPluginsOpen(false)} />
        </Suspense>
      ) : null}
    </nav>
  )
}
