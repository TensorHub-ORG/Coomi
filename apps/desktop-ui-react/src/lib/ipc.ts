/** Tauri v2 的全局对象：invoke 挂在 __TAURI__.core 上（不是顶层）。 */
interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

declare global {
  interface Window { __TAURI__?: TauriGlobal }
}

function invokeFn(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined {
  const t = typeof window === 'undefined' ? undefined : window.__TAURI__
  return t?.core?.invoke ?? t?.invoke
}

export function hasIpc(): boolean {
  return !!invokeFn()
}

/** 调用桌面壳命令。壳不可用（浏览器里打开）时抛出可读错误，而不是静默失败。 */
export async function ipc<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = invokeFn()
  if (!invoke) throw new Error('桌面壳未就绪：当前不在 Tauri 环境中运行')
  return (await invoke(cmd, args)) as T
}
