/**
 * 对话里的代码块：识别 + 动作条 + 就地预览。
 *
 * 六条产品规则：
 *   1) 只要识别出富类型（HTML/SVG/JS/TSX/Mermaid/JSON/CSV/Diff/公式），动作条就多出「预览」开关；
 *      识别不出的保持原样，只是一个普通代码块（不高亮任何多余入口）。
 *   2) **围栏没闭合就不高亮**：代码还在长的时候用等宽纯文本渲染（浅色底），闭合后一次性高亮并就地替换。
 *   3) 高亮结果按「语言 + 内容哈希」进 LRU（容量 50）：重复内容不重复高亮，重挂载 / 折叠展开都能直接命中；
 *      被判定为「不值得高亮」（超长 / 超预算）的结论也一起进缓存，重挂载不会再白等一次预算。
 *   4) 超过 800 行的块默认折叠尾部（只显示前 200 行 + 「展开全部」），未展开时既不渲染高亮也不渲染长文本节点。
 *   5) **高亮绝不在渲染里做**：先卡长度 / 行数上限，再排到空闲期（requestIdleCallback，无则 setTimeout(0)）执行，
 *      执行时用 200ms 预算计时，超预算就整体丢弃、退回纯文本并挂一条说明。effect 清理函数会取消未执行的调度，
 *      所以快速滚动 / 流式追加不会攒下一堆待跑的重活。
 *   6) **安全模式整体跳过预览**（见 richtext/safeMode.ts）：动作条只留源码相关入口。
 *
 * 识别结果（detectRichBlock）仍然在渲染期算：它已经是纯线性扫描 + 10 万字符硬闸（见 detect.ts），
 * 单次成本与文本长度线性相关且有上界，不会成为卡顿来源。
 *
 * 每一个动作都是本地的：复制 / 下载 / 新窗口 / 存为产物（写会话工作区，走 /api/fs/write）。
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, Code2, Copy, Download, ExternalLink, Eye, PackagePlus, Pin, ShieldCheck, WrapText } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../lib/cn'
import { Button } from '../ui/Button'
import { Tip } from '../ui/Overlay'
import { Segmented } from '../ui/Controls'
import { loadHighlighter } from './highlight'
import { getHighlight, highlightKey, putHighlight } from './lru'
import { KIND_LABEL, detectRichBlock } from './detect'
import { OVERSIZED_NOTE, RICH_BUDGET_MS, highlightAllowed, runWithBudget, scheduleIdle } from './limits'
import { makeBlock, registerRichBlock, useRichStore } from './store'
import { copyText, downloadBlock, openBlockInNewWindow, saveBlockAsArtifact } from './actions'
import { RichPreview } from './RichPreview'
import { useRichSafeMode } from './preview/common'
import { openDockTab } from '../shell/dockShared'

/** 超过这么多行就默认折叠尾部。 */
export const LONG_BLOCK_LINES = 800
/** 折叠时显示前多少行。 */
export const COLLAPSED_PREVIEW_LINES = 200

/** 行数：折叠判断与行号列都用它。 */
function countLines(code: string): number {
  if (!code) return 0
  let lines = 1
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lines++
  return lines
}

/** 取前 n 行的文本（n 行以内原样返回，避免无谓的拼接）。 */
function firstLines(code: string, n: number): string {
  let index = -1
  for (let seen = 0; seen < n; seen++) {
    index = code.indexOf('\n', index + 1)
    if (index === -1) return code
  }
  return code.slice(0, index)
}

