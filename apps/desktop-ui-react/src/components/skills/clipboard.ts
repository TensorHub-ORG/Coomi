/** 复制文本到剪贴板：优先用 Clipboard API，不可用时退回 textarea + execCommand。
 *  桌面壳（tauri.localhost）与浏览器直连都能用，失败时返回 false 由调用方提示。 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 无权限 / 非安全上下文：走下面的兜底 */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'true')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}
