/**
 * Mermaid 预览：懒加载 mermaid 本体（压缩后 ~3MB，不进主包），渲染成内联 SVG。
 *
 * 安全：mermaid.initialize 用 securityLevel:'strict'（标签里的 HTML 会被转义、点击回调被禁用），
 * 渲染结果再过一遍 sanitizeSvg 才敢 innerHTML —— 双重保险，因为图的内容来自模型。
 * **这一套安全策略在任何模式下都不变**（安全模式只是整体不渲染预览，不是放宽策略）。
 * 失败（语法错误 / 渲染异常）一律降级成「无法预览，可复制代码」。
 *
 * 卡死防线：
 *   - 源码超过 MERMAID_MAX_CHARS 直接不进渲染器，按源码显示；
 *   - parse + render 全程计时，超过 200ms 预算就丢弃结果、降级为源码视图（用户可点「仍要显示」强行渲染）；
 *   - 组件被卸载（不可见 / 切回代码视图）时 alive 置 false，晚到的渲染结果直接丢弃，
 *     不会往一棵已经不存在的树里塞 SVG。
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '../../ui/Button'
import { PreviewLoading, useLazyModule, useThemeKey } from './common'
import { sanitizeSvg } from './SvgPreview'
import { MERMAID_MAX_CHARS, RICH_BUDGET_MS, nowMs } from '../limits'
import { copyText } from '../actions'
import type { RichBlock } from '../store'

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, code: string) => Promise<{ svg: string }>
  parse: (code: string, opts?: Record<string, unknown>) => Promise<unknown>
}

let instance: MermaidApi | null = null
let configured: string | null = null

async function loadMermaid(theme: 'light' | 'dark'): Promise<MermaidApi> {
  if (!instance) {
    const mod = await import('mermaid')
    instance = (mod.default ?? mod) as unknown as MermaidApi
  }
  const wanted = theme
  if (configured !== theme) {
    instance.initialize({
      startOnLoad: false,
      // strict：标签里的 HTML 被转义、click 回调禁用，模型给的图不能往页面里塞东西。
      securityLevel: 'strict',
      theme: wanted === 'dark' ? 'dark' : 'default',
      fontFamily: 'inherit',
      flowchart: { htmlLabels: false },
      themeVariables: wanted === 'dark' ? { background: 'transparent' } : undefined,
    })
    configured = theme
  }
  return instance
}

export function MermaidPreview({ block }: { block: RichBlock }) {
  const theme = useThemeKey()
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [degraded, setDegraded] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [forced, setForced] = useState(false)
  const { value: api, error: loadError } = useLazyModule(() => loadMermaid(theme), theme)
  const tooLong = block.code.length > MERMAID_MAX_CHARS

  useEffect(() => {
    if (!api) return
    // 超长源码不进渲染器：Mermaid 的布局是同步重活，超长输入会把主线程按在那儿。
    if (tooLong) {
      setSvg('')
      setError('')
      setDegraded('源码约 ' + Math.round(block.code.length / 1000) + ' 千字符，超过 ' + Math.round(MERMAID_MAX_CHARS / 1000) + ' 千字符上限：已跳过渲染，按源码显示。')
      return
    }
    let alive = true
    setSvg('')
    setError('')
    setDegraded('')
    const id = 'coomi-mermaid-' + Math.random().toString(36).slice(2, 9)
    const started = nowMs()
    void (async () => {
      try {
        await api.parse(block.code)
        const result = await api.render(id, block.code)
        const elapsed = nowMs() - started
        if (!alive) return
        // 单次预算：超了就丢弃这次结果（用户点「仍要显示」可以跳过这条判定）。
        if (elapsed > RICH_BUDGET_MS && !forced) {
          setDegraded('Mermaid 渲染用了 ' + Math.round(elapsed) + 'ms，超过 ' + RICH_BUDGET_MS + 'ms 预算：已降级为源码视图。')
          return
        }
        const clean = sanitizeSvg(result.svg)
        if (!clean) throw new Error('渲染结果不是可用的 SVG')
        setSvg(clean)
      } catch (e) {
        if (!alive) return
        // mermaid 的报错常常是「一行语法提示」，直接透出比包装成「渲染失败」有用。
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { alive = false }
  }, [api, block.code, attempt, theme, tooLong, forced])

  if (loadError) {
    return (
      <div className='px-3 py-3 text-12 text-danger'>
        <p className='flex items-center gap-1.5'><AlertTriangle size={13} />Mermaid 渲染器加载失败：{loadError}</p>
        <Button className='mt-2' size='sm' variant='secondary' onClick={() => void copyText(block.code)}>复制代码</Button>
      </div>
    )
  }
  if (!api) return <PreviewLoading label='正在加载 Mermaid 渲染器（约 3MB，仅首次）…' />

  if (degraded) {
    return (
      <div className='px-3 py-3 text-12 text-ink-2'>
        <p className='flex items-start gap-1.5 text-warn'>
          <AlertTriangle size={13} className='mt-[2px] shrink-0' />
          <span className='min-w-0 break-words'>{degraded}</span>
        </p>
        <pre className='mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-11 text-ink-2'>{block.code}</pre>
        <div className='mt-2 flex gap-1.5'>
          <Button size='sm' variant='secondary' onClick={() => setForced(true)}>仍要显示（可能卡顿）</Button>
          <Button size='sm' variant='ghost' onClick={() => void copyText(block.code)}>复制代码</Button>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className='px-3 py-3 text-12 text-warn'>
        <p className='flex items-start gap-1.5'>
          <AlertTriangle size={13} className='mt-[2px] shrink-0' />
          <span className='min-w-0 break-words'>无法预览：{error}</span>
        </p>
        <div className='mt-2 flex gap-1.5'>
          <Button size='sm' variant='secondary' onClick={() => setAttempt((v) => v + 1)}>重试</Button>
          <Button size='sm' variant='ghost' onClick={() => void copyText(block.code)}>复制代码</Button>
        </div>
      </div>
    )
  }
  if (!svg) return <PreviewLoading label='渲染中…' />

  return (
    <div className='min-w-0'>
      <div className='flex items-center gap-1.5 border-b border-line px-2 py-1'>
        <span className='text-11 text-ink-4'>Mermaid · securityLevel strict</span>
        <div className='flex-1' />
        <Button variant='ghost' size='icon-sm' className='h-6 w-6' title='重新渲染' onClick={() => setAttempt((v) => v + 1)}>
          <RefreshCw size={12} />
        </Button>
      </div>
      <div
        className='flex max-h-[520px] min-w-0 items-center justify-center overflow-auto p-3 [&_svg]:max-h-[480px] [&_svg]:max-w-full'
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}