export function CodeBlock({ code, lang, streaming, live, origin }: {
  code: string
  lang: string
  /** 所在消息是否仍在流式输出：true 时只给代码视图。 */
  streaming?: boolean
  /** 这一块的围栏还没闭合（还在长）：只出纯等宽文本，不做高亮、不进预览。 */
  live?: boolean
  /** 来源说明（登记到右侧预览页签时展示）。 */
  origin?: string
}) {
  const [html, setHtml] = useState('')
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [mode, setMode] = useState<'code' | 'preview'>('code')
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)
  /** 高亮被降级的原因（空串表示没降级）：超长 / 超预算 / 高亮器不可用。 */
  const [highlightNote, setHighlightNote] = useState('')
  const safeMode = useRichSafeMode()
  const lineCount = useMemo(() => countLines(code), [code])

  // 超过 800 行的块默认折叠；内容变了就重新折叠回默认状态。
  useEffect(() => { setExpanded(false) }, [code])

  const collapsed = !expanded && lineCount > LONG_BLOCK_LINES
  const shown = collapsed ? firstLines(code, COLLAPSED_PREVIEW_LINES) : code

  const detection = useMemo(() => detectRichBlock(code, lang), [code, lang])
  const block = useMemo(
    () => makeBlock(detection.kind, detection.lang, code, origin ?? '对话里的代码块'),
    [detection.kind, detection.lang, code, origin],
  )
  // 流式没结束就不允许预览：这是「只在代码块流式结束后允许预览」的唯一判定点。
  const settled = !streaming
  // 安全模式 / 超长识别闸都会让预览整体不可用（动作条上会各自说明原因）。
  const canPreview = detection.previewable && settled && !collapsed && !safeMode

  // 围栏闭合才高亮：还在长的块（未闭合围栏）一律纯文本，等闭合后再一次性补上高亮。
  // 判定只看 live（由 Markdown.tsx 按围栏是否闭合算好传进来）——**渲染期不再调用 settleOnce**：
  // 那个函数比的是「语言 + 整块代码」拼出来的长串，会把渲染期重新拖回 O(长度) 的共享状态操作。
  const highlightable = !live && !detection.oversized
  const showHighlight = highlightable && !collapsed

  useEffect(() => {
    if (streaming) setMode('code')
  }, [streaming])

  // 登记到右侧「预览」页签：只登记完整的富块，流式中的半截内容不进页签。
  useEffect(() => {
    if (!settled || !detection.previewable) return
    registerRichBlock(block)
  }, [settled, detection.previewable, block])

  /* 高亮：先卡长度 / 行数上限，再排到空闲期跑并计时。
     为什么不能直接在这里调 shiki：codeToHtml 是同步重活，几十毫秒起步，跑在 effect 里同样挡住出帧；
     排到 idle 之后，滚动 / 流式追加时的 effect 清理会把还没跑的调度取消掉。 */
  useEffect(() => {
    if (!showHighlight) {
      // 折叠 / 未闭合时不留着旧高亮，省得展开时先闪一下旧内容。
      setHtml('')
      setHighlightNote('')
      return
    }
    // 长度 / 行数上限：超长的块连试都不试，直接纯文本 —— 这是防高亮卡死的第一道闸。
    if (!highlightAllowed(code, lineCount)) {
      setHtml('')
      setHighlightNote('代码过长（' + lineCount + ' 行 / ' + Math.round(code.length / 1000) + ' 千字符）：已跳过语法高亮，按纯文本显示')
      return
    }
    const key = highlightKey(lang, code)
    const hit = getHighlight(key)
    if (hit) {
      // 降级结论也走缓存：重挂载 / 滚动回来时不会再白等一次预算。
      setHtml(hit.html)
      setHighlightNote(hit.note ?? '')
      return
    }
    let alive = true
    const cancel = scheduleIdle(() => {
      void loadHighlighter()
        .then((hl) => {
          if (!alive) return
          const wanted = lang && hl.getLoadedLanguages().includes(lang) ? lang : 'text'
          const outcome = runWithBudget(() => hl.codeToHtml(code, {
            lang: wanted,
            themes: { light: 'github-light', dark: 'github-dark' },
            defaultColor: false,
          }), RICH_BUDGET_MS)
          if (!alive) return
          if (!outcome.ok) {
            // 超预算：产物一律丢弃，退回纯文本（并把结论缓存下来）。
            const note = '语法高亮超过 ' + RICH_BUDGET_MS + 'ms 预算（实测 ' + Math.round(outcome.ms) + 'ms）：已降级为纯文本'
            putHighlight(key, { html: '', lines: lineCount, note })
            setHtml('')
            setHighlightNote(note)
            return
          }
          putHighlight(key, { html: outcome.value, lines: lineCount })
          setHtml(outcome.value)
          setHighlightNote('')
        })
        .catch(() => { /* 高亮失败就退回纯文本 */ if (alive) setHighlightNote('语法高亮不可用：已按纯文本显示') })
    })
    return () => { alive = false; cancel() }
  }, [code, lang, showHighlight, lineCount])

  const copy = async (): Promise<void> => {
    const ok = await copyText(code)
    if (!ok) { toast.error('复制失败，请手动选择复制'); return }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const path = await saveBlockAsArtifact(block)
      toast.success('已存为产物：' + path)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const openWindow = async (): Promise<void> => {
    const result = await openBlockInNewWindow(block)
    if (result === 'system') toast.success('已交给系统默认程序打开')
    if (result === 'failed') toast.message('当前环境不能开新窗口，已下载成文件（可用产物页签继续处理）')
  }

  const pin = (): void => {
    useRichStore.getState().pin(block)
    openDockTab('preview')
    toast.success('已固定到右侧「预览」页签')
  }

  const shownLines = collapsed ? Math.min(COLLAPSED_PREVIEW_LINES, lineCount) : lineCount
  // 轻量标记：识别被长度闸跳过、或高亮被降级时，都在代码下面给一句话，不让界面「静悄悄变样」。
  const note = detection.oversized ? OVERSIZED_NOTE : highlightNote

  return (
    // 代码块允许比正文列更宽（--content-wide-w）：长行不必在窄列里折成麻花
    <div className='group/code my-3 w-full max-w-[var(--content-wide-w)] overflow-hidden rounded-lg border border-line bg-code'>
      <div className='flex min-h-8 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1'>
        <span className='text-11 text-ink-3'>{lang || 'text'}</span>
        {detection.previewable ? (
          <Tip label={detection.reason}>
            <span className='rounded border border-line-strong bg-muted px-1.5 py-[1px] text-11 text-ink-2'>{KIND_LABEL[detection.kind]}</span>
          </Tip>
        ) : null}
        <span className='text-11 text-ink-4'>{collapsed ? shownLines + ' / ' + lineCount + ' 行' : lineCount + ' 行'}</span>
        <div className='flex-1' />

        {detection.previewable ? (
          safeMode ? (
            <Tip label='安全模式已开启：iframe 沙箱 / Mermaid / KaTeX 等富预览整体跳过，只保留源码与动作条'>
              <span className='flex items-center gap-1 rounded-md border border-line-strong bg-control-2 px-2 py-1 text-11 text-ink-4'>
                <ShieldCheck size={11} />安全模式：已跳过预览
              </span>
            </Tip>
          ) : canPreview ? (
            <Segmented
              value={mode}
              onChange={setMode}
              ariaLabel='代码块视图'
              options={[
                { value: 'preview', label: <span className='flex items-center gap-1'><Eye size={11} />预览</span> },
                { value: 'code', label: <span className='flex items-center gap-1'><Code2 size={11} />代码</span> },
              ]}
            />
          ) : (
            <Tip label={collapsed ? '代码块过大已折叠：展开后才能预览' : '流式生成中：代码块结束后才能预览'}>
              <span className='flex items-center gap-1 rounded-md border border-line-strong bg-control-2 px-2 py-1 text-11 text-ink-4'>
                <Eye size={11} />{collapsed ? '已折叠，暂不可预览' : '流式生成中，暂不可预览'}
              </span>
            </Tip>
          )
        ) : null}

        <Tip label={copied ? '已复制' : '复制'}>
          <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => void copy()}>
            {copied ? <Check size={12} className='animate-check-in text-ok' /> : <Copy size={12} />}
          </Button>
        </Tip>
        <Tip label={wrap ? '关闭自动换行' : '自动换行'}>
          <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => setWrap((v) => !v)}>
            <WrapText size={12} className={cn('transition-colors duration-[var(--motion-fast)] ease-[var(--ease-enter)]', wrap && 'text-primary')} />
          </Button>
        </Tip>
        <Tip label='下载为文件'>
          <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => downloadBlock(block)}><Download size={12} /></Button>
        </Tip>
        <Tip label='在新窗口打开（独立文档）'>
          <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => void openWindow()}><ExternalLink size={12} /></Button>
        </Tip>
        {detection.previewable ? (
          <Tip label={safeMode ? '安全模式下不能固定富预览' : '固定到右侧「预览」页签'}>
            <Button variant='ghost' size='icon-sm' className='h-6 w-6' disabled={safeMode} onClick={pin}><Pin size={12} /></Button>
          </Tip>
        ) : null}
        <Tip label='存为产物（写入会话工作区）'>
          <Button variant='ghost' size='icon-sm' className='h-6 w-6' loading={saving} onClick={() => void save()}><PackagePlus size={12} /></Button>
        </Tip>
      </div>

      {mode === 'preview' && canPreview && !streaming ? (
        <div className='min-w-0 bg-surface'>
          {/* 富预览只渲染可见项：RichPreview 内部用 IntersectionObserver 守着，滑出视口即卸载 */}
          <RichPreview block={block} />
        </div>
      ) : html ? (
        <div className='flex'>
          <pre className='select-none border-r border-line px-2 py-2 text-right font-mono text-11 leading-[1.6] text-ink-4'>
            {Array.from({ length: shownLines }, (_, i) => i + 1).join('\n')}
          </pre>
          <div
            className={cn('shiki-host min-w-0 flex-1 px-3 py-2 text-12', wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto')}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      ) : (
        // 未闭合（流式中）/ 已折叠 / 高亮被降级：纯等宽文本，给一层浅色底说明「这块没高亮」。
        <pre className={cn(
          'px-3 py-2 font-mono text-12 leading-[1.65] text-code-fg',
          wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto',
          !showHighlight && 'bg-control-2/40',
        )}>{shown}</pre>
      )}

      {note && !(mode === 'preview' && canPreview) ? (
        <div className='border-t border-line px-2 py-1 text-11 text-ink-4'>{note}</div>
      ) : null}

      {collapsed ? (
        <button
          type='button'
          onClick={() => setExpanded(true)}
          className='flex w-full items-center justify-center gap-1 border-t border-line px-3 py-1.5 text-11 text-ink-3 transition-colors duration-[var(--motion-fast)] hover:bg-control-2 hover:text-ink'
        >
          代码块共 {lineCount} 行，已折叠尾部（仅显示前 {shownLines} 行）· 展开全部
        </button>
      ) : lineCount > LONG_BLOCK_LINES ? (
        <button
          type='button'
          onClick={() => setExpanded(false)}
          className='flex w-full items-center justify-center gap-1 border-t border-line px-3 py-1.5 text-11 text-ink-3 transition-colors duration-[var(--motion-fast)] hover:bg-control-2 hover:text-ink'
        >
          已展开全部 {lineCount} 行 · 收起
        </button>
      ) : null}
    </div>
  )
}
