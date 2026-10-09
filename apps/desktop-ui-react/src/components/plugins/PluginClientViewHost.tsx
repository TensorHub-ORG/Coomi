/** 客户端插件页面的宿主：直接渲染插件自己注册的 `render()`。
 *
 *  与声明式插件页（PluginViewHost 的 iframe）**不是一回事**：
 *   · 声明式插件页是静态 HTML，装在独立 origin 的 iframe 里、不给 Tauri IPC —— 沙箱；
 *   · 客户端插件是**全信任**的，它本来就跑在宿主渲染进程里（用户拍板的信任模型），
 *     所以这里不做隔离，直接把它的 React 输出挂进主内容列。
 *
 *  渲染失败不带走整页：同步抛错在这里兜住，显示一条可读提示 ——
 *  插件是第三方代码，坏掉是常态，不能让它把对话页一起拖下水。
 */
import { AlertTriangle } from 'lucide-react'
import { usePluginClientViews } from './clientRuntime'

export function PluginClientViewHost({ viewKey }: { viewKey: string }) {
  const views = usePluginClientViews()
  const view = views.find((candidate) => candidate.key === viewKey) ?? null
  if (!view) {
    return (
      <div className='flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center'>
        <AlertTriangle size={18} className='text-warn' />
        <p className='text-13 text-ink-2'>这个插件页面暂时不可用</p>
        <p className='max-w-[420px] text-12 text-ink-4'>
          插件可能已被停用，或者正在热加载。改完插件源码后这里会在几秒内自动恢复。
        </p>
      </div>
    )
  }
  try {
    return <div className='min-h-0 flex-1 overflow-auto'>{view.render() as React.ReactNode}</div>
  } catch (error) {
    return (
      <div className='flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center'>
        <AlertTriangle size={18} className='text-danger' />
        <p className='text-13 text-ink-2'>插件「{view.title}」渲染失败</p>
        <p className='max-w-[520px] break-words font-mono text-11 text-ink-4'>
          {error instanceof Error ? error.message : String(error)}
        </p>
      </div>
    )
  }
}
