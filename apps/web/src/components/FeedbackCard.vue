<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NoticeItem } from '@/stores/viewModel'
import { useSessionStore } from '@/stores/session'
import CoomiIcon from './CoomiIcon.vue'

/**
 * 统一反馈卡片（瀑布流末尾）：一行摘要 + [一键反馈] 主按钮 + 可展开
 * 的「将发送内容」预览与溯源分析结果。取代旧 NoticeItem 里三种混杂形态。
 */
const props = defineProps<{ notice: NoticeItem }>()
const session = useSessionStore()
const open = ref(false)
const sending = ref(false)

const feedback = computed(() => props.notice.feedback)
const status = computed(() => props.notice.analysisStatus ?? 'consent')

const previewLines = computed(() => {
  const lines: string[] = []
  const trace = feedback.value?.toolTrace ?? []
  if (trace.length > 0) lines.push(`· 工具调用轨迹 ${trace.length} 条（参数保留原文，密钥打码）`)
  if (feedback.value?.hasConversation) lines.push('· 最近几轮对话摘要（可在「问题反馈与诊断」页关闭）')
  lines.push('· 报错信息、设备与环境诊断、引擎日志尾部')
  return lines
})

const canConsent = computed(() => status.value === 'consent' || status.value === 'failed')
const canRetryUpload = computed(() => status.value === 'ready' && props.notice.feedbackEligible)

/** 一键反馈：先溯源分析（如需要），完成后自动上传；上传结果回写卡片状态。 */
async function consentAndSend() {
  if (sending.value) return
  sending.value = true
  try {
    const prepared = await session.prepareTurnFeedback(props.notice.id)
    if (prepared) {
      const result = await session.sendTurnFeedback(props.notice.id)
      session.finishTurnFeedback(props.notice.id, result.ok, result.reason, result.queued)
    }
  } finally {
    sending.value = false
  }
}

/** 仅重试上传（分析已完成，不再调用模型）。 */
async function retryUpload() {
  if (sending.value) return
  sending.value = true
  try {
    const result = await session.sendTurnFeedback(props.notice.id)
    session.finishTurnFeedback(props.notice.id, result.ok, result.reason, result.queued)
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div v-if="feedback" class="feedback-card cascade">
    <div class="fb-head" @click="open = !open">
      <CoomiIcon name="alert" :size="14" class="fb-icon" />
      <span class="fb-summary">{{ notice.text }}</span>
      <CoomiIcon name="chevronRight" :size="13" class="chev" :class="{ open }" />
    </div>

    <div v-if="open" class="fb-body">
      <pre v-if="notice.detail" class="fb-detail">{{ notice.detail }}</pre>
      <div v-if="status === 'consent'" class="fb-preview">
        <span class="fb-preview-title">点击「一键反馈」将自动采集并上传：</span>
        <span v-for="line in previewLines" :key="line" class="fb-preview-line">{{ line }}</span>
        <span class="fb-preview-note">密码、API Key、邮箱、手机号自动打码；不包含 API Key。</span>
      </div>
      <pre v-if="notice.analysisText" class="fb-analysis">{{ notice.analysisText }}</pre>
    </div>

    <div class="fb-actions">
      <template v-if="canConsent">
        <button class="fb-btn primary" :disabled="sending" @click.stop="consentAndSend">
          <CoomiIcon name="send" :size="13" />
          {{ sending ? '处理中…' : '一键反馈' }}
        </button>
        <span v-if="status === 'failed'" class="fb-hint">整理未完成，未上传任何内容，点击重试</span>
      </template>
      <template v-else-if="status === 'analyzing'">
        <span class="fb-hint">Agent 正在后台溯源整理，完成后自动上传，您可以继续对话。</span>
      </template>
      <template v-else-if="canRetryUpload">
        <button class="fb-btn" :disabled="sending" @click.stop="retryUpload">
          {{ sending ? '上传中…' : '重试上传' }}
        </button>
        <span class="fb-hint">{{ notice.statusNote || '整理已完成，无需再次分析' }}</span>
      </template>
      <template v-else-if="status === 'uploading'">
        <span class="fb-hint">正在上传反馈…</span>
      </template>
      <template v-else-if="status === 'complete'">
        <span class="fb-hint ok">✓ {{ notice.statusNote || '反馈已上传，感谢您的反馈' }}</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.feedback-card {
  /* 父容器是普通块级布局：margin auto 水平居中。 */
  margin-inline: auto;
  align-self: center;
  width: 100%;
  max-width: 92%;
  padding: 10px 13px;
  border: 1px solid var(--orange-border, var(--border));
  border-radius: var(--r-md);
  background: var(--bg);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fb-head {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  cursor: pointer;
}
.fb-icon { flex-shrink: 0; margin-top: 2px; color: var(--orange); }
.fb-summary {
  flex: 1; min-width: 0;
  color: var(--text-2); font-size: 12.5px; line-height: 1.5;
  overflow-wrap: anywhere; word-break: break-word;
}
.chev { flex-shrink: 0; margin-top: 2px; color: var(--text-3); transition: transform .18s; }
.chev.open { transform: rotate(90deg); }

.fb-body { display: flex; flex-direction: column; gap: 8px; }
.fb-detail, .fb-analysis {
  margin: 0; padding: 9px 11px;
  border-radius: var(--r-sm, 8px); background: var(--code-bg);
  font-family: var(--font-mono); font-size: 11.8px; line-height: 1.6;
  color: var(--code-text);
  white-space: pre-wrap; word-break: break-word;
  max-height: 220px; overflow-y: auto;
}
.fb-preview { display: flex; flex-direction: column; gap: 3px; }
.fb-preview-title { color: var(--text-2); font-size: 12px; font-weight: 600; }
.fb-preview-line { color: var(--text-3); font-size: 11.8px; line-height: 1.5; }
.fb-preview-note { color: var(--text-3); font-size: 11.3px; line-height: 1.5; opacity: .8; margin-top: 2px; }

.fb-actions { display: flex; align-items: center; gap: 9px; }
.fb-btn {
  display: inline-flex; align-items: center; gap: 5px;
  height: 30px; padding: 0 14px;
  border: 1px solid var(--orange-border, var(--border)); border-radius: var(--r-pill);
  background: var(--bg); color: var(--orange);
  font-size: 12.5px; font-weight: 600;
}
.fb-btn.primary { background: var(--orange-soft); }
.fb-btn:active { opacity: .8; }
.fb-btn:disabled { opacity: .6; }
.fb-hint { color: var(--text-3); font-size: 11.8px; line-height: 1.5; min-width: 0; overflow-wrap: anywhere; }
.fb-hint.ok { color: var(--ok); font-weight: 600; }
</style>
