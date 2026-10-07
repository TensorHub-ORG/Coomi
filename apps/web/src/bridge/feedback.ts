/**
 * 反馈上传统一桥：优先走原生 FeedbackManager（脱敏终检 + 环境补齐 + Outbox 兜底），
 * 无原生桥时降级为直接 fetch 旧端点（纯浏览器/调试场景）。
 * 另提供 reportError：让前端把可交互场景的异常交给原生弹窗做一键反馈。
 */
type FeedbackResult = { ok: boolean; error?: string; detail?: string; status?: string }
type FeedbackCb = (result: FeedbackResult) => void
type FeedbackWindow = Window & typeof globalThis & {
  __coomiFeedbackCallbacks?: Map<string, FeedbackCb>
  __coomiFeedbackResult?: (id: string, resultJson: string) => void
}

const FALLBACK_ENDPOINT = 'https://updates.septemc.com/coomi/feedback/api'

const feedbackWindow = window as FeedbackWindow
const feedbackCbs = (feedbackWindow.__coomiFeedbackCallbacks ??= new Map<string, FeedbackCb>())

// 原生桥完成后回调（在 JS 全局注册一次）。
feedbackWindow.__coomiFeedbackResult ??= (id: string, resultJson: string) => {
  const cb = feedbackCbs.get(id)
  if (!cb) return
  feedbackCbs.delete(id)
  try {
    cb(JSON.parse(resultJson))
  } catch {
    cb({ ok: false, error: 'bad result' })
  }
}

/** 通过原生桥上传（绕过 WebView CORS）；无桥时降级 fetch。 */
export function sendFeedbackViaBridge(payload: object): Promise<FeedbackResult> {
  const native = window.CoomiAndroid
  if (!native?.sendFeedback) return sendFeedbackDirect(payload)
  return new Promise((resolve) => {
    const id = `fb_${Date.now()}_${crypto.randomUUID()}`
    feedbackCbs.set(id, resolve)
    // 超时兜底：10s 无回调按失败处理。
    setTimeout(() => {
      if (feedbackCbs.delete(id)) resolve({ ok: false, error: 'timeout' })
    }, 10_000)
    try {
      ;(native.sendFeedback as (json: string, id: string) => void)(JSON.stringify(payload), id)
    } catch (e) {
      feedbackCbs.delete(id)
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

async function sendFeedbackDirect(payload: object): Promise<FeedbackResult> {
  try {
    const res = await fetch(FALLBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) return { ok: true, status: 'sent' }
    return { ok: false, error: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 把运行时异常交给原生弹「一键反馈」对话框（用户可交互时才由前端调用）。 */
export function reportErrorToNative(type: string, title: string, detail?: string): void {
  try {
    ;(window.CoomiAndroid as (unknown & { reportError?: (t: string, title: string, detail?: string) => void })
      | undefined)?.reportError?.(type, title, detail)
  } catch {
    /* 桥不可用时静默 */
  }
}
