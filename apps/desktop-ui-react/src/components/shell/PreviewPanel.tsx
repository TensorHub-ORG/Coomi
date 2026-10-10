/**
 * 右侧侧栏面板：页签内容（产物 / 文件 / 统计 / 上下文 / 任务）+ 就地预览。
 * - 宽度由外层 Panel（react-resizable-panels）控制：拖拽把手画在主列与侧栏之间，
 *   键盘（←/→）与双击复位也归面板库；这里只管内容
 * - 展开/收起由 RightDock 调面板的 resize 完成，面板宽度就是侧栏宽度，
 *   收起时整块只剩 40px 图标条，永远不会压在对话列上
 * - 预览复用原 PreviewPanel 的能力：图片直出、Markdown 渲染、其它文本等宽显示
 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, Copy, FolderOpen, MoveHorizontal, RefreshCw, Save, X } from 'lucide-react'
import type { RefObject } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { cn } from '../../lib/cn'
import { shortPath } from '../../lib/format'
import { useLibrary } from '../../stores/library'
import { useUi } from '../../stores/ui'
import { useCapabilities } from '../../stores/capabilities'
import { saveArtifactAs } from '../../lib/saveAs'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Controls'
import { Tip } from '../ui/Overlay'
import { Menu } from '../ui/Menu'
import { Markdown } from '../chat/Markdown'
import { filePreviewKind, isRichFileKind } from '../richtext/fileTypes'
import { fileRawUrl, useFilePeek, useFileStatStore } from '../richtext/fileStore'

/* ── 页签按需加载 ──
   五个页签各自成 chunk：只有真正打开过的页签才会下载与执行，
   首屏主包因此不含它们（打开侧栏那一刻才取，<Suspense> 兜住由空转有的那一帧）。 */
const DockArtifactsTab = lazy(() => import('./DockArtifactsTab').then((m) => ({ default: m.DockArtifactsTab })))
// 富内容预览也按需加载：里面挂着 sucrase / Mermaid / KaTeX 的入口，不开这个页签就一个字节都不下。
const DockRichPreviewTab = lazy(() => import('./DockRichPreviewTab').then((m) => ({ default: m.DockRichPreviewTab })))
const DockContextTab = lazy(() => import('./DockContextTab').then((m) => ({ default: m.DockContextTab })))
const DockFilesTab = lazy(() => import('./DockFilesTab').then((m) => ({ default: m.DockFilesTab })))
const DockTasksTab = lazy(() => import('./DockTasksTab').then((m) => ({ default: m.DockTasksTab })))
const DockUsageTab = lazy(() => import('./DockUsageTab').then((m) => ({ default: m.DockUsageTab })))
// 「富文件」预览（xlsx / pdf / zip / docx / html / 二进制）也按需加载：
// 分发器与它背后那几个重库（SheetJS / Mammoth / fflate）都不进主包，只有真预览过这一类文件才下载。
const FilePreview = lazy(() => import('../richtext/preview/FilePreview').then((m) => ({ default: m.FilePreview })))
import {
  copyPath,
  DOCK_BAR_W,
  DOCK_TABS,
  PANEL_DEFAULT_W,
  revealPath,
  useDockPreview,
  useDockTab,
  useDockWidth,
} from './dockShared'

