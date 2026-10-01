/** 插件页面的宿主（v2.1）：把插件目录里的静态 HTML 装进一个**隔离的 iframe**。
 *
 *  为什么是 iframe：
 *   · 插件页面与主界面不同源（asset:// 协议），DOM/CSS/JS 完全隔离 —— 插件写坏了也动不了
 *     聊天列表与 store；
 *   · 不给 Tauri IPC（withGlobalTauri 只在主页面注入，且这里不注入 boot 脚本），
 *     所以页面拿不到引擎端口与令牌，也就无法直连引擎。
 *
 *  需要数据的插件页面走 postMessage 找宿主代发：
 *    → 页面发 { type: 'coomi:request', id, path }
 *    ← 宿主回 { type: 'coomi:response', id, ok, status, data }
 *  只放行**只读 GET**（/api/ 开头、非 /api/admin、不可带 method），其余一律拒绝并回错误。
 *  这样「插件页面能不能读引擎数据」由宿主一处说了算，而不是每个插件自己想办法。
 */
import { useEffect, useMemo, useRef } from 'react'
import { Puzzle, RefreshCw } from 'lucide-react'
import { Button } from '../ui/Button'
import { useEngine } from '../../stores/engine'
import { assetUrlFor, usePluginViews } from '../../stores/pluginViews'

/** 只读白名单：/api/ 下的 GET；挡掉一切写操作与明显敏感的路径。 */
function allowedRequest(path: string): boolean {
  if (!path.startsWith('/api/')) return false
  if (path.startsWith('/api/admin')) return false
  return true
}

export function PluginViewHost({ viewKey }: { viewKey: string }) {
  const views = usePluginViews((s) => s.views)
  const loaded = usePluginViews((s) => s.loaded)
  const load = usePluginViews((s) => s.load)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const view = useMemo(() => views.find((v) => v.key === viewKey) ?? null, [views, viewKey])

  // 宿主代发的请求：postMessage 进来的只读 GET 走引擎的 api()（带令牌）。
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frameWindow = frame.current?.contentWindow
      // 只认自己的 iframe 发来的消息：别的窗口 / 别的插件页面一律不理。
      if (!frameWindow || event.source !== frameWindow) return
      const data = event.data as { type?: string; id?: string; path?: string } | null
      if (!data || data.type !== 'coomi:request' || typeof data.path !== 'string') return
      const id = String(data.id ?? '')
      const reply = (payload: Record<string, unknown>): void => {
        try { frameWindow.postMessage({ type: 'coomi:response', id, ...payload }, '*') } catch { /* 忽略 */ }
      }
      if (!allowedRequest(data.path)) {
        reply({ ok: false, status: 0, error: '插件页面只能读取 /api/ 下的只读接口' })
        return
      }
      void useEngine.getState().api<unknown>(data.path)
        .then((result) => reply({ ok: true, status: 200, data: result }))
        .catch((error: unknown) => reply({ ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  if (!view) {
    // 注册表还没回来：先摆骨架，别闪一句「没注册」吓人。
    if (!loaded) {
      return (
        <div className='flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 py-4'>
          <div className='skeleton h-4 w-36 shrink-0 rounded' />
          <div className='skeleton h-24 shrink-0 rounded-lg' />
        </div>
      )
    }
    return (
      <div className='flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-13 text-ink-3'>
        <Puzzle size={22} className='text-ink-4' />
        <div>这个插件页面没有注册（插件可能已被停用或卸载）。</div>
        <Button variant='secondary' size='sm' onClick={() => void load()}><RefreshCw size={13} /> 重新读取</Button>
      </div>
    )
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className='flex shrink-0 items-center gap-2 border-b border-line-soft px-1 pb-2 text-12 text-ink-3'>
        <Puzzle size={13} className='text-ink-4' />
        <span className='min-w-0 truncate text-ink'>{view.title}</span>
        <span className='shrink-0 text-11 text-ink-4'>插件页面 · 独立沙箱（只读 /api/）</span>
        <span className='flex-1' />
        <Button variant='ghost' size='sm' onClick={() => {
          // 重载走 key 变更太笨重：直接让 iframe 重新加载。
          const el = frame.current
          if (el) el.src = el.src
        }}>
          <RefreshCw size={13} /> 重新加载
        </Button>
      </div>
      <iframe
        ref={frame}
        // sandbox 保留 allow-scripts（插件页面是 HTML+JS），但**不给** allow-same-origin：
        // 页面因此在 null origin 里跑，拿不到宿主的 localStorage / cookie / parent DOM。
        sandbox='allow-scripts allow-forms allow-popups'
        src={assetUrlFor(view.entry)}
        title={view.title}
        className='min-h-0 w-full flex-1 border-0 bg-surface'
      />
    </div>
  )
}
