<script setup lang="ts">
/**
 * 自动化工作流（P1）。
 * 列表 → 详情（步骤概览 + cron 定时开关 + 运行历史 + JSON 编辑）+ 内置模板一键创建。
 * 引擎侧 API：/api/workflows（CRUD）、/{id}/run、/{id}/runs、/templates。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { goBack } from '@/bridge/navigation'
import { apiGet, apiSend } from '@/bridge/http'

interface WorkflowListItem {
  id: string; name: string; description: string; origin: string; status: string
  schedule: { enabled: boolean; cron: string | null }
  steps: number
  latest_run?: { run_id: string; status: string; trigger: string; started_at: number; duration_ms?: number | null }
}
interface RunItem {
  id: string; started_at: number; status: string; trigger: string; duration_ms?: number | null
  steps: Array<{ id: string; name: string; state: string; error?: string | null }>
}
interface TemplateItem { key: string; name: string; description: string; default_cron: string }

const router = useRouter()
const loading = ref(true)
const error = ref('')
const workflows = ref<WorkflowListItem[]>([])
const templates = ref<TemplateItem[]>([])
const showTemplates = ref(false)
const busyId = ref('')
const notice = ref('')

// ── 详情 ──
const detailId = ref('')
const detail = ref<any>(null)
const detailLoading = ref(false)
const runs = ref<RunItem[]>([])
const cronDraft = ref('')
const cronEnabled = ref(false)
const jsonDraft = ref('')
const saving = ref(false)
const running = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

const sortKey = (s: string) => s

async function refresh() {
  error.value = ''
  try {
    const data = await apiGet<{ workflows: WorkflowListItem[] }>('/api/workflows')
    workflows.value = data.workflows
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadTemplates() {
  try {
    const data = await apiGet<{ templates: TemplateItem[] }>('/api/workflows/templates')
    templates.value = data.templates
  } catch { /* 模板拉不到不阻塞主流程 */ }
}

function openDetail(id: string) {
  if (detailId.value === id) { closeDetail(); return }
  detailId.value = id
  detailLoading.value = true
  runs.value = []
  void loadDetail(id)
}

