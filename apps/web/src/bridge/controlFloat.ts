/**
 * 控制模式的桌面悬浮层桥接。
 *
 * 控制模式开启后，用户会切到微信 / QQ 之类的目标 App，此时 Coomi 界面已经不在前台 ——
 * 但引擎仍在跑、模型仍在思考。这个模块负责把引擎侧的动态（思考片段、工具调用、
 * 状态变化）转发到原生悬浮层，让用户不用切回来也能看到进度。
 *
 * 设计上刻意做得「静默」：桥不可用、悬浮层没起、控制模式没开，都直接忽略，
 * 绝不因为转发失败影响正常对话。
 */

const MAX_TEXT = 160

let enabled = false

/** 控制模式开关由 Composer 驱动。 */
export function setControlModeActive(value: boolean): void {
  enabled = value
}

export function isControlModeActive(): boolean {
  return enabled
}

interface CoomiBridge {
  pushControlFloat?: (title: string, body: string) => void
  pushControlStatus?: (status: string) => void
  startControlFloat?: () => void
  stopControlFloat?: () => void
  isControlFloatRunning?: () => boolean
}

function bridge(): CoomiBridge | null {
  const candidate = (globalThis as { CoomiAndroid?: CoomiBridge }).CoomiAndroid
  return candidate ?? null
}

function clip(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed
}

/** 追加一条记录到悬浮层的思考区。 */
export function pushTrace(title: string, body = ''): void {
  if (!enabled) return
  try {
    bridge()?.pushControlFloat?.(clip(title), clip(body))
  } catch { /* 悬浮层不可用时静默忽略 */ }
}

/** 只刷新悬浮层顶部状态行，不往思考区堆内容。 */
export function pushStatus(status: string): void {
  if (!enabled) return
  try {
    bridge()?.pushControlStatus?.(clip(status))
  } catch { /* 忽略 */ }
}
