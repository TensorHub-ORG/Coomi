<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { useConfigStore } from '@/stores/config'
import { apiSend, apiGet } from '@/bridge/http'

const router = useRouter()
const config = useConfigStore()
const mode = ref<'password' | 'sms'>('password')
const account = ref('')
const password = ref('')
const mobile = ref('')
const areaCode = ref('+86')
const code = ref('')
const logging = ref(false)
const sendingCode = ref(false)
const countdown = ref(0)
const message = ref('')
const error = ref('')
const loggedUser = ref<{ id: string; username: string; email?: string; mobile?: string } | null>(null)
const isLogged = ref(false)
const selectedModel = ref<'deepseek-chat' | 'deepseek-reasoner'>('deepseek-chat')
let countdownTimer: ReturnType<typeof setInterval> | null = null
const DEEPSEEK_BASE = 'https://chat.deepseek.com'

interface LoginResp {
  user?: { id: string; username: string; email?: string; mobile?: string }
  token?: string
}

async function checkStatus() {
  try {
    const res = await apiGet<{ logged: boolean; user?: any }>('/api/deepseek/status')
    isLogged.value = res.logged
    loggedUser.value = res.user ?? null
  } catch { /* 引擎启动中时保持未登录 */ }
}

onMounted(() => { void checkStatus() })
onBeforeUnmount(() => { if (countdownTimer) clearInterval(countdownTimer) })

function startCountdown() {
  countdown.value = 60
  if (countdownTimer) clearInterval(countdownTimer)
  countdownTimer = setInterval(() => {
    countdown.value--
    if (countdown.value <= 0 && countdownTimer) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
  }, 1000)
}

async function installProvider(resp: LoginResp, fallbackName: string) {
  if (!resp.token) throw new Error('登录响应没有 token')
  isLogged.value = true
  loggedUser.value = resp.user ?? { id: '', username: fallbackName }
  // 使用专用 API 保存 Provider，避免触发通用模型发现
  const ok = await apiSend<{ provider: any; active: string; model: string }>('/api/deepseek/provider', 'POST', {
    model: selectedModel.value,
  })
  if (!ok) throw new Error('Provider 保存失败')
  message.value = '登录成功'
  password.value = ''
  code.value = ''
}

async function switchModel() {
  if (!isLogged.value) return
  const ok = await apiSend<{ model: string }>('/api/deepseek/model', 'POST', {
    model: selectedModel.value,
  })
  if (ok) message.value = `已切换到 ${selectedModel.value === 'deepseek-chat' ? 'Chat' : 'Reasoner'}`
  else error.value = '模型切换失败'
}

async function passwordLogin() {
  if (!account.value.trim() || !password.value) { error.value = '请输入邮箱/手机号和密码'; return }
  logging.value = true; error.value = ''; message.value = ''
  try {
    const resp = await apiSend<LoginResp>('/api/deepseek/login', 'POST', {
      account: account.value.trim(), password: password.value,
    })
    await installProvider(resp, account.value.trim())
  } catch (e) { error.value = '登录失败：' + String(e) }
  finally { logging.value = false }
}

async function sendCode() {
  const number = mobile.value.replace(/\D/g, '')
  if (!number) { error.value = '请输入手机号'; return }
  sendingCode.value = true; error.value = ''; message.value = ''
  try {
    await apiSend('/api/deepseek/sms/send', 'POST', { mobile: number, areaCode: areaCode.value })
    message.value = '验证码已发送'
    startCountdown()
  } catch (e) { error.value = '发送失败：' + String(e) }
  finally { sendingCode.value = false }
}

async function smsLogin() {
  const number = mobile.value.replace(/\D/g, '')
  if (!number || !code.value.trim()) { error.value = '请输入手机号和验证码'; return }
  logging.value = true; error.value = ''; message.value = ''
  try {
    const resp = await apiSend<LoginResp>('/api/deepseek/sms/login', 'POST', {
      mobile: number, areaCode: areaCode.value, code: code.value.trim(),
    })
    await installProvider(resp, `${areaCode.value}${number}`)
  } catch (e) { error.value = '登录失败：' + String(e) }
  finally { logging.value = false }
}

async function logout() {
  try { await apiSend('/api/deepseek/logout', 'POST') } catch { /* ignore */ }
  isLogged.value = false; loggedUser.value = null; message.value = '已退出登录'
}
function switchMode(next: 'password' | 'sms') { mode.value = next; error.value = ''; message.value = '' }
function backToProviders() { router.push('/providers') }
</script>

