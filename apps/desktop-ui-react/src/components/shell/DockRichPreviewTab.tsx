/**
 * 右侧栏「预览」页签：跟随对话里最新的富内容块，也可以固定在某一块上。
 *
 * 与其它页签的差别：它不读引擎接口，数据来自 richtext/store ——
 * 对话里的代码块把自己登记进那个 store，这里只负责展示与操作。
 * 与「产物」页签的打通：这里「存为产物」写的就是会话工作区（/api/fs/write），
 * 成功后会 bump 产物页签的刷新计数，切过去就能看到刚存下的文件。
 *
 * 卸载语义：页签切走 / 侧栏收起时本组件整块被卸载，里面的 iframe 与图表随之销毁，
 * 不会有隐藏的预览在后台继续跑。
 */
import { useCallback, useState } from 'react'
import { Copy, Download, ExternalLink, PackagePlus, Pin, PinOff, RefreshCw, Save } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../lib/cn'
import { saveArtifactAs } from '../../lib/saveAs'
import { useCapabilities } from '../../stores/capabilities'
import { Button } from '../ui/Button'
import { Tip } from '../ui/Overlay'
import { StateBlock } from './dockShared'
import { DockSection } from './dockMetrics'
import { KIND_LABEL, copyText, downloadBlock, openBlockInNewWindow, saveBlockAsArtifact } from '../richtext'
import { blockFileName } from '../richtext/actions'
import type { RichBlock } from '../richtext'
import { RichPreview } from '../richtext/RichPreview'
import { useRichStore } from '../richtext/store'

const SUPPORTED = 'HTML / CSS / SVG / JavaScript / React(TSX) / Mermaid / JSON / CSV / Diff / KaTeX 公式'

export function DockRichPreviewTab({ refresh, onRefresh }: { refresh: number; onRefresh: () => void }) {
  const latest = useRichStore((s) => s.latest)
  const pinned = useRichStore((s) => s.pinned)
  const pin = useRichStore((s) => s.pin)
  // 「另存为」属于打扰型能力（会弹系统保存对话框），默认关：开关在设置的能力清单里。
  const allowSaveAs = useCapabilities((s) => s.caps.allowSaveAsRequest)
  const [saving, setSaving] = useState(false)
  const [savingAs, setSavingAs] = useState(false)

  const block: RichBlock | null = pinned ?? latest
  const isPinned = !!block && pinned?.id === block.id

  const save = useCallback(async (target: RichBlock): Promise<void> => {
    setSaving(true)
    try {
      const path = await saveBlockAsArtifact(target)
      toast.success('已存为产物：' + path)
      onRefresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [onRefresh])

  /// 另存为：富块本身还不是磁盘上的文件，所以先写进会话工作区拿到真实路径，
  /// 再交给壳的原生保存对话框（save_file_as）；取消 / 失败 / 壳未就绪都由 lib/saveAs 翻成人话。
  const saveAs = useCallback(async (target: RichBlock): Promise<void> => {
    setSavingAs(true)
    try {
      const path = await saveBlockAsArtifact(target)
      onRefresh()
      await saveArtifactAs({ path, name: blockFileName(target) })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingAs(false)
    }
  }, [onRefresh])

  const openWindow = async (target: RichBlock): Promise<void> => {
    const result = await openBlockInNewWindow(target)
    if (result === 'system') toast.success('已交给系统默认程序打开')
    if (result === 'failed') toast.message('当前环境不能开新窗口，已下载成文件')
  }

  return (
    <div data-dock-tab='preview' className='flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overflow-x-hidden p-2.5'>
      <DockSection
        title='富内容预览'
        hint={isPinned ? '已固定在会话里的某一块（取消固定后重新跟随最新块）' : '自动跟随会话里最新的富内容块'}
        actions={(
          <>
            {isPinned ? (
              <Tip label='取消固定，改为跟随最新块'>
                <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => pin(null)}><PinOff size={12} /></Button>
              </Tip>
            ) : null}
            <Tip label='刷新'>
              <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={onRefresh}><RefreshCw size={12} /></Button>
            </Tip>
          </>
        )}
      >
        <StateBlock
          empty={!block}
          emptyTitle='还没有可预览的富内容'
          emptyDesc={'会话里出现 ' + SUPPORTED + ' 的代码块后，这里会跟随最新的一块；流式生成中的块不会进来。'}
        >
          {block ? (
            <div className='min-w-0'>
              <div className='mb-2 flex min-w-0 flex-wrap items-center gap-1.5'>
                <span className='rounded border border-line-strong bg-muted px-1.5 py-[1px] text-11 text-ink-2'>{KIND_LABEL[block.kind]}</span>
                <span className='min-w-0 flex-1 truncate text-11 text-ink-4' title={block.lang}>{block.lang || '无标签'} · {block.code.split('\n').length} 行</span>
                <Tip label={isPinned ? '已在右侧固定' : '固定到本页签（不再跟随最新块）'}>
                  <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => pin(isPinned ? null : block)}>
                    <Pin size={12} className={cn(isPinned && 'text-primary')} />
                  </Button>
                </Tip>
                <Tip label='复制代码'>
                  <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => void copyText(block.code).then((ok) => (ok ? toast.success('已复制') : toast.error('复制失败')))}>
                    <Copy size={12} />
                  </Button>
                </Tip>
                <Tip label='下载为文件'>
                  <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => downloadBlock(block)}><Download size={12} /></Button>
                </Tip>
                <Tip label='在新窗口打开'>
                  <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => void openWindow(block)}><ExternalLink size={12} /></Button>
                </Tip>
                <Button
                  variant='secondary'
                  size='sm'
                  className='h-6 text-11'
                  loading={saving}
                  onClick={() => void save(block)}
                >
                  <PackagePlus size={11} />存为产物
                </Button>
                {allowSaveAs ? (
                  <Tip label='另存为…（先落进会话工作区，再弹系统保存弹窗）'>
                    <Button
                      variant='secondary'
                      size='sm'
                      className='h-6 text-11'
                      loading={savingAs}
                      onClick={() => void saveAs(block)}
                    >
                      <Save size={11} />另存为
                    </Button>
                  </Tip>
                ) : null}
              </div>
              <div className='min-w-0 overflow-hidden rounded-md border border-line'>
                {/* key 里带上 refresh：手动刷新时重建预览（重新跑一遍代码 / 重新编译）。 */}
                <RichPreview key={block.id + ':' + refresh} block={block} />
              </div>
            </div>
          ) : null}
        </StateBlock>
      </DockSection>

      <DockSection title='支持的富内容'>
        <p className='text-11 leading-[1.6] text-ink-4'>
          {SUPPORTED}。识别不出来的代码块保持普通样式。
          <br />
          安全边界：HTML / JS / React 跑在 sandbox=&quot;allow-scripts&quot; 的 iframe 里（不给 allow-same-origin、
          禁联网、禁顶层跳转），5 秒无响应可直接强制关闭；SVG / Mermaid 输出先清理 script 与 on* 事件再内联。
        </p>
      </DockSection>
    </div>
  )
}
