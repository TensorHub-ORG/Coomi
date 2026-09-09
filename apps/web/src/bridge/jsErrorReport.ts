/**
 * WebView JS 全局错误捕获：window.onerror + unhandledrejection 聚合防抖后
 * 交给原生弹「一键反馈」对话框。60 秒窗口内最多上报一次，避免错误风暴弹窗轰炸。
 */
import { reportErrorToNative } from './feedback'

const REPORT_INTERVAL_MS = 60_000

let lastReportAt = 0
let pendingCount = 0
let pendingDetail = ''

function reportNow() {
  if (!pendingCount) return
  const detail = pendingDetail
  const count = pendingCount
  lastReportAt = Date.now()
  pendingCount = 0
  pendingDetail = ''
  reportErrorToNative('runtime_error', `页面运行异常（${count} 处）`, detail)
}

function recordError(kind: string, message: string, source?: string) {
  pendingCount += 1
  const line = `[${kind}] ${message}${source ? ` @ ${source}` : ''}`
  pendingDetail = pendingDetail ? `${pendingDetail}\n${line}` : line
  // 详情保尾（最新错误最有信息量），上限 4KB。
  if (pendingDetail.length > 4096) pendingDetail = '…（前段已截断）\n' + pendingDetail.slice(-4096)
  if (Date.now() - lastReportAt >= REPORT_INTERVAL_MS) reportNow()
  else if (pendingCount === 1) setTimeout(reportNow, REPORT_INTERVAL_MS)
}

/** 在应用入口安装一次。 */
export function installJsErrorReport(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (event) => {
    const message = event.message || 'unknown script error'
    recordError('js_error', message, event.filename ? `${event.filename}:${event.lineno}` : undefined)
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const message = reason instanceof Error ? `${reason.message}` : String(reason ?? 'unhandled rejection')
    recordError('promise_rejection', message)
  })
}
