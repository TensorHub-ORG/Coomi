<script setup lang="ts">
/**
 * 数据工具：贡献统计 / 用量统计 / 会话搜索 / 会话导出。
 * 数据来自 /api/git/contributions、/api/usage/by-day、/api/sessions/search、
 * /api/sessions/{id}/export（见 src/bridge/data.ts）。
 * by_day 迷你柱状图用纯 CSS 条形实现，不引图表库。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { goBack } from '@/bridge/navigation'
import { useSessionsStore } from '@/stores/sessions'
import {
  contributionStats,
  exportSession,
  searchSessions,
  usageByDay,
  type ContributionReport,
  type DayUsage,
  type SearchHit,
} from '@/bridge/data'

const router = useRouter()
const sessions = useSessionsStore()

// ── 标签页 ─────────────────────────────────────────────────
type Tab = 'contrib' | 'usage' | 'search' | 'export'
const TABS: { key: Tab; label: string }[] = [
  { key: 'contrib', label: '贡献统计' },
  { key: 'usage', label: '用量统计' },
  { key: 'search', label: '会话搜索' },
  { key: 'export', label: '会话导出' },
]
const activeTab = ref<Tab>('contrib')

// ── 贡献统计 ───────────────────────────────────────────────
const sinceDays = ref<number | ''>(30)
const contrib = ref<ContributionReport | null>(null)
const contribBusy = ref(false)
const contribError = ref('')

const sortedAuthors = computed(() =>
  [...(contrib.value?.authors ?? [])].sort((a, b) => b.commits - a.commits),
)

async function loadContributions() {
  if (contribBusy.value) return
  contribBusy.value = true
  contribError.value = ''
  try {
    contrib.value = await contributionStats(sinceDays.value === '' ? undefined : Number(sinceDays.value))
  } catch (e) {
    contribError.value = `统计失败：${e instanceof Error ? e.message : e}`
  } finally {
    contribBusy.value = false
  }
}

function fmtDate(sec: number | null): string {
  if (!sec) return '—'
  const d = new Date(sec * 1000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 迷你柱状图：相对最大值的百分比高度（纯 CSS 条形）。 */
function barHeight(commits: number): string {
  const max = Math.max(1, ...(contrib.value?.by_day.map(d => d.commits) ?? [1]))
  const h = Math.max(8, Math.round((commits / max) * 100))
  return `${h}%`
}

// ── 用量统计 ───────────────────────────────────────────────
const usage = ref<DayUsage[]>([])
const usageBusy = ref(false)
const usageError = ref('')

async function loadUsage() {
  if (usageBusy.value) return
  usageBusy.value = true
  usageError.value = ''
  try {
    usage.value = await usageByDay()
  } catch (e) {
    usageError.value = `用量加载失败：${e instanceof Error ? e.message : e}`
  } finally {
    usageBusy.value = false
  }
}

function fmtNum(n: number): string {
  return n.toLocaleString('zh-CN')
}

// ── 会话搜索 ───────────────────────────────────────────────
const searchQ = ref('')
const hits = ref<SearchHit[]>([])
const searchBusy = ref(false)
const searchError = ref('')

async function runSearch() {
  const q = searchQ.value.trim()
  if (!q) {
    searchError.value = '请输入搜索关键词'
    return
  }
  if (searchBusy.value) return
  searchBusy.value = true
  searchError.value = ''
  hits.value = []
  try {
    hits.value = await searchSessions(q, 50)
  } catch (e) {
    searchError.value = `搜索失败：${e instanceof Error ? e.message : e}`
  } finally {
    searchBusy.value = false
  }
}

/** 点击命中跳转 /sessions 并携带 query 参数（无深层联动）。 */
function goHit(hit: SearchHit) {
  void router.push({ path: '/sessions', query: { q: searchQ.value.trim() } })
}

// ── 会话导出 ───────────────────────────────────────────────
const exportId = ref('')
const exportBusy = ref(false)
const exportError = ref('')
const exportPath = ref('')

