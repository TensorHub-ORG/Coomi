<script setup lang="ts">
/**
 * 数字生命体 · 心情日记（三级页）。
 * 由 LifeView「心情日记 > 查看更多」进入：全部主动问候日记 + 触发类型筛选。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet, apiSend } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'
import PageHead from '@/components/PageHead.vue'

interface JournalReply {
  at_ms: number
  text: string
}

interface JournalEntry {
  at_ms: number
  text: string
  trigger: string
  life_name: string
  emotion: string
  emotion_zh?: string
  bond: number
  needs: Record<string, number>
  id?: number | string
  replies?: JournalReply[]
}

const PAGE = 50
const FILTERS = [
  { value: '', label: '全部' },
  { value: 'everyday', label: '日常问候' },
  { value: 'morning', label: '早安播报' },
  { value: 'egg', label: '每日彩蛋' },
  { value: 'lonely', label: '想你了' },
  { value: 'growth_checkin', label: '成长' },
  { value: 'support', label: '关心' },
  { value: 'milestone_stage', label: '羁绊升阶' },
  { value: 'milestone_days', label: '相伴纪念' },
  { value: 'dream', label: '梦境' },
  { value: 'nostalgia', label: '怀旧' },
  { value: 'agenda_due', label: '记挂追问' },
]

const router = useRouter()
const entries = ref<JournalEntry[]>([])
const loading = ref(false)
const more = ref(true)
const error = ref('')
const filter = ref('')
/** 回信草稿：条目 id → 输入内容。 */
const drafts = ref<Record<string, string>>({})
/** 正在发送回信的条目 id（空串表示无进行中的发送）。 */
const sending = ref('')

const filtered = computed(() =>
  filter.value ? entries.value.filter(entry => entry.trigger === filter.value) : entries.value,
)

/** 回信按时间升序展示（后端顺序不保证时兜底排序）。 */
function sortedReplies(entry: JournalEntry): JournalReply[] {
  return [...(entry.replies ?? [])].sort((a, b) => a.at_ms - b.at_ms)
}

/** 发送回信：POST /api/life/journal/reply，成功后重新拉取日记列表。 */
async function sendReply(entry: JournalEntry) {
  const key = String(entry.id)
  const text = drafts.value[key]?.trim()
  if (entry.id == null || !text || sending.value) return
  sending.value = key
  error.value = ''
  try {
    await apiSend<{ ok: boolean }>('/api/life/journal/reply', 'POST', { id: entry.id, text })
    drafts.value[key] = ''
    await load(true)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    sending.value = ''
  }
}

async function load(reset: boolean) {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const offset = reset ? 0 : entries.value.length
    const data = await apiGet<{ entries: JournalEntry[] }>(`/api/life/journal?limit=${PAGE}&offset=${offset}`)
    const items = data?.entries ?? []
    entries.value = reset ? items : [...entries.value, ...items]
    more.value = items.length >= PAGE
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

function formatTime(atMs: number): string {
  const d = new Date(atMs)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(() => { void load(true) })
</script>

<template>
  <div class="page">
    <PageHead title="心情日记" @back="goBack(router, '/life')" />
    <main class="body">
      <div v-if="error" class="notice error">{{ error }}</div>
      <div class="chips">
        <button
          v-for="item in FILTERS"
          :key="item.value"
          class="chip"
          :class="{ on: filter === item.value }"
          @click="filter = item.value"
        >{{ item.label }}</button>
      </div>

      <p v-if="filtered.length === 0 && !loading" class="empty">
        {{ filter ? '该类型下暂无记录。' : '暂无主动问候记录。开启「主动问候」后，它每次主动找你都会在这里留下一笔。' }}
      </p>
      <div v-for="(entry, index) in filtered" :key="index" class="journal">
        <p class="head">
          <span>{{ formatTime(entry.at_ms) }}<em v-if="entry.emotion_zh" class="mood">当时{{ entry.emotion_zh }}</em></span>
          <b>{{ FILTERS.find(item => item.value === entry.trigger)?.label ?? entry.trigger }}</b>
        </p>
        <p class="text">{{ entry.text }}</p>
        <div v-if="sortedReplies(entry).length" class="replies">
          <p v-for="(reply, rIndex) in sortedReplies(entry)" :key="rIndex" class="reply">
            <span>你的回信：</span>{{ reply.text }}
          </p>
        </div>
        <div class="reply-bar">
          <input
            v-model="drafts[String(entry.id)]"
            :placeholder="entry.id == null ? '该条暂不支持回信' : '写一句回信…'"
            :disabled="entry.id == null || sending === String(entry.id)"
            maxlength="200"
            @keyup.enter="sendReply(entry)"
          />
          <button
            :disabled="entry.id == null || sending === String(entry.id) || !(drafts[String(entry.id)] ?? '').trim()"
            @click="sendReply(entry)"
          >{{ sending === String(entry.id) ? '发送中' : '发送' }}</button>
        </div>
      </div>

      <button v-if="more" class="more" :disabled="loading" @click="load(false)">
        {{ loading ? '加载中…' : '加载更多' }}
      </button>
      <p v-else-if="entries.length" class="end">—— 日记已全部加载 ——</p>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); }
.notice { margin-bottom: 10px; padding: 9px 11px; border-radius: 6px; background: color-mix(in srgb, var(--danger) 10%, var(--bg)); color: var(--danger); font-size: 12.5px; }
.chips { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 12px; }
.chip { min-height: 30px; padding: 0 12px; border-radius: var(--r-pill); background: var(--fill); color: var(--text-2); font-size: 12.5px; }
.chip.on { background: var(--blue); color: #fff; }
.empty { margin: 14px 2px; color: var(--text-3); font-size: 12.5px; line-height: 1.6; }
.journal { margin-bottom: 9px; padding: 11px 13px; border-radius: 10px; background: var(--bg); box-shadow: var(--shadow-1); }
.head { display: flex; align-items: center; justify-content: space-between; margin: 0 0 5px; color: var(--text-3); font-size: 11.5px; }
.head b { color: var(--accent); font-size: 11.5px; font-weight: 650; }
.head .mood { margin-left: 6px; color: var(--text-3); font-style: normal; opacity: .85; }
.text { margin: 0; color: var(--text-2); font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.replies { margin: 8px 0 0; padding: 7px 9px; border-radius: 8px; background: var(--fill); }
.reply { margin: 0; padding: 2px 0; color: var(--text-2); font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.reply span { color: var(--accent); font-weight: 600; }
.reply + .reply { border-top: 1px dashed var(--border); }
.reply-bar { display: flex; gap: 7px; margin-top: 8px; }
.reply-bar input { box-sizing: border-box; flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--page); color: var(--text); font: inherit; font-size: 12.5px; }
.reply-bar button { flex: none; min-width: 54px; height: 32px; padding: 0 10px; border-radius: 8px; background: var(--blue); color: #fff; font-size: 12.5px; font-weight: 600; }
.reply-bar button:disabled { opacity: .45; }
.more { width: 100%; min-height: 42px; margin-top: 4px; border-radius: 10px; background: var(--fill); color: var(--text-2); font-size: 13px; }
.more:disabled { opacity: .5; }
.end { margin: 12px 0 2px; text-align: center; color: var(--text-3); font-size: 11.5px; }
</style>