<template>
  <div class="page">
    <PageHead title="DeepSeek 账号" @back="backToProviders" />
    <main class="body ds-login">
      <p v-if="message" class="notice ok">{{ message }}</p>
      <p v-if="error" class="notice err">{{ error }}</p>
      <div class="ds-hero">
        <CoomiIcon name="sparkle" :size="28" />
        <h2>DeepSeek 登录</h2>
        <p>登录账号后，可在 Coomi 中使用 DeepSeek 对话模型。</p>
      </div>

      <!-- 模型选择器：始终可见 -->
      <section class="card model-selector">
        <span class="ms-label">默认模型</span>
        <div class="ms-tabs">
          <button :class="{ on: selectedModel === 'deepseek-chat' }" @click="selectedModel = 'deepseek-chat'; switchModel()">Chat 对话</button>
          <button :class="{ on: selectedModel === 'deepseek-reasoner' }" @click="selectedModel = 'deepseek-reasoner'; switchModel()">Reasoner 思考</button>
        </div>
      </section>

      <section v-if="isLogged" class="card">
        <div class="user-row">
          <span class="avatar"><CoomiIcon name="user" :size="18" /></span>
          <div class="user-info"><b>{{ loggedUser?.username || loggedUser?.email || loggedUser?.mobile || loggedUser?.id || '已登录' }}</b><small v-if="loggedUser?.email">{{ loggedUser.email }}</small><small v-else-if="loggedUser?.mobile">{{ loggedUser.mobile }}</small></div>
          <span class="badge">已登录</span>
        </div>
        <button class="btn ghost" @click="logout">退出登录</button>
        <p class="hint">返回对话页，选择「DeepSeek 账号」即可使用。</p>
      </section>

      <section v-else class="card">
        <div class="login-tabs">
          <button :class="{ on: mode === 'password' }" @click="switchMode('password')">密码登录</button>
          <button :class="{ on: mode === 'sms' }" @click="switchMode('sms')">验证码登录</button>
        </div>
        <template v-if="mode === 'password'">
          <label class="field"><span>邮箱或手机号</span><input v-model="account" type="text" placeholder="邮箱或手机号" autocapitalize="off" autocomplete="username" /></label>
          <label class="field"><span>密码</span><input v-model="password" type="password" placeholder="密码" autocomplete="current-password" @keyup.enter="passwordLogin" /></label>
          <button class="btn primary" :disabled="logging" @click="passwordLogin">{{ logging ? '登录中…' : '登录 DeepSeek' }}</button>
        </template>
        <template v-else>
          <label class="field"><span>手机号</span><span class="phone-input"><input v-model="areaCode" class="area" inputmode="tel" aria-label="区号" /><input v-model="mobile" inputmode="tel" placeholder="手机号" autocomplete="tel" /></span></label>
          <label class="field"><span>短信验证码</span><span class="code-input"><input v-model="code" inputmode="numeric" maxlength="8" placeholder="验证码" @keyup.enter="smsLogin" /><button :disabled="sendingCode || countdown > 0" @click="sendCode">{{ countdown > 0 ? `${countdown}s` : sendingCode ? '发送中…' : '获取验证码' }}</button></span></label>
          <button class="btn primary" :disabled="logging" @click="smsLogin">{{ logging ? '登录中…' : '验证码登录' }}</button>
          <p class="hint">短信发送若触发 DeepSeek 安全验证，会显示对应错误信息。</p>
        </template>
      </section>
    </main>
  </div>
</template>

<style scoped>
.model-selector{display:flex;align-items:center;gap:12px;padding:12px 16px;margin-bottom:12px}
.ms-label{font-size:12px;color:var(--text-2);font-weight:600;flex-shrink:0}
.ms-tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:3px;border-radius:10px;background:var(--fill);flex:1}
.ms-tabs button{height:32px;border:0;border-radius:8px;background:transparent;color:var(--text-3);font-size:12px;font-weight:600;transition:all .15s}
.ms-tabs button.on{background:var(--bg);color:var(--blue);box-shadow:var(--shadow-1)}
.ds-login{padding:16px}.ds-hero{text-align:center;padding:24px 0 12px}.ds-hero h2{margin:10px 0 4px;font-size:18px}.ds-hero p,.hint{color:var(--text-3);font-size:12.5px}.card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--r-card);padding:16px}.login-tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:3px;margin-bottom:16px;border-radius:10px;background:var(--fill)}.login-tabs button{height:34px;border:0;border-radius:8px;background:transparent;color:var(--text-3)}.login-tabs button.on{background:var(--bg);color:var(--blue);box-shadow:var(--shadow-1);font-weight:650}.field{display:block;margin-bottom:14px}.field>span:first-child{display:block;font-size:12px;color:var(--text-2);margin-bottom:6px;font-weight:600}.field input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:var(--r-md);border:1px solid var(--border);background:var(--fill);color:var(--text)}.phone-input,.code-input{display:flex;gap:7px}.phone-input .area{flex:0 0 70px;width:70px}.code-input input{min-width:0;flex:1}.code-input button{flex:0 0 104px;border:1px solid var(--blue-border);border-radius:var(--r-md);background:var(--blue-soft);color:var(--blue);font-size:12px}.code-input button:disabled{opacity:.5}.btn{display:inline-flex;align-items:center;justify-content:center;padding:11px 18px;border-radius:var(--r-md);font-weight:650;width:100%}.btn.primary{background:var(--blue);color:#fff}.btn.ghost{background:transparent;border:1px solid var(--border);color:var(--text-2);margin-top:12px}.btn:disabled{opacity:.5}.hint{margin:12px 0 0}.user-row{display:flex;align-items:center;gap:12px}.avatar{width:40px;height:40px;border-radius:50%;background:var(--blue-soft);display:flex;align-items:center;justify-content:center;color:var(--blue)}.user-info{flex:1;min-width:0}.user-info b,.user-info small{display:block}.user-info small{color:var(--text-3);font-size:12px}.badge{background:var(--ok-soft);color:var(--ok);font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px}
</style>
