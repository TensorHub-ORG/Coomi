<script setup lang="ts">
/**
 * 数字生命体 · 记忆库（三级页）。
 * 由 LifeView「记忆 > 查看更多」进入：全量记忆列表 + 关键词检索。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet, apiSend } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

interface MemoryEntry {
  at_ms: number
  user: string
  assistant: string
}

const PAGE = 50
const router = useRouter()
const entries = ref<MemoryEntry[]>([])
const loading = ref(false)
const more = ref(true)
const error = ref('')
const query = ref('')
const searching = ref(false)
const showName = ref('数字生命体')

async function load(reset: boolean) {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const offset = reset ? 0 : entries.value.length
    const data = await apiGet<{ entries: MemoryEntry[] }>(`/api/life/memory?limit=${PAGE}&offset=${offset}`)
    const items = data?.entries ?? []
    entries.value = reset ? items : [...entries.value, ...items]
    more.value = items.length >= PAGE
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

async function search() {
  if (searching.value) return
  searching.value = true
  error.value = ''
  try {
    if (query.value.trim()) {
      const keywords = await apiSend<string[]>('/api/cognitive/memory', 'POST', {
        profile_id: 'primary', query: query.value, limit: 12,
      })
      entries.value = keywords.map(text => {
        const [user = '', ...rest] = text.split('\n')
        return { at_ms: 0, user: user.replace(/^User: /, ''), assistant: rest.join('\n').replace(/^Response: /, '') }
      })
      more.value = false
    } else {
      more.value = true
      await load(true)
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    searching.value = false
  }
}

function formatTime(atMs: number): string {
  if (!atMs) return ''
  const d = new Date(atMs)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function loadLifeName() {
  try {
    const status = await apiGet<{ profile?: { name?: string } }>('/api/cognitive/status')
    if (status?.profile?.name) showName.value = status.profile.name
  } catch { /* 使用默认名 */ }
}

onMounted(() => { void load(true); void loadLifeName() })
</script>

<template>
  <div class="page">
    <PageHead title="记忆库" @back="goBack(router, '/life')" />
    <main class="body">
      <div v-if="error" class="notice error">{{ error }}</div>
      <div class="search">
        <input v-model="query" placeholder="检索记忆关键词" @keyup.enter="search" />
        <button aria-label="检索" :disabled="searching" @click="search"><CoomiIcon name="search" :size="17" /></button>
      </div>

      <p v-if="entries.length === 0 && !loading" class="empty">暂无记忆。和它多聊一阵后，这里会记录你们的关键对话。</p>
      <div v-for="(item, index) in entries" :key="index" class="memory-block">
        <p v-if="item.at_ms" class="head"><span>{{ formatTime(item.at_ms) }}</span></p>
        <p class="memory"><span>你：</span>{{ item.user }}</p>
        <p class="memory"><span>{{ showName }}：</span>{{ item.assistant }}</p>
      </div>

      <button v-if="more" class="more" :disabled="loading" @click="load(false)">
        {{ loading ? '加载中…' : '加载更多' }}
      </button>
      <p v-else-if="entries.length" class="end">—— 记忆已全部加载 ——</p>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); }
.notice { margin-bottom: 10px; padding: 9px 11px; border-radius: 6px; background: color-mix(in srgb, var(--danger) 10%, var(--bg)); color: var(--danger); font-size: 12.5px; }
.search { display: flex; gap: 8px; margin-bottom: 12px; }
.search input { box-sizing: border-box; flex: 1; min-width: 0; height: 40px; padding: 0 11px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; font-size: 13.5px; }
.search button { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 8px; background: var(--fill-strong); color: var(--text-2); }
.empty { margin: 14px 2px; color: var(--text-3); font-size: 12.5px; line-height: 1.6; }
.memory-block { margin-bottom: 9px; padding: 11px 13px; border-radius: 10px; background: var(--bg); box-shadow: var(--shadow-1); }
.head { margin: 0 0 5px; color: var(--text-3); font-size: 11px; }
.memory { margin: 0; padding: 3px 0; color: var(--text-2); font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.memory span { color: var(--text-3); }
.more { width: 100%; min-height: 42px; margin-top: 4px; border-radius: 10px; background: var(--fill); color: var(--text-2); font-size: 13px; }
.more:disabled { opacity: .5; }
.end { margin: 12px 0 2px; text-align: center; color: var(--text-3); font-size: 11.5px; }
</style>