export function PreviewPanel({ panelRef }: {
  /** 外层 dock 面板的句柄：宽度预设 / 复位都要命令面板改宽度（宽度不再由本组件持有）。 */
  panelRef?: RefObject<PanelImperativeHandle | null>
}) {
  const open = useUi((s) => s.panelOpen)
  const togglePanel = useUi((s) => s.togglePanel)
  const tab = useDockTab()
  // 宽度预设仍然写回 coomi.dock.w（和拖拽时落盘的是同一个键），再命令面板按它调宽。
  const { setWidth, max } = useDockWidth()
  const [refresh, setRefresh] = useState(0)

  const previewPath = useDockPreview((s) => s.path)
  const previewName = useDockPreview((s) => s.name)
  const previewText = useDockPreview((s) => s.text)
  const previewLoading = useDockPreview((s) => s.loading)
  const previewError = useDockPreview((s) => s.error)
  const closePreview = useDockPreview((s) => s.close)
  /// 「另存为」入口受能力开关控制（默认关，见 stores/capabilities）：开着的会话里，
  /// 预览头顶多一个保存按钮，点了弹系统对话框（壳的 save_file_as）。
  const allowSaveAs = useCapabilities((s) => s.caps.allowSaveAsRequest)

  // 产物中心（ArtifactsView）走的是 library store 的预览：那边 set 了预览就沿用，
  // 保证「在右侧预览」这个既有入口不被这次重构打断。
  const libPreview = useLibrary((s) => s.preview)
  const libName = useLibrary((s) => s.previewName)
  const clearLibPreview = useLibrary((s) => s.clearPreview)

  /// 路径芯片点开的文件（xlsx / pdf / zip / docx / html / 二进制）走的是另一条预览来源：
  /// dockShared 的 useDockPreview 只认文本与图片，这里用 richtext/fileStore 的 useFilePeek 接管。
  const peekPath = useFilePeek((s) => s.path)
  const peekName = useFilePeek((s) => s.name)
  const peekText = useFilePeek((s) => s.text)
  const peekLoading = useFilePeek((s) => s.loading)
  const peekError = useFilePeek((s) => s.error)
  const closePeek = useFilePeek((s) => s.close)

  // 换页签就退出预览：否则点了「统计」还停在刚才那个文件的预览上，像卡住了。
  useEffect(() => { closePreview() }, [tab, closePreview])
  // 文件预览只在「预览」页签里有意义：切走就关（芯片点开时它自己会先把页签切过来）。
  useEffect(() => {
    // 只在真有值时才写：否则每次挂载 / 换页签都会多推一次空状态，白白重渲染一轮。
    if (tab !== 'preview' && useFilePeek.getState().path) closePeek()
  }, [tab, closePeek])

  const meta = DOCK_TABS.find((item) => item.key === tab) ?? DOCK_TABS[0]
  const libMode = !previewPath && !peekPath && !!libName && tab === 'artifacts'
  const previewMode = Boolean(previewPath) || Boolean(peekPath) || libMode
  // 预览的「当前路径」有两个来源：产物 / 文件页签的 useDockPreview，和芯片点开的 useFilePeek。
  const shownPath = previewPath || peekPath
  const shownName = previewPath ? previewName : (peekPath ? peekName : libName)
  const shownText = previewPath ? previewText : (peekPath ? peekText : libPreview)
  const shownLoading = previewPath ? previewLoading : (peekPath ? peekLoading : false)
  const shownError = previewPath ? previewError : (peekPath ? peekError : '')

  const bump = (): void => {
    setRefresh((v) => v + 1)
    // 「重新读取」要连文件状态缓存一起作废，否则芯片上的「不存在」会赖着不走。
    if (shownPath) useFileStatStore.getState().refresh(shownPath)
    // 芯片点开的那一份正文由 useFilePeek 自己取，这里也要让它重取（富文件靠 key 重建预览器）。
    if (!previewPath && peekPath) useFilePeek.getState().reload()
  }
  const back = (): void => {
    closePreview()
    closePeek()
    if (libMode) clearLibPreview()
  }
  /// 宽度预设：先落盘（沿用 coomi.dock.w），再让面板按「图标条 + 预览宽」调到那个尺寸。
  const pickWidth = (previewWidth: number): void => {
    setWidth(previewWidth)
    panelRef?.current?.resize(DOCK_BAR_W + previewWidth)
  }

  return (
    <aside
      data-dock-panel
      data-shell-part='dockpane'
      data-shell-frozen
      className={cn('relative h-full w-full min-w-0 overflow-hidden bg-side')}
    >
      {open ? (
        <div className='flex h-full w-full animate-enter flex-col'>
          <header className='flex h-11 shrink-0 items-center gap-1 border-b border-line px-2.5'>
            {previewMode ? (
              <Tip label='返回列表'>
                <Button variant='ghost' size='icon-sm' className='h-7 w-7' onClick={back}><ArrowLeft size={14} /></Button>
              </Tip>
            ) : (
              <span className='grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted text-ink-3'>{meta.icon}</span>
            )}
            <div className='min-w-0 flex-1'>
              <p className='truncate text-12 font-medium text-ink' title={previewMode ? shownPath || shownName || '预览' : meta.label}>
                {previewMode ? (shownName || '预览') : meta.label}
              </p>
              <p className='truncate text-11 text-ink-4' title={previewMode ? shownPath : meta.desc}>
                {previewMode ? (shownPath ? shortPath(shownPath, 40) : '来自产物中心的预览') : meta.desc}
              </p>
            </div>
            {previewMode ? (
              <>
                <Tip label='复制路径'>
                  <Button variant='ghost' size='icon-sm' className='h-7 w-7' disabled={!shownPath} onClick={() => void copyPath(shownPath)}>
                    <Copy size={13} />
                  </Button>
                </Tip>
                <Tip label='在文件夹中打开'>
                  <Button variant='ghost' size='icon-sm' className='h-7 w-7' disabled={!shownPath} onClick={() => void revealPath(shownPath)}>
                    <FolderOpen size={13} />
                  </Button>
                </Tip>
                {/* 「另存为」属于打扰型能力（会弹系统对话框），默认关：开关在设置的能力清单里。
                    壳没接上 save_file_as 时由 lib/saveAs 给一句可读的降级提示，这里不做第二套判断。 */}
                {allowSaveAs ? (
                  <Tip label='另存为…'>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      className='h-7 w-7'
                      disabled={!shownPath}
                      onClick={() => void saveArtifactAs({ path: shownPath, name: shownName })}
                    >
                      <Save size={13} />
                    </Button>
                  </Tip>
                ) : null}
                <Tip label='重新读取'>
                  <Button variant='ghost' size='icon-sm' className='h-7 w-7' onClick={bump}><RefreshCw size={13} /></Button>
                </Tip>
              </>
            ) : (
              <Tip label='刷新'>
                <Button variant='ghost' size='icon-sm' className='h-7 w-7' onClick={bump}><RefreshCw size={13} /></Button>
              </Tip>
            )}
            <Tip label='宽度预设'>
              <Menu
                align='end'
                trigger={<Button variant='ghost' size='icon-sm' className='h-7 w-7' title='宽度预设'><MoveHorizontal size={13} /></Button>}
                items={[
                  { label: '窄 · 280', onSelect: () => pickWidth(280) },
                  { label: '中 · 340', onSelect: () => pickWidth(340) },
                  { label: '宽 · 460', onSelect: () => pickWidth(460) },
                  { label: '与会话等宽', onSelect: () => pickWidth(max) },
                  { divider: true },
                  { label: '复位 · ' + PANEL_DEFAULT_W, onSelect: () => pickWidth(PANEL_DEFAULT_W) },
                ]}
              />
            </Tip>
            <Button variant='ghost' size='icon-sm' className='h-7 w-7' title='收起' onClick={() => togglePanel(false)}>
              <X size={14} />
            </Button>
          </header>

          <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
            {previewMode ? (
              <PreviewBody
                name={shownName}
                path={shownPath}
                text={shownText}
                loading={shownLoading}
                error={shownError}
                refresh={refresh}
              />
            ) : (
              <Suspense fallback={<div className='flex items-center gap-2 px-3 py-4 text-12 text-ink-3'><Spinner /> 加载中…</div>}>
                {tab === 'artifacts' ? (
                  <DockArtifactsTab refresh={refresh} onRefresh={bump} />
                ) : tab === 'preview' ? (
                  <DockRichPreviewTab refresh={refresh} onRefresh={bump} />
                ) : tab === 'files' ? (
                  <DockFilesTab refresh={refresh} onRefresh={bump} />
                ) : tab === 'stats' ? (
                  <DockUsageTab refresh={refresh} onRefresh={bump} />
                ) : tab === 'context' ? (
                  <DockContextTab refresh={refresh} onRefresh={bump} />
                ) : (
                  <DockTasksTab refresh={refresh} onRefresh={bump} />
                )}
              </Suspense>
            )}
          </div>
        </div>
      ) : null}
    </aside>
  )
}

