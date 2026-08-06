<script setup lang="ts">
/**
 * 身份定位：定制身份定位提示词。
 * 保存后置于每次对话系统提示词的最前（占位段），
 * 让 AI 首先认知自己的身份与定位。清空后保存 = 移除。
 */
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useConfigStore } from '@/stores/config'
import PageHead from '@/components/PageHead.vue'

const router = useRouter()
const config = useConfigStore()

/** 与后端 CUSTOM_PROMPT_MAX_CHARS 保持一致。 */
const MAX_CHARS = 2000

const text = ref('')
const loading = ref(true)
const saving = ref(false)
const savedNote = ref('')
const error = ref('')

onMounted(async () => {
  await config.fetchCustomPrompt()
  text.value = config.customPrompt
  loading.value = false
})

async function save() {
  if (loading.value || saving.value) return
  saving.value = true
  error.value = ''
  savedNote.value = ''
  const ok = await config.saveCustomPrompt(text.value)
  saving.value = false
  if (ok) {
    savedNote.value = text.value.trim()
      ? '已保存，将在下一次对话中生效。'
      : '已清除定制提示词。'
  } else {
    error.value = '保存失败，请确认引擎连接正常'
  }
}
</script>

<template>
  <div class="page">
    <PageHead title="身份定位" @back="router.push('/settings')" />
    <main class="body">
      <div class="card">
        <p class="desc">
          放一段专属提示词，让 AI 认知自己的身份与定位。保存后它会被置于每次对话
          系统提示词的最前，AI 会首先读到这个身份。
        </p>
        <label class="fld">
          <span class="flabel">定制身份定位</span>
          <textarea
            v-model="text"
            class="finput area"
            rows="8"
            :maxlength="MAX_CHARS"
            placeholder="例如：你是「小酷」，一个温暖、耐心、懂生活的 AI 助手，说话简洁，喜欢用比喻……"
            spellcheck="false"
          />
          <span class="count">{{ text.length }}/{{ MAX_CHARS }}</span>
        </label>
        <button class="btn btn-primary" :disabled="loading || saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <p v-if="savedNote" class="note ok-note">{{ savedNote }}</p>
        <p v-if="error" class="err">{{ error }}</p>
        <p class="note">清空内容后保存即可移除身份定位。保存后下一次发送消息即生效（每轮对话都会读取最新配置）。</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); }
.card {
  padding: 15px 14px 16px; border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-1);
}
.desc { padding: 0 4px 12px; font-size: 13px; line-height: 1.65; color: var(--text-2); }
.fld { display: flex; flex-direction: column; gap: 6px; }
.flabel { padding-left: 4px; font-size: 12.5px; color: var(--text-2); }
.finput {
  min-height: 46px; padding: 0 14px;
  border: 1.5px solid var(--border); border-radius: var(--r-md);
  background: var(--bg); font-size: 14.5px; color: var(--text);
  transition: border-color .14s;
}
.finput::placeholder { color: var(--text-3); }
.finput:focus { outline: none; border-color: var(--blue-border); }
.finput.area {
  min-height: 200px; padding: 12px 14px; resize: vertical;
  font-size: 14px; line-height: 1.65;
}
.count { align-self: flex-end; padding-right: 4px; font-size: 11.5px; color: var(--text-3); }
.card .btn { margin-top: 14px; width: 100%; }
.note { margin-top: 12px; padding: 0 4px; font-size: 12px; line-height: 1.7; color: var(--text-3); }
.ok-note { color: var(--ok); }
.err { margin-top: 10px; font-size: 12.5px; line-height: 1.6; color: var(--danger); }
</style>
