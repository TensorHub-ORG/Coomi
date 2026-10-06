// zcode-captcha.ts —— ZCode Coding Plan 无痕验证（每次调用前自动执行）
// 发送消息前调用 ensureCaptcha()，确保 provider headers 里的验证码 token 新鲜。

export interface CaptchaResult { ok: boolean; param?: string; message?: string }

const CAPTCHA_SCENE_ID = '11xygtvd'
const CAPTCHA_REGION = 'cn'
const CAPTCHA_PREFIX = 'no8xfe'
const CAPTCHA_SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'

let lastParam = ''
let lastTime = 0
const TOKEN_TTL = 10 * 60 * 1000 // 验证码 token 约 10 分钟内有效；避免每次请求触发验证导致 3012 风控

declare global {
  interface Window {
    initAliyunCaptcha?: (config: any) => any
    AliyunCaptchaConfig?: { region: string; prefix: string }
    __zhipuCaptchaParam?: string
    __zhipuCaptchaError?: string
  }
}

function loadCaptchaSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).initAliyunCaptcha) { resolve(); return }
    const existing = document.querySelector(`script[src="${CAPTCHA_SDK_URL}"]`) as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(Error('验证码 SDK 加载失败')))
      return
    }
    const script = document.createElement('script')
    script.src = CAPTCHA_SDK_URL
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(Error('验证码 SDK 加载失败'))
    document.head.appendChild(script)
  })
}

function ensureCaptchaDom(): void {
  if (document.getElementById('zcode-aliyun-captcha-container')) return
  const container = document.createElement('div')
  container.id = 'zcode-aliyun-captcha-container'
  container.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;height:0;width:0;overflow:visible'
  const host = document.createElement('div')
  host.id = 'zcode-aliyun-captcha-element'
  host.style.cssText = 'position:absolute;left:0;top:0;height:0;width:0;overflow:visible'
  const btn = document.createElement('button')
  btn.id = 'zcode-aliyun-captcha-button'
  btn.type = 'button'; btn.tabIndex = -1
  btn.style.cssText = 'position:fixed;left:50%;top:50%;height:1px;width:1px;transform:translate(-50%,-50%);border:0;padding:0;opacity:0'
  container.appendChild(host); container.appendChild(btn)
  document.body.appendChild(container)
}

/** 执行一次阿里云验证码，返回 verifyParam。优先无痕（静默），失败弹窗。 */
async function runCaptchaOnce(): Promise<CaptchaResult> {
  try {
    await loadCaptchaSdk()
    const init = (window as any).initAliyunCaptcha
    if (typeof init !== 'function') return { ok: false, message: '验证码 SDK 不可用' }
    ensureCaptchaDom()
    window.__zhipuCaptchaParam = ''
    window.AliyunCaptchaConfig = { region: CAPTCHA_REGION, prefix: CAPTCHA_PREFIX }

    const instance = await new Promise<any>((resolve) => {
      try {
        init({
          SceneId: CAPTCHA_SCENE_ID,
          mode: 'popup',
          element: '#zcode-aliyun-captcha-element',
          button: '#zcode-aliyun-captcha-button',
          showErrorTip: false,
          getInstance: (ins: any) => resolve(ins),
          success: (param: string) => { window.__zhipuCaptchaParam = param || '' },
          fail: (err: any) => { window.__zhipuCaptchaError = JSON.stringify(err) },
        })
      } catch { resolve(null) }
    })
    if (!instance) return { ok: false, message: '验证码实例未就绪' }

    // 无痕优先（自动静默）；不支持再弹窗
    if (typeof instance.startTracelessVerification === 'function') {
      instance.startTracelessVerification()
    } else if (typeof instance.show === 'function') {
      instance.show()
    } else {
      return { ok: false, message: '验证码实例无可用方法' }
    }

    const result = await new Promise<string | null>((resolve) => {
      const start = Date.now()
      const timer = setInterval(() => {
        if ((window as any).__zhipuCaptchaParam) { clearInterval(timer); resolve((window as any).__zhipuCaptchaParam); return }
        if (Date.now() - start > 45000) { clearInterval(timer); resolve(null) }
      }, 300)
    })
    if (!result) return { ok: false, message: (window as any).__zhipuCaptchaError || '验证码超时' }
    return { ok: true, param: result }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
}

/** 调用前调用：确保有新鲜的验证码 token。首次或过期时自动验证。 */
export async function ensureCaptcha(force = false): Promise<CaptchaResult> {
  const now = Date.now()
  if (!force && lastParam && now - lastTime < TOKEN_TTL) {
    return { ok: true, param: lastParam }
  }
  const res = await runCaptchaOnce()
  if (res.ok && res.param) {
    lastParam = res.param
    lastTime = Date.now()
  }
  return res
}

/** 清除缓存的验证码（3007 过期时调用，强制下次重新验证）。 */
export function invalidateCaptcha(): void {
  lastParam = ''
  lastTime = 0
}

/** 获取当前缓存的验证码头（可能为空，调用前应 ensureCaptcha）。 */
export function currentCaptchaHeaders(): Record<string, string> {
  if (!lastParam) return {}
  return {
    'X-Aliyun-Captcha-Verify-Param': lastParam,
    'X-Aliyun-Captcha-Verify-Region': CAPTCHA_REGION,
  }
}