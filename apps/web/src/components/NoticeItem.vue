<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NoticeItem } from '@/stores/viewModel'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ notice: NoticeItem }>()

const config = useConfigStore()
const session = useSessionStore()
const open = ref(false)
const confirm = ref(false)
const sending = ref(false)
const sent = ref<'ok' | 'fail' | null>(null)
const failReason = ref('')

const icon = computed(() => {
  switch (props.notice.tone) {
    case 'error': return 'alert'
    case 'warn': return 'alert'
    case 'success': return 'check'
    default: return ''
  }
})

function toggle() { if (props.notice.detail) open.value = !open.value }

/** 原生桥上传回调注册表（callbackId -> resolve）。 */
type FeedbackCb = (result: { ok: boolean; error?: string; detail?: string }) => void
type FeedbackWindow = Window & typeof globalThis & {
  __coomiFeedbackCallbacks?: Map<string, FeedbackCb>
  __coomiFeedbackResult?: (id: string, resultJson: string) => void
}
const feedbackWindow = window as FeedbackWindow
const feedbackCbs = feedbackWindow.__coomiFeedbackCallbacks ??= new Map<string, FeedbackCb>()

/**
 * 上报报错：仅上传报错日志 + 设备诊断，不含任何对话内容。
 * 优先走原生桥（绕过 WebView CORS，最可靠）；无桥时降级为 fetch。
 */
function sendViaBridge(payload: object): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const native = window.CoomiAndroid
  if (!native?.sendFeedback) return Promise.resolve({ ok: false, error: 'no bridge' })
  return new Promise((resolve) => {
    const id = `fb_${Date.now()}_${crypto.randomUUID()}`
    feedbackCbs.set(id, resolve)
    // 超时兜底：8s 无回调按失败处理。
    setTimeout(() => {
      if (feedbackCbs.delete(id)) resolve({ ok: false, error: 'timeout' })
    }, 10000)
    try {
      ;(native.sendFeedback as (json: string, id: string) => void)(JSON.stringify(payload), id)
    } catch (e) {
      feedbackCbs.delete(id)
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }  })
}
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

/**
 * 上报报错：仅上传报错日志 + 设备诊断，不含任何对话内容。
 * 双通道：自建端点（国内可达）优先，随后尝试 GitHub issue（失败静默）。
 */