/** 预览正文：富文件（xlsx / pdf / zip / docx / html / 其它二进制）走懒加载的 FilePreview，
 *  图片直接渲染，Markdown 走渲染器，其余文本等宽显示。 */
function PreviewBody({ name, path, text, loading, error, refresh }: {
  name: string
  path: string
  text: string
  loading: boolean
  error: string
  refresh: number
}) {
  const kind = filePreviewKind(path || name)
  // 富文件有自己的只读预览器。这一段必须排在 loading / error 之前：
  // dockShared 的 useDockPreview 只认文本与图片，它对 xlsx 一类留下的「这类文件不做内联预览」
  // 在这里并不成立（文件页签点开 xlsx 走的也是这条分支）。
  if (path && isRichFileKind(kind)) {
    return (
      <div key={refresh} data-dock-tab='preview' className='flex min-h-0 flex-1 flex-col overflow-hidden'>
        <Suspense fallback={<div className='flex items-center gap-2 px-3 py-4 text-12 text-ink-3'><Spinner /> 加载预览器…</div>}>
          <FilePreview path={path} name={name} />
        </Suspense>
      </div>
    )
  }
  return (
    <div key={refresh} data-dock-tab='preview' className='min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2.5'>
      {loading ? (
        <div className='flex items-center gap-2 text-12 text-ink-3'><Spinner /> 读取中…</div>
      ) : error ? (
        <div className='min-w-0 rounded-md border border-warn/40 bg-warn-soft px-2.5 py-2 text-12 text-warn'>
          {/* 错误文案里常带完整路径：flex 行里必须把文本包进 min-w-0 + break-all，否则整行被撑破 */}
          <p className='flex items-start gap-1.5'>
            <AlertTriangle size={13} className='mt-[2px] shrink-0' />
            <span className='min-w-0 break-all'>{error}</span>
          </p>
          {path ? (
            <button type='button' className='mt-1.5 text-11 underline underline-offset-2' onClick={() => void revealPath(path)}>
              在文件夹中打开
            </button>
          ) : null}
        </div>
      ) : kind === 'image' && path ? (
        /* 图片走带令牌的 raw URL：iframe / <img> 发不了 Authorization 头，只能把令牌带在查询串上。 */
        <img alt={name} className='max-w-full rounded-md border border-line elev-1' src={fileRawUrl(path)} />
      ) : kind === 'markdown' ? (
        <div className='md-body min-w-0 selectable text-12'><Markdown text={text} /></div>
      ) : (
        /* break-all 而不是 break-words：日志 / base64 / 无空格长串在 break-words 下不换行，会撑出横向滚动 */
        <pre className='min-w-0 selectable whitespace-pre-wrap break-all font-mono text-11 leading-[1.65] text-ink-2'>{text}</pre>
      )}
    </div>
  )
}
