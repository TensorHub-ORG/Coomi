<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { goBack } from '@/bridge/navigation'

const router = useRouter()
const url = ref('https://www.google.com')
const frameSrc = ref('')
const loading = ref(false)
const progress = ref(0)

function normalize(input: string): string {
  const t = input.trim()
  if (!t) return ''
  if (!/^https?:\/\//i.test(t)) return 'https://' + t
  return t
}

function navigate() {
  const target = normalize(url.value)
  if (!target) return
  url.value = target
  frameSrc.value = target
}

function back() { router.back() }
function reload() { if (frameSrc.value) frameSrc.value = frameSrc.value }

onBeforeUnmount(() => { /* iframe 自动卸载 */ })
</script>

<template>
  <div class="page">
    <PageHead title="内置浏览器" @back="goBack(router, 'dashboard')">
      <template #right>
        <button class="icon-btn" aria-label="刷新" @click="reload"><CoomiIcon name="refresh" :size="17" /></button>
      </template>
    </PageHead>

    <div class="bar">
      <CoomiIcon name="globe" :size="16" class="bar-icon" />
      <input
        v-model="url"
        class="url"
        type="url"
        spellcheck="false"
        placeholder="输入网址，如 https://example.com"
        @keyup.enter="navigate"
      />
      <button class="go" aria-label="打开" @click="navigate"><CoomiIcon name="arrowRight" :size="16" /></button>
    </div>

    <div v-if="loading" class="load"><i class="spin" />{{ progress }}%</div>
    <div class="frame-wrap">
      <iframe
        v-if="frameSrc"
        :src="frameSrc"
        class="frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        referrerpolicy="no-referrer"
        @load="loading = false; progress = 100"
      />
      <div v-else class="empty">
        <CoomiIcon name="globe" :size="40" class="empty-icon" />
        <p>输入网址开始浏览。部分站点会拒绝被 iframe 嵌入，可改用对话中的 fetch 或 shell curl 读取。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.icon-btn { display: grid; place-items: center; width: 38px; height: 38px; border: 0; background: none; color: var(--text-2); }
.bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: var(--bg); border-bottom: 1px solid var(--border); }
.bar-icon { color: var(--text-3); flex-shrink: 0; }
.url { flex: 1; min-width: 0; height: 38px; padding: 0 12px; border: 1px solid var(--border); border-radius: 19px; background: var(--fill); color: var(--text); font-size: 13px; outline: none; }
.url:focus { border-color: var(--blue-border); box-shadow: 0 0 0 3px var(--blue-soft); }
.go { display: grid; place-items: center; width: 38px; height: 38px; border: 0; border-radius: 50%; background: var(--blue); color: #fff; flex-shrink: 0; }
.load { display: flex; align-items: center; gap: 7px; padding: 4px 12px; font-size: 11px; color: var(--text-3); }
.spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--border-strong); border-top-color: var(--blue); animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.frame-wrap { flex: 1; min-height: 0; background: #fff; }
.frame { width: 100%; height: 100%; border: 0; }
.empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; text-align: center; color: var(--text-3); font-size: 13px; line-height: 1.7; }
.empty-icon { color: var(--border-strong); }
</style>
