// Passive main-thread measurements for the existing 10-second diagnostic report.
// No animation loop or extra polling; no message text or model credentials.
let count = 0
let total = 0
let longest = 0
let sampledAt = typeof performance === 'undefined' ? 0 : performance.now()
if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      count += 1
      total += entry.duration
      longest = Math.max(longest, entry.duration)
    }
  })
  observer.observe({ type: 'longtask', buffered: true })
  if (import.meta.hot) import.meta.hot.dispose(() => observer.disconnect())
}

export function takeRenderDiagnostics() {
  const now = performance.now()
  const result = {
    windowMs: Math.round(now - sampledAt),
    longTasks: count,
    longTaskMs: Math.round(total),
    maxTaskMs: Math.round(longest),
    visible: !document.hidden,
    nodes: document.getElementsByTagName('*').length,
    activeAnimations: document.getAnimations().filter((animation) => animation.playState === 'running').length,
  }
  count = total = longest = 0
  sampledAt = now
  return result
}
