/**
 * 预览组件共用的工具：
 *   - PreviewNote：加载中 / 出错 / 降级 的提示条；
 *   - useLazyModule：动态 import 一个重库（sucrase / mermaid / katex）并给到 loading / error；
 *   - useInView：不可见的预览直接卸载，避免隐藏的 iframe / 图表在后台空转。
 *   - useThemeKey：跟随主题切换重绘（Mermaid / 公式这类要按明暗主题重新渲染的用它）。
 *   - useRichSafeMode：安全模式开关（开启后完全跳过 iframe / Mermaid / KaTeX）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, Info, Loader2 } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { isRichSafeMode, subscribeRichSafeMode } from '../safeMode'

export function PreviewNote({ tone = 'info', children, action }: {
  tone?: 'info' | 'warn' | 'danger'
  children: React.ReactNode
  action?: React.ReactNode
}) {
  const Icon = tone === 'info' ? Info : AlertTriangle
  return (
    <div className={cn('flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-11 leading-[1.5]',
      tone === 'info' ? 'border-line bg-muted text-ink-3'
        : tone === 'warn' ? 'border-warn/40 bg-warn-soft text-warn'
          : 'border-danger/30 bg-danger-soft text-danger')}>
      <Icon size={12} className='mt-[2px] shrink-0' />
      <div className='min-w-0 flex-1 break-words'>{children}</div>
      {action}
    </div>
  )
}

export function PreviewLoading({ label }: { label: string }) {
  return (
    <div className='flex items-center gap-2 px-3 py-6 text-12 text-ink-3'>
      <Loader2 size={13} className='animate-spin' />
      {label}
    </div>
  )
}

/** 动态加载一个重库：只在真正要用到的时候才下载（Mermaid ~3MB、sucrase ~300KB、KaTeX ~280KB）。 */
export function useLazyModule<T>(load: () => Promise<T>, key: string): { value: T | null; error: string } {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState('')
  const loader = useRef(load)
  loader.current = load

  useEffect(() => {
    let alive = true
    setValue(null)
    setError('')
    void loader.current().then(
      (mod) => { if (alive) setValue(mod) },
      (e) => { if (alive) setError(e instanceof Error ? e.message : String(e)) },
    )
    return () => { alive = false }
  }, [key])

  return { value, error }
}

/** 元素是否在视口附近：false 时调用方应卸载重内容（iframe / 图表）。 */
export function useInView<T extends Element>(margin = '400px'): { ref: React.RefObject<T | null>; inView: boolean } {
  const ref = useRef<T | null>(null)
  // 初始 true：预览是用户点出来的，点的那一刻它一定可见；观测到不可见后再卸载。
  const [inView, setInView] = useState(true)

  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) setInView(entry.isIntersecting)
    }, { rootMargin: margin })
    observer.observe(node)
    return () => observer.disconnect()
  }, [margin])

  return { ref, inView }
}

/**
 * 安全模式：开启后所有富预览（沙箱 iframe / Mermaid / KaTeX / 内联 SVG）整体跳过，只看源码。
 * 用 useSyncExternalStore 订阅，开关一变界面立刻跟着变。
 */
export function useRichSafeMode(): boolean {
  return useSyncExternalStore(subscribeRichSafeMode, isRichSafeMode, () => false)
}

/** 主题键：跟随 <html data-theme> 变化，让按主题渲染的预览（Mermaid）重新画一遍。 */
export function useThemeKey(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'))
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}
