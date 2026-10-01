/**
 * React / TSX 预览：sucrase 在浏览器里编译，React 运行时来自**本地打包好的 IIFE**，整条链路不联网。
 *
 * 三步：
 *   1) compileReactPreview()：剥类型 + 转 JSX，并把裸 import 改写成取全局（沙箱里没有模块系统）；
 *   2) virtual:coomi-react-runtime：构建期由 vite 插件用 esbuild 把 react/react-dom 打成一段源码字符串，
 *      这里以 inline <script> 注进帧 —— React 19 已经没有现成的 UMD 文件可拷，这是等价做法；
 *   3) 注入 createRoot 引导，渲染到 #root。
 *
 * 任何一步失败（sucrase 加载不了、编译报错、运行时缺失、找不到根组件）都降级成
 * 「无法预览，可复制代码」，绝不给出一个空白帧让人猜。
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '../../ui/Button'
import { PreviewLoading } from './common'
import { SandboxFrame } from './SandboxFrame'
import { buildFrameDocument } from './frame'
import { compileReactPreview } from './compile'
import { copyText } from '../actions'
import type { RichBlock } from '../store'

interface Compiled { code: string; bootstrap: string; warnings: string[] }

let runtimeSource: string | null = null

async function loadRuntime(): Promise<string> {
  if (runtimeSource) return runtimeSource
  const mod = await import('virtual:coomi-react-runtime')
  runtimeSource = mod.default
  return runtimeSource
}

export function ReactPreview({ block }: { block: RichBlock }) {
  const [compiled, setCompiled] = useState<Compiled | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const token = useMemo(() => 'react-' + block.id + '-' + Math.random().toString(36).slice(2, 8), [block.id])

  useEffect(() => {
    let alive = true
    setCompiled(null)
    setError('')
    void (async () => {
      try {
        const [result, runtime] = await Promise.all([compileReactPreview(block.code), loadRuntime()])
        if (!runtime || runtime.length < 100) throw new Error('本地 React 运行时缺失（构建期的 coomi-react-runtime 插件没有产出内容）')
        if (!alive) return
        setCompiled({ code: result.code, bootstrap: result.bootstrap, warnings: result.warnings })
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { alive = false }
  }, [block.code])

  const doc = useMemo(() => {
    if (!compiled || !runtimeSource) return ''
    return buildFrameDocument({
      token,
      title: 'React 预览',
      bodyHtml: '<div id="root"></div>',
      scripts: [
        { code: runtimeSource },
        { code: compiled.code },
        ...(compiled.bootstrap ? [{ code: compiled.bootstrap }] : []),
      ],
      bodyStyle: 'margin:0;padding:12px;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;background:#fff',
    })
  }, [compiled, token])

  if (error) {
    return (
      <div className='px-3 py-3 text-12'>
        <p className='flex items-start gap-1.5 text-warn'>
          <AlertTriangle size={13} className='mt-[2px] shrink-0' />
          <span className='min-w-0 break-words'>无法预览，可复制代码：{error}</span>
        </p>
        <div className='mt-2 flex gap-1.5'>
          <Button size='sm' variant='secondary' onClick={() => void copyText(block.code)}>复制代码</Button>
        </div>
      </div>
    )
  }
  if (!compiled) return <PreviewLoading label='正在加载 sucrase 并编译 TSX…' />

  return (
    <div className='flex min-h-0 min-w-0 flex-col'>
      <div className='flex items-center gap-1.5 border-b border-line px-2 py-1 text-11 text-ink-4'>
        <span className='min-w-0 flex-1 truncate'>sucrase 编译 · 本地 React 运行时 · 沙箱 iframe</span>
        <Button variant='ghost' size='icon-sm' className='h-6 w-6' title='重新编译并运行' onClick={() => setReload((v) => v + 1)}>
          <RefreshCw size={12} />
        </Button>
      </div>
      {compiled.warnings.length ? (
        <ul className='border-b border-line bg-warn-soft px-2 py-1 text-11 text-warn'>
          {compiled.warnings.slice(0, 4).map((warning, index) => <li key={index} className='break-all'>· {warning}</li>)}
          {compiled.warnings.length > 4 ? <li>· 还有 {compiled.warnings.length - 4} 条…</li> : null}
        </ul>
      ) : null}
      <SandboxFrame doc={doc} token={token} title='React 预览' reloadSignal={reload} height={320} />
    </div>
  )
}