async function sendFeedback(automatic = false): Promise<{ ok: boolean; reason: string }> {
  if (sending.value) return { ok: false, reason: 'busy' }
  sending.value = true
  sent.value = null
  failReason.value = ''
  const now = new Date().toISOString()
  let diagnostics = '{}'
  try {
    const raw = window.CoomiAndroid?.getDiagnostics?.()
    if (raw) diagnostics = raw
  } catch { /* 原生桥不可用时忽略 */ }
  const payload = {
    feedback_type: props.notice.analysisStatus ? 'tool_failure_analysis' : 'runtime_error',
    analysis_status: props.notice.analysisStatus ?? 'not_applicable',
    message: props.notice.text,
    detail: props.notice.detail ?? '',
    diagnostics,
    provider: config.currentProviderId,
    model: config.currentModel,
    permission_mode: config.permissionMode,
    time: now,
  }
  // 主通道：优先原生桥（绕过 WebView CORS），无桥时降级为 fetch。
  const viaBridge = !!window.CoomiAndroid?.sendFeedback
  let ok = false
  let reason = ''
  if (viaBridge) {
    const result = await sendViaBridge(payload)
    ok = result.ok
    reason = result.error ?? ''
  } else {
    try {
      const res = await fetch('https://updates.septemc.com/coomi/feedback/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      ok = res.ok
      if (!ok) reason = `HTTP ${res.status}`
    } catch (e) {
      ok = false
      reason = e instanceof Error ? e.message : String(e)
    }
  }
  // 仅使用自建服务器通道（用户决定不用 GitHub issue）。
  sending.value = false
  sent.value = ok ? 'ok' : 'fail'
  failReason.value = reason
  // 已发送提示停留片刻后自动收起
  if (ok && !automatic) setTimeout(() => { sent.value = null; confirm.value = false }, 2600)
  return { ok, reason }
}

async function consentAndSend() {
  if (sending.value || props.notice.analysisStatus === 'analyzing') return
  const analyzed = await session.consentToolFailureFeedback(props.notice.id)
  if (!analyzed) return
  const result = await sendFeedback(true)
  session.finishToolFailureFeedback(props.notice.id, result.ok, result.reason)
}

async function retryUpload() {
  if (sending.value || props.notice.analysisStatus !== 'ready') return
  const result = await sendFeedback(true)
  session.finishToolFailureFeedback(props.notice.id, result.ok, result.reason)
}
</script>

<template>
  <div class="notice cascade" :class="[notice.tone, { analysis: notice.analysisStatus }]" @click="toggle">
    <CoomiIcon v-if="icon" :name="icon" :size="14" />
    <span>{{ notice.text }}</span>
    <CoomiIcon v-if="notice.detail" name="chevronRight" :size="14" class="chev" :class="{ open }" />
  </div>
  <div v-if="notice.detail && open" class="notice-detail cascade">
    <pre>{{ notice.detail }}</pre>
  </div>

  <div v-if="notice.analysisStatus === 'consent'" class="feedback-consent">
    <span>点击同意后才会执行。本次仅发送脱敏工具轨迹，并额外轻量调用一次当前模型 API 进行精炼整理；不包含用户对话、文件内容、真实路径、原始参数或密钥。</span>
    <button class="fb-btn consent-btn" @click.stop="consentAndSend">
      <CoomiIcon name="send" :size="13" />
      同意反馈
    </button>
  </div>
  <div v-else-if="notice.analysisStatus === 'analyzing'" class="analysis-hint">
    后台整理与上传不会写入会话历史，您可以继续对话。
  </div>
  <div v-else-if="notice.analysisStatus === 'ready'" class="analysis-hint failed">
    <button v-if="notice.feedbackEligible" class="fb-btn" :disabled="sending" @click.stop="retryUpload">
      {{ sending ? '上传中...' : '重新上传' }}
    </button>
  </div>
  <div v-else-if="notice.analysisStatus === 'failed'" class="analysis-hint failed">
    <button class="fb-btn" @click.stop="consentAndSend">重新反馈</button>
  </div>

  <div v-if="notice.tone === 'error' && !notice.analysisStatus" class="fb">
    <template v-if="!confirm">
      <button class="fb-btn" @click.stop="confirm = true">
        <CoomiIcon name="send" :size="13" />
        <span>反馈报错</span>
      </button>
    </template>
    <template v-else-if="sent === null">
      <div class="fb-confirm">
        <span>本次反馈仅上传报错日志与设备信息，<b>不含任何对话内容</b>。确认上报？</span>
        <div class="fb-actions">
          <button class="fb-btn ghost" @click.stop="confirm = false; sent = null">取消</button>
          <button class="fb-btn" :disabled="sending" @click.stop="sendFeedback()">
            {{ sending ? '上传中…' : '确认上传' }}
          </button>
        </div>
      </div>
    </template>
    <template v-else>
      <span class="fb-result" :class="sent">{{ sent === 'ok' ? '已收到，感谢反馈' : '上传失败，可稍后重试' }}</span>
      <span v-if="sent === 'fail' && failReason" class="fb-reason">{{ failReason }}</span>
    </template>
  </div>
</template>

<style scoped>
.notice {
  align-self: center; display: inline-flex; align-items: center; gap: 6px;
  min-width: 0; max-width: 92%; padding: 6px 14px;
  border-radius: var(--r-pill); background: var(--fill);
  font-size: 12.5px; line-height: 1.5; color: var(--text-3);
}
.notice span { min-width: 0; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
.notice.warn { background: var(--orange-soft); color: var(--orange); }
.notice.analysis { background: var(--orange-soft); color: var(--orange); }
.notice.success { background: var(--ok-soft); color: var(--ok); }
/* 报错：红字、无背景底框、无圆角——只保留文字颜色区分。 */
.notice.error {
  align-self: stretch; width: 100%; max-width: 100%; align-items: flex-start;
  padding: 4px 2px;
  background: transparent; color: var(--danger);
  text-align: left; word-break: break-word;
}
.notice.error :deep(svg) { flex-shrink: 0; margin-top: 1px; color: var(--danger); }
.chev { flex-shrink: 0; transition: transform .18s; }
.chev.open { transform: rotate(90deg); }
.analysis-hint {
  align-self: center; width: 100%; max-width: 92%; margin-top: -4px;
  color: var(--text-3); font-size: 11.8px; line-height: 1.5;
}
.analysis-hint.failed { color: var(--orange); }
.feedback-consent {
  align-self: center; width: 100%; max-width: 92%; margin-top: -2px;
  padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--bg); color: var(--text-2); font-size: 12px; line-height: 1.55;
}
.consent-btn { margin-top: 8px; color: var(--orange); border-color: var(--orange); }

.notice-detail {
  align-self: center; width: 100%; max-width: 92%;
  margin-top: -4px; padding: 9px 13px;
  border-radius: var(--r-md); background: var(--code-bg);
}
.notice-detail pre {
  margin: 0; font-family: var(--font-mono); font-size: 11.8px; line-height: 1.6;
  color: var(--code-text); white-space: pre-wrap; word-break: break-word;
  max-height: 260px; overflow-y: auto;
}

/* 报错反馈按钮（仅 error 通知显示） */
.fb {
  align-self: center; width: 100%; max-width: 92%;
  display: flex; flex-direction: column; gap: 8px;
  margin-top: -2px;
}
.fb-btn {
  display: inline-flex; align-items: center; gap: 5px;
  align-self: flex-start; height: 30px; padding: 0 12px;
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--bg); color: var(--text-2);
  font-size: 12.5px; font-weight: 600;
}
.fb-btn:active { background: var(--fill); }
.fb-btn:disabled { opacity: .6; }
.fb-btn.ghost { color: var(--text-3); }
.fb-confirm {
  padding: 10px 12px; border: 1px solid var(--border);
  border-radius: var(--r-md); background: var(--bg);
  font-size: 12.5px; line-height: 1.55; color: var(--text-2); text-align: left;
}
.fb-confirm b { color: var(--danger); }
.fb-actions { display: flex; gap: 8px; margin-top: 8px; }
.fb-result { font-size: 12.5px; font-weight: 600; }
.fb-result.ok { color: var(--ok); }
.fb-result.fail { color: var(--danger); }
.fb-reason { font-size: 11.5px; color: var(--text-3); word-break: break-all; }
</style>
