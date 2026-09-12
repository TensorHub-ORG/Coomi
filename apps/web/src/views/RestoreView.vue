<script setup lang="ts">
/**
 * 一键还原：快照列表（时间倒序）+ 预览/还原 + 备注/锁定/删除 + 双快照对比。
 * 数据来自 /api/git/snapshots*（见 src/bridge/git.ts）。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { goBack } from '@/bridge/navigation'
import {
  gitCompare,
  gitSnapshotDelete,
  gitSnapshotPreview,
  gitSnapshotRestore,
  gitSnapshots,
  gitSnapshotSchedule,
  gitSnapshotScheduleUpdate,
  gitSnapshotUpdate,
  type DiffInfo,
  type RestoreReport,
  type Snapshot,
  type SnapshotKind,
  type SnapshotPreview,
} from '@/bridge/git'

const router = useRouter()

const snapshots = ref<Snapshot[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')
const report = ref<RestoreReport | null>(null)

// ── kind 徽标 ──────────────────────────────────────────────
const KIND_META: Record<SnapshotKind, { label: string; cls: string }> = {
  turn: { label: '轮次', cls: 'turn' },
  session: { label: '会话', cls: 'session' },
  manual: { label: '手动', cls: 'manual' },
  'pre-restore': { label: '还原前备份', cls: 'pre' },
}
function kindLabel(kind: SnapshotKind): string { return KIND_META[kind]?.label ?? kind }
function kindCls(kind: SnapshotKind): string { return KIND_META[kind]?.cls ?? 'other' }

// ── 快照列表 ───────────────────────────────────────────────
async function load() {
  loading.value = true
  error.value = ''
  try {
    snapshots.value = await gitSnapshots()
    // 默认对比：最新与次新两个快照。
    if (snapshots.value.length >= 2) {
      compareTo.value = snapshots.value[0].id
      compareFrom.value = snapshots.value[1].id
    } else if (snapshots.value.length === 1) {
      compareTo.value = snapshots.value[0].id
      compareFrom.value = ''
    } else {
      compareTo.value = ''
      compareFrom.value = ''
    }
  } catch (e) {
    error.value = `快照加载失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    loading.value = false
  }
}

function fmtTime(sec: number): string {
  if (!sec) return ''
  const d = new Date(sec * 1000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ── 预览 / 还原 ────────────────────────────────────────────
interface PreviewSheet { preview: SnapshotPreview | null; busy: boolean }
const previewState = ref<PreviewSheet | null>(null)

async function openPreview(snap: Snapshot) {
  previewState.value = { preview: null, busy: true }
  try {
    previewState.value = { preview: await gitSnapshotPreview(snap.id), busy: false }
  } catch (e) {
    previewState.value = null
    notice.value = `预览加载失败：${e instanceof Error ? e.message : e}`
  }
}

async function confirmRestore() {
  const sheet = previewState.value
  const snap = sheet?.preview?.snapshot
  if (!sheet || !snap || sheet.busy) return
  sheet.busy = true
  try {
    const result = await gitSnapshotRestore(snap.id)
    report.value = result
    previewState.value = null
    notice.value = '还原完成'
    await load()
  } catch (e) {
    sheet.busy = false
    notice.value = `还原失败：${e instanceof Error ? e.message : e}`
  }
}

// ── 备注 / 锁定 / 删除 ─────────────────────────────────────
const editing = ref<Snapshot | null>(null)
const noteDraft = ref('')
const noteBusy = ref(false)
const deleteRequest = ref<Snapshot | null>(null)
const deleteBusy = ref(false)

function startEditNote(snap: Snapshot) {
  editing.value = snap
  noteDraft.value = snap.note ?? ''
}

async function saveNote() {
  const snap = editing.value
  if (!snap || noteBusy.value) return
  noteBusy.value = true
  try {
    await gitSnapshotUpdate(snap.id, { note: noteDraft.value.trim() })
    editing.value = null
    notice.value = '备注已保存'
    await load()
  } catch (e) {
    notice.value = `保存失败：${e instanceof Error ? e.message : e}`
  } finally {
    noteBusy.value = false
  }
}

async function toggleLock(snap: Snapshot) {
  try {
    await gitSnapshotUpdate(snap.id, { locked: !snap.locked })
    notice.value = snap.locked ? '已解锁' : '已锁定（不会被自动清理）'
    await load()
  } catch (e) {
    notice.value = `操作失败：${e instanceof Error ? e.message : e}`
  }
}

function requestDelete(snap: Snapshot) { deleteRequest.value = snap }

async function confirmDelete() {
  const snap = deleteRequest.value
  if (!snap || deleteBusy.value) return
  deleteBusy.value = true
  try {
    await gitSnapshotDelete(snap.id)
    deleteRequest.value = null
    notice.value = '快照已删除'
    await load()
  } catch (e) {
    notice.value = `删除失败：${e instanceof Error ? e.message : e}`
  } finally {
    deleteBusy.value = false
  }
}

// ── 双快照对比 ─────────────────────────────────────────────
const compareFrom = ref('')
const compareTo = ref('')
const compareBusy = ref(false)
const compareResult = ref<DiffInfo | null>(null)
const compareError = ref('')

async function doCompare() {
  if (compareBusy.value || !compareFrom.value || !compareTo.value || compareFrom.value === compareTo.value) return
  compareBusy.value = true
  compareResult.value = null
  compareError.value = ''
  try {
    compareResult.value = await gitCompare(compareFrom.value, compareTo.value)
  } catch (e) {
    compareError.value = `对比失败：${e instanceof Error ? e.message : e}`
  } finally {
    compareBusy.value = false
  }
}

// ── diff 行级着色 ──────────────────────────────────────────
type DiffKind = 'add' | 'del' | 'hunk' | 'meta' | 'plain'
interface DiffLine { text: string; kind: DiffKind }

function splitDiffLines(raw: string): DiffLine[] {
  return raw.split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) return { text: line, kind: 'meta' as const }
    if (line.startsWith('+')) return { text: line, kind: 'add' as const }
    if (line.startsWith('-')) return { text: line, kind: 'del' as const }
    if (line.startsWith('@@')) return { text: line, kind: 'hunk' as const }
    if (/^(diff --git|index |new file|deleted file|rename |similarity |dissimilarity |Binary files)/.test(line)) {
      return { text: line, kind: 'meta' as const }
    }
    return { text: line, kind: 'plain' as const }
  })
}

// ── 定时快照设置 ───────────────────────────────────────────
const scheduleEnabled = ref(false)
const scheduleCron = ref('')
const scheduleRetain = ref(10)
const scheduleLoading = ref(false)
const scheduleSaving = ref(false)
const scheduleError = ref('')

async function loadSchedule() {
  scheduleLoading.value = true
  scheduleError.value = ''
  try {
    const s = await gitSnapshotSchedule()
    scheduleEnabled.value = s.enabled
    scheduleCron.value = s.cron ?? ''
    scheduleRetain.value = s.retain
  } catch (e) {
    scheduleError.value = `定时快照配置加载失败：${e instanceof Error ? e.message : e}`
  } finally {
    scheduleLoading.value = false
  }
}

async function saveSchedule() {
  const retain = Math.round(scheduleRetain.value)
  if (!Number.isFinite(retain) || retain < 1 || retain > 200) {
    scheduleError.value = '保留数量需在 1-200 之间'
    return
  }
  if (scheduleSaving.value) return
  scheduleSaving.value = true
  scheduleError.value = ''
  try {
    const s = await gitSnapshotScheduleUpdate({
      enabled: scheduleEnabled.value,
      cron: scheduleCron.value.trim() || null,
      retain,
    })
    scheduleEnabled.value = s.enabled
    scheduleCron.value = s.cron ?? ''
    scheduleRetain.value = s.retain
    notice.value = '定时快照设置已保存'
  } catch (e) {
    scheduleError.value = `保存失败：${e instanceof Error ? e.message : e}`
  } finally {
    scheduleSaving.value = false
  }
}

onMounted(() => {
  void load()
  void loadSchedule()
})
</script>

<template>
  <div class="page">
    <PageHead title="一键还原" @back="goBack(router, '/settings')">
      <template #right>
        <button class="icon-btn" aria-label="刷新" @click="load"><CoomiIcon name="refresh" :size="17" /></button>
      </template>
    </PageHead>
    <main class="body">
      <p class="scope-note">快照由引擎按轮次 / 会话自动创建，也可手动备份；还原前引擎会自动生成一份「还原前备份」快照。</p>

      <!-- 还原报告 -->
      <section v-if="report" class="report-card">
        <div class="report-head">
          <span class="report-title">还原完成</span>
          <button class="icon-btn" aria-label="关闭" @click="report = null"><CoomiIcon name="close" :size="15" /></button>
        </div>
        <div class="report-grid">
          <div class="report-item">
            <span class="report-num">{{ report.reverted_files }}</span>
            <span class="report-label">回退文件</span>
          </div>
          <div class="report-item">
            <span class="report-num">{{ report.deleted_untracked }}</span>
            <span class="report-label">删除未跟踪</span>
          </div>
          <div class="report-item wide">
            <span class="report-num mono small">{{ report.backup_snapshot_id }}</span>
            <span class="report-label">备份快照 id</span>
          </div>
        </div>
        <p class="report-sha mono">已还原至 {{ report.restored_to.slice(0, 12) }}…</p>
      </section>

      <p v-if="error" class="notice err">{{ error }}</p>
      <p v-if="notice" class="notice">{{ notice }}</p>

      <!-- 对比两个快照 -->
      <section class="card compare-card">
        <div class="card-head"><span class="card-title">对比两个快照</span></div>
        <div class="compare-form">
          <select v-model="compareFrom" class="sel" aria-label="起始快照">
            <option value="" disabled>起始快照</option>
            <option v-for="s in snapshots" :key="s.id" :value="s.id">{{ s.summary || s.id }} · {{ fmtTime(s.created_at) }}</option>
          </select>
          <CoomiIcon name="arrowRight" :size="15" class="arrow" />
          <select v-model="compareTo" class="sel" aria-label="目标快照">
            <option value="" disabled>目标快照</option>
            <option v-for="s in snapshots" :key="s.id" :value="s.id">{{ s.summary || s.id }} · {{ fmtTime(s.created_at) }}</option>
          </select>
          <button class="btn btn-primary" :disabled="compareBusy || !compareFrom || !compareTo || compareFrom === compareTo" @click="doCompare">
            {{ compareBusy ? '对比中…' : '对比' }}
          </button>
        </div>
        <div v-if="compareError" class="compare-result"><p class="notice err">{{ compareError }}</p></div>
        <div v-else-if="compareResult" class="compare-result">
          <pre v-if="compareResult.stat" class="diff-pre stat-pre"><span v-for="(l, i) in splitDiffLines(compareResult.stat)" :key="'st' + i" class="dl-plain">{{ l.text }}</span></pre>
          <pre class="diff-pre"><template v-for="(l, i) in splitDiffLines(compareResult.diff)" :key="'d' + i"><span :class="'dl-' + l.kind">{{ l.text }}</span></template></pre>
          <p v-if="compareResult.truncated" class="hint dim">diff 过长，已截断显示。</p>
        </div>
      </section>

      <!-- 定时快照设置 -->
      <section class="card">
        <div class="card-head">
          <span class="card-title">定时快照</span>
          <span v-if="scheduleLoading" class="card-side">加载中…</span>
          <span v-else class="card-side">{{ scheduleEnabled ? '已启用' : '未启用' }}</span>
        </div>
        <div class="sched-row">
          <span>启用定时快照</span>
          <button class="switch" :class="{ on: scheduleEnabled }" :disabled="scheduleLoading || scheduleSaving" @click="scheduleEnabled = !scheduleEnabled"><i /></button>
        </div>
        <div class="sched-form">
          <input v-model="scheduleCron" class="text-input mono" placeholder="cron 表达式，如 0 3 * * *（每天 3 点）" @keyup.enter="saveSchedule" />
        </div>
        <div class="sched-form">
          <input v-model.number="scheduleRetain" class="text-input num-input" type="number" min="1" max="200" placeholder="保留快照数量（1-200）" @keyup.enter="saveSchedule" />
          <button class="btn btn-primary" :disabled="scheduleSaving || scheduleLoading" @click="saveSchedule">{{ scheduleSaving ? '保存中…' : '保存设置' }}</button>
        </div>
        <p class="form-note">cron 使用 5 段标准格式（分 时 日 月 周）；启用后引擎按表达式自动创建快照，并仅保留最近 N 份。语法校验由后端完成。</p>
        <p v-if="scheduleError" class="notice err schedule-error">{{ scheduleError }}</p>
      </section>

      <!-- 快照列表 -->
      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="!snapshots.length" class="hint">暂无快照。工作区成为 Git 仓库后，会话 / 轮次会自动创建快照。</p>
      <div v-else class="snap-list">
        <article v-for="s in snapshots" :key="s.id" class="snap" :class="{ locked: s.locked }">
          <button class="snap-main" @click="openPreview(s)">
            <span class="snap-top">
              <span class="kind" :class="kindCls(s.kind)">{{ kindLabel(s.kind) }}</span>
              <CoomiIcon v-if="s.locked" name="pin" :size="13" class="lock-ic" />
              <span class="snap-time">{{ fmtTime(s.created_at) }}</span>
            </span>
            <span class="snap-summary">{{ s.summary || '（无摘要）' }}</span>
            <span class="snap-meta">
              <span>{{ s.file_count }} 个文件</span>
              <span v-if="s.turn !== null">轮次 #{{ s.turn }}</span>
              <span v-if="s.session_id" class="mono">{{ s.session_id.slice(0, 8) }}…</span>
              <span v-if="s.note" class="snap-note">{{ s.note }}</span>
            </span>
            <CoomiIcon class="chev" name="chevronRight" :size="14" />
          </button>
          <div class="snap-actions">
            <button class="mini-btn" @click="openPreview(s)">预览</button>
            <button class="mini-btn" @click="startEditNote(s)">备注</button>
            <button class="mini-btn" @click="toggleLock(s)">{{ s.locked ? '解锁' : '锁定' }}</button>
            <button class="mini-btn danger" @click="requestDelete(s)">删除</button>
          </div>
        </article>
      </div>
    </main>

    <!-- 预览 / 还原 -->
    <div v-if="previewState" class="sheet-mask" @click.self="previewState = null">
      <div class="sheet preview-sheet">
        <div class="preview-head">
          <span class="preview-title">快照预览</span>
          <button class="icon-btn" aria-label="关闭" @click="previewState = null"><CoomiIcon name="close" :size="16" /></button>
        </div>
        <div v-if="previewState.preview" class="sheet-scroll">
          <p class="ps-summary">{{ previewState.preview.snapshot.summary || '（无摘要）' }}</p>
          <p class="ps-meta">创建于 {{ fmtTime(previewState.preview.snapshot.created_at) }} · {{ previewState.preview.snapshot.file_count }} 个文件 · <span class="mono">{{ previewState.preview.snapshot.id }}</span></p>
          <pre v-if="previewState.preview.stat" class="diff-pre stat-pre"><span v-for="(l, i) in splitDiffLines(previewState.preview.stat)" :key="'st' + i" class="dl-plain">{{ l.text }}</span></pre>
          <div v-if="previewState.preview.reverted_files.length" class="warn-block">
            <p class="warn-title">将回退 {{ previewState.preview.reverted_files.length }} 个已跟踪文件</p>
            <p v-for="f in previewState.preview.reverted_files" :key="'r' + f" class="warn-file mono">{{ f }}</p>
          </div>
          <div v-if="previewState.preview.untracked_to_delete.length" class="warn-block del">
            <p class="warn-title">将删除 {{ previewState.preview.untracked_to_delete.length }} 个未跟踪文件</p>
            <p v-for="f in previewState.preview.untracked_to_delete" :key="'d' + f" class="warn-file mono">{{ f }}</p>
          </div>
          <p v-if="!previewState.preview.reverted_files.length && !previewState.preview.untracked_to_delete.length" class="hint">工作区与快照内容一致，还原不会有实际改动。</p>
        </div>
        <div v-else class="sheet-scroll"><p class="hint">预览加载中…</p></div>
        <div class="preview-actions">
          <button class="btn" :disabled="previewState.busy" @click="previewState = null">取消</button>
          <button class="btn btn-danger-solid" :disabled="previewState.busy" @click="confirmRestore">{{ previewState.busy ? '还原中…' : '确认还原' }}</button>
        </div>
      </div>
    </div>

    <!-- 备注编辑 -->
    <div v-if="editing" class="sheet-mask" @click.self="editing = null">
      <div class="sheet compact-sheet">
        <p class="sheet-title">编辑备注</p>
        <input v-model="noteDraft" class="path-input" placeholder="备注内容（可清空）" @keyup.enter="saveNote" />
        <div class="sheet-actions">
          <button class="button ghost" :disabled="noteBusy" @click="editing = null">取消</button>
          <button class="button primary" :disabled="noteBusy" @click="saveNote">{{ noteBusy ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="deleteRequest" class="sheet-mask" @click.self="!deleteBusy && (deleteRequest = null)">
      <div class="sheet compact-sheet">
        <div class="delete-mark"><CoomiIcon name="trash" :size="20" /></div>
        <p class="sheet-title">删除快照？</p>
        <p class="delete-copy">将删除快照「{{ deleteRequest.summary || deleteRequest.id }}」及其 git ref，此操作无法恢复。</p>
        <div class="sheet-actions">
          <button class="button ghost" :disabled="deleteBusy" @click="deleteRequest = null">取消</button>
          <button class="button danger-fill" :disabled="deleteBusy" @click="confirmDelete">{{ deleteBusy ? '删除中…' : '删除' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px calc(var(--safe-bottom) + 24px); }
.scope-note { margin: 2px 2px 10px; padding: 10px 12px; border-left: 3px solid var(--blue); background: var(--blue-soft); color: var(--text-2); font-size: 12.5px; line-height: 1.6; }
.notice { margin: 0 0 10px; padding: 8px 12px; border-radius: var(--r-sm); background: var(--ok-soft); color: var(--ok); font-size: 12.5px; line-height: 1.5; word-break: break-all; }
.notice.err { background: var(--danger-soft); color: var(--danger); }
.hint { padding: 14px 4px; color: var(--text-3); font-size: 12.5px; text-align: center; }
.hint.dim { padding: 4px; font-size: 11.5px; }
.mono { font-family: var(--font-mono); }

/* ── 还原报告 ── */
.report-card { margin-bottom: 10px; padding: 12px 13px; border-radius: var(--r-card); background: var(--ok-soft); }
.report-head { display: flex; align-items: center; justify-content: space-between; }
.report-title { font-size: 14px; font-weight: 650; color: var(--ok); }
.report-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.report-item { display: flex; flex-direction: column; gap: 2px; padding: 9px 10px; border-radius: var(--r-sm); background: var(--bg); }
.report-item.wide { grid-column: 1 / -1; }
.report-num { font-size: 19px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.report-num.small { font-size: 13px; word-break: break-all; }
.report-label { font-size: 11px; color: var(--text-3); }
.report-sha { margin: 8px 2px 0; font-size: 11.5px; color: var(--ok); }

/* ── 卡片 ── */
.card { margin-bottom: 10px; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.card-head { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 8px 13px; border-bottom: 1px solid var(--border); }
.card-title { font-size: 13.5px; font-weight: 650; color: var(--text); }

/* ── 对比 ── */
.compare-form { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 10px 13px; }
.sel { flex: 1; min-width: 0; min-height: 38px; padding: 0 9px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg-input); color: var(--text); font-size: 12px; }
.arrow { flex-shrink: 0; color: var(--text-3); }
.compare-form .btn { min-height: 38px; padding: 0 15px; font-size: 13px; }
.compare-result { padding: 0 13px 12px; }

/* ── 定时快照设置 ── */
.sched-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 12px 13px 2px; font-size: 12.5px; color: var(--text-2); }
.switch { width: 42px; height: 24px; border-radius: 12px; border: 0; position: relative; background: var(--fill-strong, #c9cfdd); cursor: pointer; transition: background .18s; flex-shrink: 0; }
.switch i { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .18s; box-shadow: 0 1px 3px rgba(0, 0, 0, .2); }
.switch.on { background: var(--blue); }
.switch.on i { left: 20px; }
.switch:disabled { opacity: .5; }
.sched-form { display: flex; gap: 7px; flex-wrap: wrap; padding: 10px 13px; border-top: 1px solid var(--border); }
.sched-row + .sched-form { border-top: none; }
.sched-form .btn { min-height: 38px; padding: 0 15px; font-size: 13px; }
.text-input { flex: 1; min-width: 120px; min-height: 38px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg-input); color: var(--text); font-size: 12.5px; }
.num-input { max-width: 190px; }
.form-note { margin: 0; padding: 0 13px 12px; font-size: 11.5px; color: var(--text-3); line-height: 1.6; }
.schedule-error { margin: 0 13px 12px; }

/* ── diff 渲染 ── */
.diff-pre { margin: 0 0 6px; padding: 9px 10px; border-radius: var(--r-sm); background: var(--code-bg); color: var(--code-text); font-family: var(--font-mono); font-size: 11.6px; line-height: 1.5; overflow-x: auto; white-space: pre; -webkit-overflow-scrolling: touch; }
.diff-pre:last-child { margin-bottom: 0; }
.diff-pre span { display: block; }
.stat-pre { color: var(--text-2); }
.dl-add { background: color-mix(in srgb, var(--ok) 13%, transparent); }
.dl-del { background: color-mix(in srgb, var(--danger) 13%, transparent); }
.dl-hunk { background: var(--blue-soft); color: var(--blue); }
.dl-meta { color: var(--text-3); }
.dl-plain { color: var(--code-text); }

/* ── 快照列表 ── */
.snap-list { display: flex; flex-direction: column; gap: 8px; }
.snap { border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.snap-main { display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 12px 13px; text-align: left; }
.snap-top { display: flex; align-items: center; gap: 7px; }
.kind { padding: 2px 8px; border-radius: var(--r-pill); font-size: 10.5px; font-weight: 600; }
.kind.turn { background: var(--blue-soft); color: var(--blue); }
.kind.session { background: var(--ok-soft); color: var(--ok); }
.kind.manual { background: var(--orange-soft); color: var(--orange); }
.kind.pre { background: var(--warn-soft); color: var(--warn); }
.kind.other { background: var(--fill-strong); color: var(--text-2); }
.lock-ic { color: var(--warn); }
.snap-time { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.snap-summary { color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.45; word-break: break-word; }
.snap-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--text-3); font-size: 11.5px; }
.snap-note { max-width: 100%; overflow: hidden; color: var(--warn); text-overflow: ellipsis; white-space: nowrap; }
.chev { position: absolute; right: 13px; top: 13px; color: var(--text-3); }
.snap-main { position: relative; padding-right: 34px; }
.snap-actions { display: flex; gap: 6px; padding: 7px 10px 10px; border-top: 1px solid var(--border); }
.mini-btn { min-height: 26px; padding: 0 10px; border-radius: 6px; background: var(--fill-strong); color: var(--text-2); font-size: 11px; }
.mini-btn:active { background: var(--fill-press); }
.mini-btn.danger { color: var(--danger); background: var(--danger-soft); }

/* ── Sheet ── */
.sheet-mask { position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-end; background: rgba(0, 0, 0, .42); }
.sheet { width: 100%; padding: 18px 16px calc(16px + var(--safe-bottom)); border-radius: 16px 16px 0 0; background: var(--bg-card); }
.compact-sheet { max-width: 560px; margin: 0 auto; }
.sheet-title { margin: 0 0 12px; color: var(--text); font-size: 16px; font-weight: 650; }
.path-input { width: 100%; min-height: 44px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg-input); color: var(--text); font-size: 14px; }
.sheet-actions { display: flex; gap: 10px; margin-top: 16px; }
.sheet-actions .button { flex: 1; }
.button { min-height: 40px; padding: 0 14px; border-radius: var(--r-sm); }
.button.primary { background: var(--blue); color: #fff; }
.button.ghost { background: var(--fill-strong); color: var(--text); }
.button.danger-fill { background: var(--danger); color: #fff; }
.delete-mark { display: grid; place-items: center; width: 42px; height: 42px; margin-bottom: 10px; border-radius: 50%; background: var(--danger-soft); color: var(--danger); }
.delete-copy { margin: 6px 0 0; color: var(--text-3); font-size: 13px; line-height: 1.65; word-break: break-all; }

/* ── 预览 Sheet ── */
.preview-sheet { max-width: 640px; margin: 0 auto; height: 78vh; display: flex; flex-direction: column; }
.preview-head { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
.preview-title { flex: 1; min-width: 0; overflow: hidden; color: var(--text); font-size: 15px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.sheet-scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.ps-summary { margin: 0 0 3px; color: var(--text); font-size: 14px; font-weight: 600; word-break: break-word; }
.ps-meta { margin: 0 0 10px; color: var(--text-3); font-size: 11.5px; line-height: 1.6; word-break: break-all; }
.warn-block { margin-top: 8px; padding: 9px 11px; border-radius: var(--r-sm); background: var(--danger-soft); }
.warn-block.del { background: var(--warn-soft); }
.warn-title { margin: 0 0 5px; font-size: 12.5px; font-weight: 650; color: var(--danger); }
.warn-block.del .warn-title { color: var(--warn); }
.warn-file { margin: 2px 0; font-size: 11.6px; color: var(--text-2); line-height: 1.5; word-break: break-all; }
.preview-actions { display: flex; gap: 10px; padding-top: 12px; }
.preview-actions .btn { flex: 1; min-height: 42px; }
.btn-danger-solid { background: var(--danger); color: #fff; }
</style>
