<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { useConfigStore, type ProviderInput } from '@/stores/config'
import { stashEngineToken, engineToken, ENGINE_TOKEN_KEY } from '@/bridge/http'

declare global {
  interface Window {
    initAliyunCaptcha?: (config: any) => any
    AliyunCaptchaConfig?: { region: string; prefix: string }
    __zhipuCaptchaParam?: string
  }
}

const router = useRouter()
const route = useRoute()
const config = useConfigStore()

/** 智谱 GLM Coding —— Anthropic 兼容接入。 */
const ANTHROPIC_BASE = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic'
const GLM_MODELS = ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']

const mode = ref<'oauth' | 'apikey'>('oauth')
const apiKey = ref('')
const saving = ref(false)
const busy = ref(false)
const message = ref('')
const error = ref('')

// OAuth 状态
const state = ref('')
const oauthUrl = ref('')
const OAUTH_AUTHORIZE = 'https://bigmodel.cn/login'
const OAUTH_TOKEN = 'https://zcode.z.ai/api/v1/oauth/token'
const APP_ID = 'zcode'
// 回调走本机 loopback 路径，由 Android 侧 shouldInterceptRequest 拦截并跳回前端。
function oauthRedirect(): string {
  try {
    // 带上引擎 token，Android 回调页跳回时才能恢复认证。
    const token = new URLSearchParams(window.location.search).get('token') || ''
    return window.location.origin + '/__zhipu_oauth_cb?token=' + encodeURIComponent(token)
  } catch {
    return 'coomi://oauth/callback'
  }
}
let REDIRECT_URI = 'coomi://oauth/callback'

function readOAuthParams(): { code?: string; state?: string } {
  // hash 形式: #/zhipu-login?code=..&state=..
  const hash = window.location.hash
  const qIdx = hash.indexOf('?')
  if (qIdx >= 0) {
    const params = new URLSearchParams(hash.slice(qIdx + 1))
    const code = params.get('code') || params.get('authCode')
    const st = params.get('state')
    if (code && st) return { code, state: st }
  }
  // query 形式: ?code=..&state=..
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code') || params.get('authCode')
  const st = params.get('state')
  if (code && st) return { code, state: st }
  return {}
}

onMounted(() => {
  const oauth = readOAuthParams()
  if (oauth.code && oauth.state) {
    handleOAuthCode(oauth.code, oauth.state)
  }
  // 对话时收到 captcha_required 自动跳转本页时，自动开始验证码
  const needCaptcha = new URLSearchParams(window.location.search).get('need_captcha') === '1'
    || new URLSearchParams(window.location.hash.split('?')[1] || '').get('need_captcha') === '1'
  if (needCaptcha) {
    setTimeout(() => { void verifyCaptchaAndSave() }, 600)
  }
})

function randomState(): string {
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
}

function startOAuth() {
  state.value = randomState()
  try { sessionStorage.setItem('coomi.zhipu.oauth.state', state.value) } catch {}
  // 把引擎 token 存进 sessionStorage：整页跳转智谱再跳回后，authedFetch 可恢复认证。
  stashEngineToken(engineToken())
  REDIRECT_URI = oauthRedirect()
  const u = new URL(OAUTH_AUTHORIZE)
  u.searchParams.set('redirect', REDIRECT_URI)
  u.searchParams.set('appId', APP_ID)
  u.searchParams.set('state', state.value)
  oauthUrl.value = u.toString()
  busy.value = true
  error.value = ''
  // 整页导航到智谱登录页（智谱设置了 X-Frame-Options 禁 iframe，必须整页跳转）。
  // 授权后智谱会重定向回本机 loopback 回调路径，由 Android 拦截并跳回本页。
  window.location.href = oauthUrl.value
}

async function handleOAuthCode(code: string, st: string) {
  let expected = state.value
  try { expected = expected || sessionStorage.getItem('coomi.zhipu.oauth.state') || '' } catch {}
  if (st !== expected) {
    error.value = 'OAuth state 不匹配，请重试'
    return
  }
  try { sessionStorage.removeItem('coomi.zhipu.oauth.state') } catch {}
  busy.value = true
  try {
    const res = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'bigmodel',
        code,
        redirect_uri: REDIRECT_URI,
        state: st,
      }),
    })
    const data = await res.json()
    const jwt = data?.data?.token || data?.token || data?.access_token
    if (!jwt) {
      error.value = '登录失败：未获取到有效 token（' + (data?.msg || res.status) + '）'
      return
    }
    await configureProvider(jwt)
    message.value = '智谱账号登录成功，已配置 GLM Coding Provider。'
  } catch (e) {
    error.value = '登录失败：' + String(e)
  } finally {
    busy.value = false
  }
}


// ========== 阿里云验证码（ZCode Coding Plan 风控） ==========
const CAPTCHA_SCENE_ID = '11xygtvd'
const CAPTCHA_REGION = 'cn'
const CAPTCHA_PREFIX = 'no8xfe'
const CAPTCHA_SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'

const captchaBusy = ref(false)
const captchaMsg = ref('')

function loadCaptchaSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).initAliyunCaptcha) { resolve(); return }
    const existing = document.querySelector(`script[src="${CAPTCHA_SDK_URL}"]`) as HTMLScriptElement | null
    if (existing) { existing.addEventListener('load', () => resolve()); existing.addEventListener('error', () => reject(Error('验证码 SDK 加载失败'))); return }
    const script = document.createElement('script')
    script.src = CAPTCHA_SDK_URL; script.async = true
    script.onload = () => resolve(); script.onerror = () => reject(Error('验证码 SDK 加载失败'))
    document.head.appendChild(script)
  })
}

async function runCaptcha(): Promise<string | null> {
  captchaBusy.value = true; captchaMsg.value = ''
  window.__zhipuCaptchaParam = ''
  captchaMsg.value = '加载验证码…'
  try {
    await loadCaptchaSdk()
    const init = (window as any).initAliyunCaptcha
    if (typeof init !== 'function') { captchaMsg.value = '验证码 SDK 加载失败（initAliyunCaptcha 不可用）'; return null }
    captchaMsg.value = 'SDK 已加载，初始化验证码…'
    // 创建 ZCode 同款容器 DOM
    let container = document.getElementById('zcode-aliyun-captcha-container')
    if (!container) {
      container = document.createElement('div')
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
    window.AliyunCaptchaConfig = { region: CAPTCHA_REGION, prefix: CAPTCHA_PREFIX }
    // 等待实例就绪
    const instance = await new Promise<any>((resolve, reject) => {
      try {
        init({
          SceneId: CAPTCHA_SCENE_ID,
          mode: 'popup',
          element: '#zcode-aliyun-captcha-element',
          button: '#zcode-aliyun-captcha-button',
          showErrorTip: true,
          getInstance: (ins: any) => { captchaMsg.value = '验证码实例已就绪'; resolve(ins) },
          success: (param: string) => { window.__zhipuCaptchaParam = param || '' },
          fail: (err: any) => { captchaMsg.value = '验证码验证失败：' + JSON.stringify(err) },
          onError: (err: any) => { captchaMsg.value = '验证码错误：' + JSON.stringify(err) }
        })
      } catch (e) { reject(e) }
    })
    if (!instance) { captchaMsg.value = '验证码实例为空'; return null }
    // 优先无痕验证（自动完成，不弹窗）；不支持再交互弹窗
    if (typeof instance.startTracelessVerification === 'function') {
      captchaMsg.value = '正在进行无痕验证…'
      instance.startTracelessVerification()
    } else if (typeof instance.show === 'function') {
      captchaMsg.value = '弹出验证码…'
      instance.show()
    } else {
      captchaMsg.value = '验证码实例无可用方法'
      return null
    }
    // 等待结果（最长 90 秒）
    const result = await new Promise<string | null>((resolve) => {
      const started = Date.now()
      const timer = setInterval(() => {
        if ((window as any).__zhipuCaptchaParam) { clearInterval(timer); captchaMsg.value = '验证码成功'; resolve((window as any).__zhipuCaptchaParam); return }
        if (Date.now() - started > 90000) { clearInterval(timer); captchaMsg.value = captchaMsg.value || '验证码超时'; resolve(null) }
      }, 400)
    })
    return result
  } catch (e) {
    captchaMsg.value = '验证码异常：' + String(e)
    return null
  } finally {
    captchaBusy.value = false
  }
}
async function verifyCaptchaAndSave() {
  const provider = config.providers.find((p: any) => p.id === 'zhipu-coding')
  const jwt = provider?.apiKeyMasked ? await config.revealProviderKey('zhipu-coding') : ''
  const headers = (provider as any)?.headers || {}
  if (!jwt) { captchaMsg.value = '请先登录或填写 API Key'; return }
  const param = await runCaptcha()
  if (!param) { captchaMsg.value = captchaMsg.value || '验证码未完成'; return }
  // 存 verifyParam 到 provider headers
  const ok = await config.upsertProvider({
    id: 'zhipu-coding',
    name: '智谱 GLM Coding',
    apiKey: jwt,
    models: GLM_MODELS,
    baseUrl: ANTHROPIC_BASE,
    type: 'anthropic_messages',
    toolProtocol: 'anthropic_messages',
    contextWindow: 1000000,
    fastModel: 'GLM-5.3-Flash',
    supportsVision: true,
    headers: { ...headers, 'X-Aliyun-Captcha-Verify-Param': param, 'X-Aliyun-Captcha-Verify-Region': CAPTCHA_REGION },
  } as any, )
  if (ok) {
    captchaMsg.value = '验证码已通过，Coding Plan 已解锁。'
    // 验证成功，回到对话页
    setTimeout(() => { router.push('/') }, 1200)
  } else {
    captchaMsg.value = '保存验证码失败：' + (config.lastError || '未知错误')
  }
}


async function configureProvider(jwtOrKey: string): Promise<boolean> {
  saving.value = true
  const base: ProviderInput = {
    id: 'zhipu-coding',
    name: '智谱 GLM Coding',
    apiKey: jwtOrKey,
    models: GLM_MODELS,
    baseUrl: ANTHROPIC_BASE,
    type: 'anthropic_messages',
    toolProtocol: 'anthropic_messages',
    contextWindow: 1000000,
    fastModel: 'GLM-5.3-Flash',
    activate: true,
    supportsVision: true,
  }
  // 智谱 Coding Plan 的 JWT 只被其 Anthropic 代理端点接受，标准 OpenAI /models
  // 会 401；因此默认“仅保存配置、不激活”，绕过后端凭据校验（verify 需要 /models）。
  // 保存后用户可在“提供商配置”中手动选择该 provider 发起对话。
  const ok = await config.upsertProvider({ ...base, activate: false })
  saving.value = false
  if (!ok) {
    error.value = 'Provider 保存失败：' + (config.lastError || '未知错误')
  } else {
    error.value = ''
  }
  return ok
}

async function saveApiKey() {
  if (!apiKey.value.trim()) {
    error.value = '请填写智谱 API Key'
    return
  }
  error.value = ''
  await configureProvider(apiKey.value.trim())
  if (!error.value) message.value = '智谱 GLM Coding 已配置（API Key 方式）。'
}

function backToProviders() {
  router.push('/providers')
}
</script>

<template>
  <div class="page">
    <PageHead title="智谱 GLM Coding" @back="backToProviders" />
    <main class="body zhipu-login">
      <p v-if="message" class="notice ok">{{ message }}</p>
      <p v-if="error" class="notice err">{{ error }}</p>

      <div class="zhipu-hero">
        <CoomiIcon name="sparkle" :size="28" />
        <h2>智谱 GLM Coding</h2>
        <p>接入智谱账号或 API Key，在 Coomi 中使用 GLM Coding 系列模型。</p>
      </div>

      <div class="tabs" role="tablist">
        <button :class="{ on: mode === 'oauth' }" @click="mode = 'oauth'">账号登录</button>
        <button :class="{ on: mode === 'apikey' }" @click="mode = 'apikey'">API Key</button>
      </div>

        <section v-if="mode === 'oauth'" class="card">
          <p class="note">
            使用智谱账号登录以调用 GLM Coding 额度。登录后自动配置 Anthropic 协议的 Provider。
          </p>
          <button class="btn primary" :disabled="busy || saving" @click="startOAuth">
            <CoomiIcon name="key" :size="16" />
            <span>{{ busy ? '正在跳转智谱登录…' : '用智谱账号登录' }}</span>
          </button>
          <p class="hint">点击后将跳转到智谱页面完成登录并授权，授权后会自动回到本页并完成配置。</p>
        </section>

          <section v-if="mode === 'oauth'" class="card captcha-card">
            <p class="note">智谱 Coding Plan 需要完成阿里云验证码后即可解锁调用。点击下方按钮完成验证。</p>
            <button class="btn primary" :disabled="captchaBusy" @click="verifyCaptchaAndSave">
              <span>{{ captchaBusy ? '验证中…' : '完成验证码校验' }}</span>
            </button>
            <p v-if="captchaMsg" class="hint captcha-msg">{{ captchaMsg }}</p>
          </section>

      <section v-else class="card">
        <p class="note">在 <a href="https://open.bigmodel.cn" target="_blank" rel="noopener">open.bigmodel.cn</a> 申请 API Key。</p>
        <input v-model="apiKey" class="key-input" type="password" placeholder="粘贴智谱 API Key" autocapitalize="off" autocomplete="off" />
        <button class="btn primary" :disabled="saving" @click="saveApiKey">
          <span>{{ saving ? '保存中…' : '保存并启用' }}</span>
        </button>
      </section>
    </main>
  </div>
</template>

<style scoped>
.zhipu-login { padding: 16px; }
.zhipu-hero { text-align: center; padding: 24px 0 8px; }
.zhipu-hero h2 { margin: 10px 0 4px; font-size: 18px; }
.zhipu-hero p { color: var(--text-3); font-size: 12.5px; margin: 0; }
.tabs { display: flex; gap: 8px; margin: 16px 0; }
.tabs button { flex: 1; padding: 9px 0; border-radius: var(--r-md); border: 1px solid var(--border); background: var(--bg-card); color: var(--text-2); font-weight: 600; }
.tabs button.on { background: var(--blue); color: #fff; border-color: var(--blue); }
.card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--r-card); padding: 16px; }
.card .note { color: var(--text-2); font-size: 12.5px; line-height: 1.6; margin: 0 0 14px; }
.btn { display: inline-flex; align-items: center; gap: 8px; padding: 11px 18px; border-radius: var(--r-md); border: none; font-weight: 650; }
.btn.primary { background: var(--blue); color: #fff; width: 100%; justify-content: center; }
.btn:disabled { opacity: 0.5; }
.key-input { width: 100%; box-sizing: border-box; padding: 11px 12px; border-radius: var(--r-md); border: 1px solid var(--border); background: var(--fill); color: var(--text); margin-bottom: 14px; }

.hint { color: var(--text-3); font-size: 12px; margin: 12px 0 0; }
.captcha-card { margin-top: 12px; }
.captcha-msg { color: var(--ok); }
a { color: var(--blue); }
</style>