async function doExport() {
  if (!exportId.value) {
    exportError.value = '请先选择要导出的会话'
    return
  }
  if (exportBusy.value) return
  exportBusy.value = true
  exportError.value = ''
  exportPath.value = ''
  try {
    const r = await exportSession(exportId.value)
    exportPath.value = r.path
  } catch (e) {
    exportError.value = `导出失败：${e instanceof Error ? e.message : e}`
  } finally {
    exportBusy.value = false
  }
}

onMounted(() => {
  void loadContributions()
  void loadUsage()
  void sessions.syncFromEngine()
})
</script>

<template>
  <div class="page">
    <PageHead title="数据工具" @back="goBack(router, '/settings')" />
    <main class="body">
      <div class="tabs">
        <button v-for="t in TABS" :key="t.key" class="tab" :class="{ on: activeTab === t.key }" @click="activeTab = t.key">{{ t.label }}</button>
      </div>

      <!-- ── 贡献统计 ── -->
      <section v-if="activeTab === 'contrib'" class="tab-panel">
        <div class="card">
          <div class="card-head">
            <span class="card-title">贡献统计</span>
            <span class="card-side">{{ contrib?.total_commits ?? 0 }} 次提交</span>
          </div>
          <div class="filter-row">
            <select v-model="sinceDays" class="sel" aria-label="统计范围" @change="loadContributions">
              <option :value="7">近 7 天</option>
              <option :value="30">近 30 天</option>
              <option :value="90">近 90 天</option>
              <option value="">全部</option>
            </select>
            <button class="btn" :disabled="contribBusy" @click="loadContributions">
              <CoomiIcon name="refresh" :size="14" />{{ contribBusy ? '统计中…' : '查询' }}
            </button>
          </div>
          <p v-if="contribError" class="notice err">{{ contribError }}</p>
          <template v-if="contrib">
            <p v-if="!contrib.authors.length" class="empty">当前范围暂无提交记录（或目录不是 Git 仓库）</p>
            <template v-else>
              <div class="range-meta">
                <span>首个提交 {{ fmtDate(contrib.first_commit_at) }}</span>
                <span>最近提交 {{ fmtDate(contrib.last_commit_at) }}</span>
              </div>
              <p class="block-title">按作者（按提交数排序）</p>
              <div v-for="(a, i) in sortedAuthors" :key="a.name + '\u0000' + a.email" class="author-row">
                <span class="rank">{{ i + 1 }}</span>
                <span class="author-name">{{ a.name }}</span>
                <span class="author-email mono">{{ a.email }}</span>
                <span class="author-commits">{{ a.commits }}</span>
              </div>
              <div v-if="contrib.by_day.length" class="day-block">
                <p class="block-title">按天提交数（{{ contrib.by_day.length }} 天）</p>
                <div class="day-bars">
                  <div v-for="d in contrib.by_day" :key="d.date" class="day-col" :title="`${d.date}：${d.commits} 次`">
                    <span class="bar-val">{{ d.commits }}</span>
                    <span class="bar"><i :style="{ height: barHeight(d.commits) }" /></span>
                    <span class="day-label">{{ d.date.slice(5) }}</span>
                  </div>
                </div>
              </div>
            </template>
          </template>
        </div>
      </section>

      <!-- ── 用量统计 ── -->
      <section v-if="activeTab === 'usage'" class="tab-panel">
        <div class="card">
          <div class="card-head">
            <span class="card-title">按天用量（倒序）</span>
            <span class="card-side">{{ usage.length }} 天</span>
          </div>
          <div class="card-actions">
            <button class="btn" :disabled="usageBusy" @click="loadUsage">
              <CoomiIcon name="refresh" :size="14" />{{ usageBusy ? '加载中…' : '刷新' }}
            </button>
          </div>
          <p v-if="usageError" class="notice err">{{ usageError }}</p>
          <p v-if="!usage.length && !usageBusy" class="empty">暂无用量流水</p>
          <div v-for="d in usage" :key="d.date" class="usage-row">
            <span class="usage-date mono">{{ d.date }}</span>
            <span class="usage-req">{{ d.requests }} 次</span>
            <span class="usage-tokens">{{ d.tokens != null ? `${fmtNum(d.tokens)} tokens` : '—' }}</span>
          </div>
        </div>
      </section>

      <!-- ── 会话搜索 ── -->
      <section v-if="activeTab === 'search'" class="tab-panel">
        <div class="card">
          <div class="card-head"><span class="card-title">会话全文搜索</span></div>
          <form class="filter-row" @submit.prevent="runSearch">
            <input v-model="searchQ" class="text-input mono" placeholder="搜索会话内容关键词" />
            <button class="btn btn-primary" type="submit" :disabled="searchBusy">
              <CoomiIcon name="search" :size="14" />{{ searchBusy ? '搜索中…' : '搜索' }}
            </button>
          </form>
          <p v-if="searchError" class="notice err">{{ searchError }}</p>
          <p v-if="hits.length" class="hit-count">共 {{ hits.length }} 条命中，点击跳转会话历史</p>
          <p v-else-if="!searchBusy && searchQ" class="empty">没有匹配「{{ searchQ }}」的内容</p>
          <div v-for="h in hits" :key="h.session_id + '-' + h.message_index" class="hit-row" @click="goHit(h)">
            <span class="hit-meta mono">{{ h.session_id.slice(0, 8) }}… · 消息 #{{ h.message_index + 1 }}</span>
            <span class="hit-snippet">{{ h.snippet }}</span>
            <CoomiIcon name="chevronRight" :size="14" class="chev" />
          </div>
        </div>
      </section>

      <!-- ── 会话导出 ── -->
      <section v-if="activeTab === 'export'" class="tab-panel">
        <div class="card">
          <div class="card-head"><span class="card-title">会话导出</span></div>
          <p class="export-copy">将会话导出为 Markdown 文件（含消息与工具调用），写入引擎 home/exports/ 目录。</p>
          <form class="filter-row" @submit.prevent="doExport">
            <select v-model="exportId" class="sel" aria-label="选择会话">
              <option value="" disabled>选择要导出的会话</option>
              <option v-for="m in sessions.metas" :key="m.id" :value="m.id">{{ m.title || m.id }} · {{ m.turns }} 轮</option>
            </select>
            <button class="btn btn-primary" type="submit" :disabled="exportBusy">
              <CoomiIcon name="arrowDown" :size="14" />{{ exportBusy ? '导出中…' : '导出' }}
            </button>
          </form>
          <p v-if="exportError" class="notice err">{{ exportError }}</p>
          <p v-if="exportPath" class="export-path mono"><CoomiIcon name="check" :size="14" />{{ exportPath }}</p>
          <p v-if="!sessions.metas.length" class="empty">暂无历史会话可导出</p>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px calc(var(--safe-bottom) + 24px); }

