/**
 * KaTeX 公式预览：懒加载 katex 与它的样式表（首次约 280KB + 字体按需），
 * 用 throwOnError:false —— 公式写错时显示红色原文而不是把预览整块炸掉。
 *
 * 卡死防线（公式是同步重活，绝不能在渲染里做）：
 *   - 渲染挪到 effect + 空闲期调度，卸载 / 内容变化即刻取消；
 *   - 长度超过 MATH_MAX_CHARS 直接跳过渲染，按源码显示；
 *   - 单次渲染给 200ms 预算，超预算丢弃产物、降级为源码视图并说明原因。
 */
import { useEffect, useMemo, useState } from 'react'
import { PreviewLoading, useLazyModule } from './common'
import { stripMathShell } from '../detect'
import { MATH_MAX_CHARS, RICH_BUDGET_MS, runWithBudget, scheduleIdle } from '../limits'
import type { RichBlock } from '../store'

type KatexApi = { renderToString: (tex: string, options?: Record<string, unknown>) => string }

async function loadKatex(): Promise<KatexApi> {
  const [mod] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')])
  return (mod.default ?? mod) as unknown as KatexApi
}

export function MathPreview({ block }: { block: RichBlock }) {
  const { value: katex, error } = useLazyModule(loadKatex, 'katex')
  const tex = useMemo(() => stripMathShell(block.code), [block.code])
  const [html, setHtml] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!katex) { setHtml(''); setNote(''); return }
    if (tex.length > MATH_MAX_CHARS) {
      setHtml('')
      setNote('公式约 ' + Math.round(tex.length / 1000) + ' 千字符，超过 ' + Math.round(MATH_MAX_CHARS / 1000) + ' 千字符上限：已跳过 KaTeX 渲染，按源码显示。')
      return
    }
    let alive = true
    setNote('')
    // 空闲期再渲染：这一步是同步重活，放在渲染函数 / effect 主体里都会挡住出帧。
    const cancel = scheduleIdle(() => {
      if (!alive) return
      const outcome = runWithBudget(() => {
        try {
          return katex.renderToString(tex, { displayMode: true, throwOnError: false, output: 'html', strict: 'ignore' })
        } catch {
          return ''
        }
      }, RICH_BUDGET_MS)
      if (!alive) return
      if (!outcome.ok) {
        setHtml('')
        setNote('KaTeX 渲染超过 ' + RICH_BUDGET_MS + 'ms 预算（实测 ' + Math.round(outcome.ms) + 'ms）：已降级为源码视图。')
        return
      }
      // 渲染失败（返回空串）时也走源码视图，但这是「公式本身的问题」，不加预算提示。
      setHtml(outcome.value)
    })
    return () => { alive = false; cancel() }
  }, [katex, tex])

  if (error) return <div className='px-3 py-3 text-12 text-danger'>KaTeX 加载失败：{error}</div>
  if (!katex) return <PreviewLoading label='正在加载 KaTeX…' />
  return (
    <div className='min-w-0 px-3 py-3'>
      {note ? <p className='mb-2 text-11 leading-[1.5] text-ink-4'>{note}</p> : null}
      <div className='overflow-x-auto'>
        {html
          ? <div className='katex-host min-w-0 text-ink' dangerouslySetInnerHTML={{ __html: html }} />
          : <pre className='whitespace-pre-wrap break-all font-mono text-12 text-ink-2'>{tex}</pre>}
      </div>
    </div>
  )
}
