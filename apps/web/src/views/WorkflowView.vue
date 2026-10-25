<script setup lang="ts">
/**
 * 自动化工作流（P1）。
 * 列表 → 详情（步骤概览 + cron 定时开关 + 运行历史 + JSON 编辑）+ 内置模板一键创建。
 * 引擎侧 API：/api/workflows（CRUD）、/{id}/run、/{id}/runs、/templates。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { goBack } from '@/bridge/navigation'
import { apiGet, apiSend } from '@/bridge/http'
import { activeWorkflowStatus, createWorkflowRunPoller, workflowStatusLabel, type WorkflowRun } from '@/utils/workflowRuns'

interface WorkflowListItem {
  id: string; name: string; description: string; origin: string; status: string
  schedule: { enabled: boolean; cron: string | null }
  steps: number
  latest_run?: { run_id: string; status: string; trigger: string; started_at: number; duration_ms?: number | null }
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
const runs = ref<WorkflowRun[]>([])
const cronDraft = ref('')
const cronEnabled = ref(false)
const jsonDraft = ref('')
const saving = ref(false)
const running = ref(false)
const actionBusy = ref('')
const recoveryId = ref('')
const answers = ref<Record<string, string>>({})
const cwdDraft = ref('')
const permissionDraft = ref('ask')
let detailGeneration = 0
const poller = createWorkflowRunPoller({
  load: async id => (await apiGet<{ runs: WorkflowRun[] }>(`/api/workflows/${encodeURIComponent(id)}/runs`)).runs,
  receive: value => { runs.value = value },
  error: e => { error.value = `刷新运行记录失败：${e instanceof Error ? e.message : String(e)}` },
})


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

async function openDetail(id: string) {
  if (detailId.value === id) { closeDetail(); return }
  poller.stop()
  detailId.value = id
  detail.value = null
  recoveryId.value = ''
  answers.value = {}
  detailLoading.value = true
  runs.value = []
  await loadDetail(id)
}

async function loadDetail(id: string) {
  const generation = ++detailGeneration
  try {
    const info = await apiGet<any>(`/api/workflows/${encodeURIComponent(id)}`)
    if (detailId.value !== id || generation !== detailGeneration) return
    detail.value = info
    cronDraft.value = info.schedule?.cron ?? ''
    cronEnabled.value = !!info.schedule?.enabled
    cwdDraft.value = info.cwd ?? ''
    permissionDraft.value = info.permission ?? 'ask'
    jsonDraft.value = JSON.stringify(info, null, 2)
    poller.start(id)
  } catch (e) {
    if (detailId.value !== id || generation !== detailGeneration) return
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (detailId.value === id && generation === detailGeneration) detailLoading.value = false
  }
}

function closeDetail() {
  detailGeneration++
  detailId.value = ''
  detail.value = null
  runs.value = []
  poller.stop()
  recoveryId.value = ''
  void refresh()
}

async function createFromTemplate(key: string) {
  busyId.value = key
  try {
    const created = await apiSend<any>('/api/workflows', 'POST', { template: key })
    showTemplates.value = false
    notice.value = `已创建「${created.name}」，可先手动运行，再开启定时。`
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busyId.value = ''
  }
}

async function runWorkflow(id: string) {
  running.value = true
  try {
    await apiSend(`/api/workflows/${encodeURIComponent(id)}/run`, 'POST')
    notice.value = '已创建运行，可在下方查看步骤进度与审批请求。'
    if (detailId.value !== id) await openDetail(id)
    else poller.start(id)
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

async function runAction(runId: string, action: string) {
  const id = detailId.value
  actionBusy.value = runId
  try {
    await apiSend(`/api/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/action`, 'POST', {
      action, confirm_replay: action === 'recover',
    })
    recoveryId.value = ''
    if (detailId.value === id) poller.start(id)
    notice.value = action === 'cancel' ? '本次运行已停止。已经完成的文件修改仍然保留。' : '操作已提交。'
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { actionBusy.value = '' }
}

async function answerRun(run: WorkflowRun, allow?: boolean) {
  if (!run.pending) return
  const id = detailId.value
  actionBusy.value = run.id
  try {
    const questionAnswers = Object.fromEntries((run.pending.questions?.questions ?? []).map(q => [q.id, answers.value[`${run.pending!.id}:${q.id}`] ?? '']))
    await apiSend(`/api/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.id)}/answer`, 'POST', {
      request_id: run.pending.id, allow, answers: questionAnswers,
    })
    if (detailId.value === id) poller.start(id)
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { actionBusy.value = '' }
}

async function saveRuntime() {
  saving.value = true
  try {
    await apiSend(`/api/workflows/${encodeURIComponent(detailId.value)}`, 'PUT', { cwd: cwdDraft.value.trim() || null, permission: permissionDraft.value })
    notice.value = '运行设置已保存，将用于下一次新运行。'
    await loadDetail(detailId.value)
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { saving.value = false }
}

async function saveSchedule() {
  if (!detailId.value) return
  saving.value = true
  try {
    await apiSend(`/api/workflows/${encodeURIComponent(detailId.value)}`, 'PUT', {
      schedule: { enabled: cronEnabled.value, cron: cronDraft.value.trim() || null },
    })
    notice.value = '定时配置已保存'
    await loadDetail(detailId.value)
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
  if (kind === 'script') return '脚本 · 当前运行环境'
  if (kind === 'model') return '模型 · prompt'
  if (kind === 'sub_workflow') return `子工作流 · ${step.action.workflow}`
  if (kind === 'approval') return '人工审批'
  return kind
}

const runStatusLabel = workflowStatusLabel

onMounted(() => {
  void refresh()
  void loadTemplates()
})
onUnmounted(() => { detailGeneration++; detailId.value = ''; poller.stop() })
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
          <p class="hint">从内置模板创建，手动验证后可开启定时：</p>
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
              <span>{{ w.steps }} 步 · {{ runStatusLabel(w.status) }}</span>
              <span v-if="w.latest_run" class="last-run">
                {{ runStatusLabel(w.latest_run.status) }} {{ fmtTime(w.latest_run.started_at) }}
              </span>
              <button class="act run" :disabled="running || activeWorkflowStatus(w.status)" @click.stop="runWorkflow(w.id)">
                <CoomiIcon name="play" :size="14" />运行
              </button>
              <button class="act peril" :disabled="activeWorkflowStatus(w.status)" @click.stop="removeWorkflow(w.id)">
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

          <section class="group runtime-settings">
            <p class="sec-label">运行设置</p>
            <label>工作目录<input v-model="cwdDraft" class="cron" placeholder="留空使用当前引擎工作区" /></label>
            <label>执行权限<select v-model="permissionDraft">
              <option value="ask">询问：修改与命令执行前确认</option>
              <option value="auto">自动：一般读写自动执行，危险命令确认</option>
              <option value="full">放行：工具自动执行</option>
            </select></label>
            <p class="hint">人工审批节点始终需要确认。运行开始后使用固定的定义和目录，编辑只影响下一次新运行。</p>
            <button class="secondary" :disabled="saving" @click="saveRuntime">保存运行设置</button>
          </section>

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
              <span>{{ r.trigger === 'schedule' ? '定时' : r.trigger === 'recovery' ? '恢复' : '手动' }}</span>
              <span>{{ fmtTime(r.started_at) }}</span>
              <span v-if="r.duration_ms != null">耗时 {{ (r.duration_ms / 1000).toFixed(1) }}s</span>
              <span v-if="r.usage">用量 {{ r.usage.input_tokens + r.usage.output_tokens }} tokens</span>
              <p v-if="r.error" class="run-error">{{ r.error }}</p>
              <div v-if="activeWorkflowStatus(r.status)" class="run-actions">
                <button v-if="['running', 'queued'].includes(r.status)" class="secondary" :disabled="actionBusy === r.id" @click="runAction(r.id, 'pause')">暂停</button>
                <button v-if="['paused', 'pause_pending'].includes(r.status)" class="secondary" :disabled="actionBusy === r.id" @click="runAction(r.id, 'resume')">继续</button>
                <button class="secondary" :disabled="actionBusy === r.id" @click="runAction(r.id, 'cancel')">停止运行</button>
              </div>
              <div v-if="r.pending" class="interaction">
                <p>{{ r.pending.prompt }}</p>
                <pre v-if="r.pending.tool">{{ r.pending.tool.name }} {{ JSON.stringify(r.pending.tool.arguments, null, 2) }}</pre>
                <template v-if="r.pending.kind === 'question'">
                  <label v-for="q in r.pending.questions?.questions ?? []" :key="q.id">
                    {{ q.question }}
                    <div v-if="q.options?.length" class="run-actions">
                      <button v-for="o in q.options" :key="o.label" class="secondary" @click="answers[`${r.pending.id}:${q.id}`] = o.label">{{ o.label }}</button>
                    </div>
                    <input v-model="answers[`${r.pending.id}:${q.id}`]" class="cron" placeholder="输入回答" />
                  </label>
                  <button class="primary" :disabled="actionBusy === r.id" @click="answerRun(r)">提交回答</button>
                </template>
                <div v-else class="run-actions">
                  <button class="secondary" :disabled="actionBusy === r.id" @click="answerRun(r, false)">拒绝</button>
                  <button class="primary" :disabled="actionBusy === r.id" @click="answerRun(r, true)">允许本次</button>
                </div>
              </div>
              <button v-if="r.resumable && !runs.some(run => activeWorkflowStatus(run.status))" class="secondary" @click="recoveryId = r.id">恢复未完成步骤</button>
              <div v-if="recoveryId === r.id" class="interaction">
                <p>成功步骤会保留。未完成的命令或工具步骤会重新执行，模型步骤会参考已保存的会话继续。请先检查最后一步是否已修改文件或提交了外部操作。</p>
                <div class="run-actions"><button class="secondary" @click="recoveryId = ''">返回检查</button><button class="primary" :disabled="actionBusy === r.id" @click="runAction(r.id, 'recover')">已核对，恢复执行</button></div>
              </div>
              <div class="run-steps">
                <details v-for="st in r.steps" :key="st.id" class="run-step">
                  <summary>{{ st.name }} · {{ workflowStatusLabel(st.state) }}<span v-if="st.attempts"> · {{ st.attempts }} 次尝试</span><span v-if="st.duration_ms != null"> · {{ (st.duration_ms / 1000).toFixed(1) }}s</span></summary>
                  <p v-if="st.error" class="run-error">{{ st.error }}</p>
                  <pre v-if="st.result != null">{{ typeof st.result === 'string' ? st.result : JSON.stringify(st.result, null, 2) }}</pre>
                </details>
              </div>
            </div>
          </section>

          <section class="group">
            <p class="sec-label">JSON 定义</p>
            <textarea v-model="jsonDraft" class="json-box" rows="12" spellcheck="false" />
            <div class="json-actions">
              <button class="primary" :disabled="saving" @click="saveJson">保存定义</button>
              <button class="primary" :disabled="running || runs.some(run => activeWorkflowStatus(run.status))" @click="runWorkflow(detail.id)">
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
button:disabled { opacity: .5; cursor: default; }
.runtime-settings label, .interaction label { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; font-size: 12px; }
.runtime-settings select { min-height: 38px; color: var(--text); background: var(--fill); border: 1px solid var(--border); border-radius: 8px; padding: 6px; }
.interaction { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--fill); }
.run-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.run-error { width: 100%; color: var(--danger); white-space: pre-wrap; overflow-wrap: anywhere; }
.run-steps pre, .interaction pre { max-height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
.run-step summary { cursor: pointer; }
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