async function loadDetail(id: string) {
  try {
    const info = await apiGet<any>(`/api/workflows/${encodeURIComponent(id)}`)
    detail.value = info
    cronDraft.value = info.schedule?.cron ?? ''
    cronEnabled.value = !!info.schedule?.enabled
    jsonDraft.value = JSON.stringify(info, null, 2)
    const runData = await apiGet<{ runs: RunItem[] }>(`/api/workflows/${encodeURIComponent(id)}/runs`)
    runs.value = runData.runs
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  detailId.value = ''
  detail.value = null
  runs.value = []
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

async function createFromTemplate(key: string) {
  busyId.value = key
  try {
    const created = await apiSend<any>('/api/workflows', 'POST', { template: key })
    showTemplates.value = false
    notice.value = `已创建「${created.name}」，下次定时：${created.schedule?.cron ?? '-'}`
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busyId.value = ''
  }
}

async function runWorkflow(id: string) {
  running.value = true
  notice.value = '已触发运行，稍后可在运行历史查看'
  try {
    await apiSend(`/api/workflows/${encodeURIComponent(id)}/run`, 'POST')
    startPolling()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

/** 触发运行后 3 秒轮询刷新历史（最多 60 秒）。 */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  let left = 20
  pollTimer = setInterval(async () => {
    left -= 1
    const id = detailId.value
    if (id) {
      try {
        const runData = await apiGet<{ runs: RunItem[] }>(`/api/workflows/${encodeURIComponent(id)}/runs`)
        runs.value = runData.runs
      } catch { /* 轮询失败忽略 */ }
    }
    if (left <= 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }, 3000)
}

async function saveSchedule() {
  if (!detailId.value) return
  saving.value = true
  try {
    await apiSend(`/api/workflows/${encodeURIComponent(detailId.value)}`, 'PUT', {
      schedule: { enabled: cronEnabled.value, cron: cronDraft.value.trim() || null },
    })
    notice.value = '定时配置已保存'
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function saveJson() {
  if (!detailId.value) return
  saving.value = true
  try {
    let parsed: any
    try { parsed = JSON.parse(jsonDraft.value) } catch { throw new Error('JSON 格式错误') }
    await apiSend(`/api/workflows/${encodeURIComponent(detailId.value)}`, 'PUT', parsed)
    notice.value = '定义已保存'
    await loadDetail(detailId.value)
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function removeWorkflow(id: string) {
  try {
    await apiSend(`/api/workflows/${encodeURIComponent(id)}`, 'DELETE')
    if (detailId.value === id) closeDetail()
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function fmtTime(ts?: number | null) {
  if (!ts) return '-'
  return new Date(ts * 1000).toLocaleString()
}

function stepKind(step: any) {
  const kind = step.action?.kind ?? 'unknown'
  if (kind === 'tool') return `工具 · ${step.action.tool}`
  if (kind === 'script') return '脚本 · bash'
  if (kind === 'model') return '模型 · prompt'
  if (kind === 'sub_workflow') return `子工作流 · ${step.action.workflow}`
  return kind
}

const runStatusLabel = computed(() => (s: string) => ({
  running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消',
})[s] ?? s)

onMounted(() => {
  void refresh()
  void loadTemplates()
})
</script>

<template>
  <div class="page">
    <PageHead title="自动化工作流（实验）" @back="goBack(router, 'dashboard')" />
    <main class="body">
      <div v-if="notice" class="notice">{{ notice }}</div>
      <div v-if="error" class="notice error">{{ error }}</div>

      <!-- 列表 -->
      <section v-if="!detailId" class="list-section">
        <div class="list-head">
          <p class="sec-label">已安装工作流</p>
          <button class="primary slim" @click="showTemplates = !showTemplates">
            <CoomiIcon name="plus" :size="14" />新建
          </button>
        </div>

        <div v-if="showTemplates" class="templates">
          <p class="hint">从内置模板创建（自动启用定时，可稍后调整）：</p>
          <button v-for="t in templates" :key="t.key" class="tmpl" :disabled="busyId === t.key" @click="createFromTemplate(t.key)">
            <strong>{{ t.name }}</strong>
            <span>{{ t.description }}</span>
            <code>cron: {{ t.default_cron }}</code>
          </button>
          <p class="hint">也可在详情页直接编辑 JSON 定义。定时任务需要引擎常驻运行。</p>
        </div>

        <p v-if="loading" class="hint">加载中…</p>
        <p v-else-if="workflows.length === 0" class="hint">
          还没有工作流。点「新建」从模板创建，或编辑 JSON 自定义步骤编排。
        </p>
        <div v-else class="cards">
          <div v-for="w in workflows" :key="w.id" class="card" @click="openDetail(w.id)">
            <div class="title-row">
              <span class="tile"><CoomiIcon name="target" :size="18" /></span>
              <div class="meta">
                <span class="cname">{{ w.name }}</span>
                <span class="cdesc">{{ w.description || '（无描述）' }}</span>
              </div>
              <span class="badge" :class="w.schedule?.enabled ? 'on' : ''">
                {{ w.schedule?.enabled ? `定时 ${w.schedule.cron}` : '未启用定时' }}
              </span>
            </div>
            <div class="foot">
              <span>{{ w.steps }} 步 · {{ w.status }}</span>
              <span v-if="w.latest_run" class="last-run">
                {{ runStatusLabel(w.latest_run.status) }} {{ fmtTime(w.latest_run.started_at) }}
              </span>
              <button class="act run" @click.stop="runWorkflow(w.id)">
                <CoomiIcon name="play" :size="14" />运行
              </button>
              <button class="act peril" @click.stop="removeWorkflow(w.id)">
                <CoomiIcon name="trash" :size="14" />删除
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 详情 -->
      <section v-else class="detail-section">
        <div class="detail-head">
          <button class="back" @click="closeDetail"><CoomiIcon name="chevronLeft" :size="16" />返回</button>
          <p class="sec-label">{{ detail?.name ?? '…' }}</p>
        </div>
        <p v-if="detailLoading" class="hint">加载中…</p>
        <template v-else-if="detail">
          <p class="cdesc">{{ detail.description || '（无描述）' }}</p>

          <section class="group schedule">
            <label class="switch-row">
              <input v-model="cronEnabled" type="checkbox" />
              <span>启用定时</span>
              <code v-if="cronEnabled">{{ cronDraft || '未设置 cron' }}</code>
            </label>
            <div class="cron-row">
              <input v-model="cronDraft" class="cron" placeholder="cron，如 0 8 * * *" @keydown.enter="saveSchedule" />
              <button class="secondary" :disabled="saving" @click="saveSchedule">保存定时</button>
            </div>
          </section>

          <section class="group">
            <p class="sec-label">步骤（{{ detail.steps?.length ?? 0 }}）</p>
            <div v-for="(s, i) in detail.steps" :key="s.id" class="step-row">
              <span class="order">{{ i + 1 }}</span>
              <div class="step-meta">
                <strong>{{ s.name }}</strong>
                <span>{{ stepKind(s) }}</span>
              </div>
              <span v-if="s.depends_on?.length" class="deps">依赖 {{ s.depends_on.join(', ') }}</span>
            </div>
          </section>

          <section class="group">
            <p class="sec-label">运行历史</p>
            <p v-if="runs.length === 0" class="hint">暂无运行记录（定时触发或手动运行后出现在这里）。</p>
            <div v-for="r in runs" :key="r.id" class="run-row">
              <span class="run-status" :class="r.status">{{ runStatusLabel(r.status) }}</span>
              <span>{{ r.trigger === 'schedule' ? '定时' : '手动' }}</span>
              <span>{{ fmtTime(r.started_at) }}</span>
              <span v-if="r.duration_ms != null">耗时 {{ (r.duration_ms / 1000).toFixed(1) }}s</span>
              <div class="run-steps">
                <span v-for="st in r.steps" :key="st.id" :title="st.error ?? ''" class="run-step">
                  {{ st.name }} · {{ st.state }}
                </span>
              </div>
            </div>
          </section>

          <section class="group">
            <p class="sec-label">JSON 定义</p>
            <textarea v-model="jsonDraft" class="json-box" rows="12" spellcheck="false" />
            <div class="json-actions">
              <button class="primary" :disabled="saving" @click="saveJson">保存定义</button>
              <button class="primary" :disabled="running" @click="runWorkflow(detail.id)">
                <CoomiIcon name="play" :size="14" />立即运行
              </button>
            </div>
          </section>
        </template>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); min-width: 0; }
.sec-label { margin: 16px 0 6px; }
.list-head { display: flex; align-items: center; justify-content: space-between; margin: 4px 0 10px; }
.list-head .sec-label { margin-bottom: 0; }
.primary, .secondary { min-height: 34px; padding: 0 13px; border-radius: 7px; font-size: 13px; font-weight: 600; }
.primary { background: var(--blue); color: #fff; }
.secondary { background: var(--fill); color: var(--text-2); }
.primary.slim { display: inline-flex; align-items: center; gap: 4px; }

.notice { margin: 0 0 10px; padding: 8px 12px; border-radius: 8px; background: var(--blue-soft); color: var(--blue); font-size: 12.5px; }
.notice.error { background: color-mix(in srgb, var(--orange) 16%, var(--bg)); color: var(--orange); }

.cards { display: flex; flex-direction: column; gap: 8px; }
.card { padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-elev); cursor: pointer; }
.title-row { display: flex; align-items: flex-start; gap: 10px; }
.tile { display: grid; place-items: center; width: 34px; height: 34px; flex-shrink: 0; border-radius: 9px; background: var(--blue-soft); color: var(--blue); }
.meta { flex: 1; min-width: 0; }
.cname { display: block; font-size: 14.5px; font-weight: 650; color: var(--text); }
.cdesc { display: block; margin-top: 2px; font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { flex-shrink: 0; font-size: 11px; padding: 3px 8px; border-radius: var(--r-pill); background: var(--fill); color: var(--text-3); }
.badge.on { background: var(--blue-soft); color: var(--blue); }
.foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 12px; color: var(--text-3); }
.last-run { margin-left: auto; }
.act { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 9px; border: 0; border-radius: 6px; background: none; font-size: 12.5px; color: var(--text-3); }
.act.run { color: var(--blue); }
.act.peril { color: var(--orange); }
.act:active { background: var(--fill-press); }

.templates { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.tmpl { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border: 1px dashed var(--border-strong); border-radius: 10px; background: none; text-align: left; }
.tmpl strong { font-size: 13.5px; color: var(--text); }
.tmpl span { font-size: 12px; color: var(--text-2); }
.tmpl code { font-size: 11px; color: var(--blue); }

.detail-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.back { display: inline-flex; align-items: center; gap: 3px; border: 0; background: none; color: var(--blue); font-size: 13px; }
.group { margin-bottom: 12px; overflow: hidden; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); padding: 12px; }
.switch-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
.switch-row code { color: var(--blue); }
.cron-row { display: flex; gap: 8px; margin-top: 8px; }
.cron { flex: 1; height: 38px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--fill); color: var(--text); font-size: 13px; }
.step-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.step-row:last-child { border-bottom: 0; }
.order { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--fill); color: var(--text-2); font-size: 11px; }
.step-meta { flex: 1; min-width: 0; }
.step-meta strong { display: block; font-size: 13px; color: var(--text); }
.step-meta span { font-size: 12px; color: var(--text-2); }
.deps { font-size: 11px; color: var(--text-3); }

.run-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-2); }
.run-row:last-child { border-bottom: 0; }
.run-status { padding: 2px 8px; border-radius: var(--r-pill); background: var(--fill); font-weight: 600; }
.run-status.completed { background: var(--blue-soft); color: var(--blue); }
.run-status.failed { background: color-mix(in srgb, var(--orange) 14%, var(--bg)); color: var(--orange); }
.run-steps { display: flex; flex-wrap: wrap; gap: 4px; width: 100%; }
.run-step { padding: 2px 7px; border-radius: 6px; background: var(--fill); color: var(--text-3); font-size: 11px; }

.json-box { display: block; width: 100%; min-height: 220px; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--fill); color: var(--text); font: 11.5px/1.6 ui-monospace, monospace; resize: vertical; }
.json-actions { display: flex; gap: 8px; margin-top: 8px; }
.hint { margin: 8px 0; font-size: 12.5px; color: var(--text-3); }
</style>
