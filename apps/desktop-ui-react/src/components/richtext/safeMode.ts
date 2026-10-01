/**
 * 安全模式：打开后**完全跳过**富预览（iframe 沙箱、Mermaid、KaTeX、SVG 内联），
 * 代码块只出纯文本 + 动作条，识别结果照常展示但不渲染任何重内容。
 *
 * 这是一道「用户说了算」的开关，不是安全边界的替代品：沙箱 / CSP / sanitize 那几道防线
 * 在任何模式下都原样生效（见 preview/frame.ts、preview/SvgPreview.tsx）。
 *
 * 读取顺序（先命中先用）：
 *   1) 进程内显式 override：setRichSafeMode(true/false)，设置页接过来就是这一条；
 *   2) window.__COOMI_RICH_SAFE_MODE__：桌面壳 / 测试可以整片注入；
 *   3) localStorage['coomi:rich-safe-mode'] === '1'；
 *   4) <html data-rich-safe-mode="on">。
 * 默认关闭（保持现有行为）。
 */

export const RICH_SAFE_MODE_KEY = 'coomi:rich-safe-mode'

let override: boolean | null = null
const listeners = new Set<() => void>()

/** 显式开关：传 null 恢复「按环境读取」。 */
export function setRichSafeMode(on: boolean | null): void {
  if (override === on) return
  override = on
  emit()
}

/** 当前是否处于安全模式。 */
export function isRichSafeMode(): boolean {
  if (override !== null) return override
  const host = globalThis as { __COOMI_RICH_SAFE_MODE__?: unknown }
  if (typeof host.__COOMI_RICH_SAFE_MODE__ === 'boolean') return host.__COOMI_RICH_SAFE_MODE__
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(RICH_SAFE_MODE_KEY) === '1') return true
  } catch { /* 隐私模式 / 无存储权限：按关闭处理 */ }
  try {
    if (typeof document !== 'undefined' && document.documentElement.dataset.richSafeMode === 'on') return true
  } catch { /* 没有 document（冒烟环境）：按关闭处理 */ }
  return false
}

/** 订阅开关变化（useRichSafeMode 用它驱动重渲染）。 */
export function subscribeRichSafeMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 环境本身变了（localStorage / data 属性）时手动广播一次。 */
export function emitRichSafeModeChange(): void {
  emit()
}

function emit(): void {
  for (const listener of [...listeners]) {
    try { listener() } catch { /* 单个订阅者出错不影响其它订阅者 */ }
  }
}