/* ── 标签页 ── */
.tabs { display: flex; gap: 4px; margin-bottom: 10px; padding: 4px; border-radius: var(--r-md); background: var(--fill-strong); overflow-x: auto; scrollbar-width: none; }
.tabs::-webkit-scrollbar { display: none; }
.tab { flex: 1 0 auto; min-height: 34px; padding: 0 12px; border-radius: 8px; color: var(--text-2); font-size: 12.3px; font-weight: 550; white-space: nowrap; }
.tab.on { background: var(--bg); color: var(--blue); box-shadow: var(--shadow-1); }
.tab-panel { display: flex; flex-direction: column; gap: 10px; }

/* ── 卡片 ── */
.card { border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.card-head { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 8px 13px; border-bottom: 1px solid var(--border); }
.card-title { font-size: 13.5px; font-weight: 650; color: var(--text); }
.card-side { margin-left: auto; font-size: 12px; color: var(--text-3); }
.card-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 13px 0; }
.filter-row { display: flex; gap: 7px; flex-wrap: wrap; padding: 10px 13px; }
.filter-row .btn { min-height: 38px; padding: 0 15px; font-size: 13px; }
.sel { flex: 1; min-width: 130px; min-height: 38px; padding: 0 9px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg-input); color: var(--text); font-size: 12.5px; }
.text-input { flex: 1; min-width: 140px; min-height: 38px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg-input); color: var(--text); font-size: 12.5px; }
.btn { display: inline-flex; align-items: center; gap: 5px; min-height: 34px; padding: 0 12px; border-radius: 6px; background: var(--fill-strong); color: var(--text-2); font-size: 12.5px; }
.btn-primary { background: var(--blue); color: #fff; }
.btn:disabled { opacity: .5; }

/* ── 提示 ── */
.notice { margin: 0; padding: 8px 12px; border-radius: var(--r-sm); background: var(--ok-soft); color: var(--ok); font-size: 12.5px; line-height: 1.5; word-break: break-all; }
.notice.err { background: var(--danger-soft); color: var(--danger); }
.empty { padding: 16px 4px; color: var(--text-3); font-size: 12.5px; text-align: center; }
.block-title { margin: 10px 13px 4px; font-size: 12.5px; font-weight: 650; color: var(--text-2); }

/* ── 贡献统计 ── */
.range-meta { display: flex; justify-content: space-between; gap: 8px; padding: 10px 13px 2px; color: var(--text-3); font-size: 11.5px; }
.author-row { display: flex; align-items: center; gap: 9px; min-height: 40px; padding: 6px 13px; border-bottom: 1px solid var(--border); }
.author-row:last-child { border-bottom: none; }
.rank { flex-shrink: 0; width: 22px; color: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; }
.author-name { flex-shrink: 1; min-width: 0; overflow: hidden; color: var(--text); font-size: 13px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.author-email { flex: 1; min-width: 0; overflow: hidden; color: var(--text-3); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.author-commits { flex-shrink: 0; min-width: 34px; color: var(--blue); font-size: 12.5px; font-weight: 650; font-variant-numeric: tabular-nums; text-align: right; }

/* ── 迷你柱状图（纯 CSS） ── */
.day-block { padding: 4px 13px 12px; }
.day-bars { display: flex; align-items: flex-end; gap: 2px; margin-top: 6px; padding-top: 8px; overflow-x: auto; padding-bottom: 2px; }
.day-col { flex: 0 0 18px; display: flex; flex-direction: column; align-items: center; gap: 3px; }
.bar-val { color: var(--text-3); font-size: 9px; font-variant-numeric: tabular-nums; }
.bar { display: flex; align-items: flex-end; width: 8px; height: 56px; border-radius: 3px; background: var(--fill-strong); overflow: hidden; }
.bar i { display: block; width: 100%; border-radius: 3px 3px 0 0; background: var(--blue); min-height: 2px; }
.day-label { color: var(--text-3); font-size: 9px; white-space: nowrap; }

/* ── 用量统计 ── */
.usage-row { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; min-height: 40px; padding: 8px 13px; border-bottom: 1px solid var(--border); }
.usage-row:last-child { border-bottom: none; }
.usage-date { color: var(--text); font-size: 12.5px; }
.usage-req { color: var(--blue); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.usage-tokens { color: var(--text-3); font-size: 12px; font-variant-numeric: tabular-nums; }

/* ── 会话搜索 ── */
.hit-count { padding: 2px 13px 0; color: var(--text-3); font-size: 11.5px; }
.hit-row { display: flex; flex-direction: column; gap: 3px; padding: 10px 13px; border-bottom: 1px solid var(--border); cursor: pointer; }
.hit-row:last-child { border-bottom: none; }
.hit-row:active { background: var(--fill); }
.hit-meta { color: var(--blue); font-size: 11px; }
.hit-snippet { color: var(--text-2); font-size: 12.3px; line-height: 1.55; word-break: break-all; }
.chev { position: absolute; right: 13px; margin-top: 2px; color: var(--text-3); }
.hit-row { position: relative; padding-right: 34px; }

/* ── 会话导出 ── */
.export-copy { margin: 0; padding: 10px 13px 0; color: var(--text-2); font-size: 12.5px; line-height: 1.65; }
.export-path { display: flex; align-items: center; gap: 6px; margin: 0; padding: 0 13px 12px; color: var(--ok); font-size: 12px; line-height: 1.5; word-break: break-all; }
</style>
