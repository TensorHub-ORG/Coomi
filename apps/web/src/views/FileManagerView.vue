<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { authedFetch, engineToken } from '@/bridge/http'

interface Entry { name: string; is_dir: boolean; size: number; modified: number }
interface ClipItem { path: string; name: string; isDir: boolean }
type ConflictChoice = 'skip' | 'keep' | 'replace' | 'cancel'

const router = useRouter()
const session = useSessionStore()
const path = ref('/')
const entries = ref<Entry[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')
const expandedName = ref('')
const previewEntry = ref<Entry | null>(null)
const previewOpen = ref(false)
const previewText = ref('')
const selectionActive = ref(false)
const selectedPaths = ref<Set<string>>(new Set())
const clip = ref<ClipItem[]>([])
const clipMode = ref<'copy' | 'move'>('copy')
const pasteBusy = ref(false)

const parentPath = computed(() => {
  const current = cleanPath(path.value)
  const index = current.lastIndexOf('/')
  return index <= 0 ? '/' : current.slice(0, index)
})

const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean)
  const out: { label: string; path: string }[] = []
  let current = ''
  for (const part of parts) { current += '/' + part; out.push({ label: part, path: current }) }
  return out
})

function cleanPath(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

function fullPath(entry: Entry): string {
  return cleanPath(path.value) + '/' + entry.name
}

async function api(method: string, url: string, body?: unknown): Promise<any> {
  const response = await authedFetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 403) throw new Error('禁止访问')
    throw new Error(data.error ?? data.message ?? `HTTP ${response.status}`)
  }
  return data
}

async function load(directory: string) {
  loading.value = true
  error.value = ''
  try {
    const data = await api('GET', '/api/fs/list?path=' + encodeURIComponent(directory))
    path.value = data.path
    entries.value = data.entries ?? []
    closeTransientState()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

function closeTransientState() {
  expandedName.value = ''
  selectionActive.value = false
  selectedPaths.value = new Set()
}

function fmtSize(size: number): string {
  if (size >= 1 << 30) return (size / (1 << 30)).toFixed(1) + 'G'
  if (size >= 1 << 20) return (size / (1 << 20)).toFixed(1) + 'M'
  if (size >= 1 << 10) return (size / (1 << 10)).toFixed(0) + 'k'
  return String(size)
}

function fmtTime(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function isSelected(entry: Entry): boolean { return selectedPaths.value.has(fullPath(entry)) }

function toggleSelected(entry: Entry) {
  const next = new Set(selectedPaths.value)
  const target = fullPath(entry)
  if (next.has(target)) next.delete(target); else next.add(target)
  selectedPaths.value = next
}

function beginSelection(entry?: Entry) {
  selectionActive.value = true
  expandedName.value = ''
  if (entry && !isSelected(entry)) toggleSelected(entry)
}

function cancelSelection() {
  selectionActive.value = false
  selectedPaths.value = new Set()
}

function selectAll() {
  selectedPaths.value = selectedPaths.value.size === entries.value.length
    ? new Set()
    : new Set(entries.value.map(fullPath))
}

function selectedEntries(): Entry[] {
  return entries.value.filter(isSelected)
}

let pressTimer: ReturnType<typeof setTimeout> | null = null
let pressStart = { x: 0, y: 0 }
let suppressClick = false

function onPressStart(event: PointerEvent, entry: Entry) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
  clearPressTimer()
  pressStart = { x: event.clientX, y: event.clientY }
  pressTimer = setTimeout(() => {
    suppressClick = true
    beginSelection(entry)
    navigator.vibrate?.(18)
  }, 450)
}

function onPressMove(event: PointerEvent) {
  if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 8) clearPressTimer()
}

function clearPressTimer() {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = null
}

function onRowClick(entry: Entry) {
  clearPressTimer()
  if (suppressClick) { suppressClick = false; return }
  if (selectionActive.value) { toggleSelected(entry); return }
  if (entry.is_dir) void load(fullPath(entry))
  else void openPreview(entry)
}

function toggleMenu(entry: Entry) {
  if (selectionActive.value) { toggleSelected(entry); return }
  expandedName.value = expandedName.value === entry.name ? '' : entry.name
}

const renaming = ref<Entry | null>(null)
const creating = ref<'dir' | 'file' | null>(null)
const inputValue = ref('')
const inputMode = ref<'none' | 'rename' | 'create'>('none')

function startRename(entry: Entry) {
  expandedName.value = ''
  renaming.value = entry
  inputValue.value = entry.name
  inputMode.value = 'rename'
}

function startCreate(kind: 'dir' | 'file') {
  creating.value = kind
  inputValue.value = ''
  inputMode.value = 'create'
}

function commitInput() {
  const name = inputValue.value.trim()
  if (inputMode.value === 'rename') void commitRename(name)
  else void commitCreate(name)
}

async function commitRename(name: string) {
  const target = renaming.value
  if (!target || !name) { inputMode.value = 'none'; return }
  try {
    await api('POST', '/api/fs/rename', { from: fullPath(target), to: cleanPath(path.value) + '/' + name })
    notice.value = '已重命名'
    inputMode.value = 'none'
    await load(path.value)
  } catch (cause) { notice.value = `重命名失败：${cause instanceof Error ? cause.message : cause}` }
}

async function commitCreate(name: string) {
  const kind = creating.value
  if (!name || !kind) { inputMode.value = 'none'; return }
  if (entries.value.some(entry => entry.name === name)) {
    notice.value = `新建失败：已存在“${name}”`
    return
  }
  try {
    const target = cleanPath(path.value) + '/' + name
    if (kind === 'dir') await api('POST', '/api/fs/mkdir', { path: target })
    else await api('POST', '/api/fs/write', { path: target, content: '' })
    notice.value = kind === 'dir' ? '已新建文件夹' : '已新建文件'
    inputMode.value = 'none'
    await load(path.value)
  } catch (cause) { notice.value = `新建失败：${cause instanceof Error ? cause.message : cause}` }
}

async function removeEntries(targets: Entry[]) {
  if (targets.length === 0) return
  deleteRequest.value = [...targets]
}

const deleteRequest = ref<Entry[] | null>(null)
const deleteBusy = ref(false)

async function confirmDelete() {
  const targets = deleteRequest.value ?? []
  if (targets.length === 0 || deleteBusy.value) return
  deleteBusy.value = true
  const directories = targets.filter(item => item.is_dir).length
  const files = targets.length - directories
  let succeeded = 0
  const failures: string[] = []
  for (const entry of targets) {
    try { await api('POST', '/api/fs/delete', { path: fullPath(entry) }); succeeded += 1 }
    catch (cause) { failures.push(`${entry.name}：${cause instanceof Error ? cause.message : cause}`) }
  }
  notice.value = failures.length
    ? `已删除 ${succeeded} 项，${failures.length} 项失败：${failures.join('；')}`
    : `已永久删除 ${succeeded} 项`
  deleteRequest.value = null
  deleteBusy.value = false
  cancelSelection()
  await load(path.value)
}

function placeOnClipboard(targets: Entry[], mode: 'copy' | 'move') {
  if (targets.length === 0) return
  clip.value = targets.map(entry => ({ path: fullPath(entry), name: entry.name, isDir: entry.is_dir }))
  clipMode.value = mode
  notice.value = `已${mode === 'copy' ? '复制' : '剪切'} ${targets.length} 项`
  cancelSelection()
  expandedName.value = ''
}

function copyPath(entry: Entry) {
  const target = fullPath(entry)
  void navigator.clipboard?.writeText(target).catch(() => {})
  notice.value = '已复制路径：' + target
}

interface ConflictRequest {
  name: string
  resolve: (result: { choice: ConflictChoice; applyAll: boolean }) => void
}
const conflictRequest = ref<ConflictRequest | null>(null)
const conflictApplyAll = ref(false)

function askConflict(name: string): Promise<{ choice: ConflictChoice; applyAll: boolean }> {
  conflictApplyAll.value = false
  return new Promise(resolve => { conflictRequest.value = { name, resolve } })
}

function resolveConflict(choice: ConflictChoice) {
  const request = conflictRequest.value
  if (!request) return
  conflictRequest.value = null
  request.resolve({ choice, applyAll: conflictApplyAll.value })
}

function uniqueName(name: string, reserved: Set<string>): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  let index = 2
  let candidate = `${stem} (${index})${extension}`
  while (reserved.has(candidate)) candidate = `${stem} (${++index})${extension}`
  return candidate
}

async function paste() {
  if (clip.value.length === 0 || pasteBusy.value) return
  pasteBusy.value = true
  let conflictChoice: ConflictChoice | null = null
  let succeeded = 0
  const failed: string[] = []
  const moved = new Set<string>()
  const reserved = new Set(entries.value.map(entry => entry.name))
  try {
    for (const item of clip.value) {
      const originalTo = cleanPath(path.value) + '/' + item.name
      if (clipMode.value === 'move' && cleanPath(item.path) === cleanPath(originalTo)) {
        failed.push(`${item.name}：已在当前目录`)
        continue
      }
      if (item.isDir && (cleanPath(path.value) === cleanPath(item.path) || cleanPath(path.value).startsWith(cleanPath(item.path) + '/'))) {
        failed.push(`${item.name}：不能放入自身或子目录`)
        continue
      }
      let choice: ConflictChoice = reserved.has(item.name) ? (conflictChoice ?? 'cancel') : 'keep'
      if (reserved.has(item.name) && !conflictChoice) {
        const decision = await askConflict(item.name)
        choice = decision.choice
        if (decision.applyAll && choice !== 'cancel') conflictChoice = choice
      }
      if (choice === 'cancel') break
      if (choice === 'skip') continue
      const targetName = choice === 'keep' && reserved.has(item.name) ? uniqueName(item.name, reserved) : item.name
      const to = cleanPath(path.value) + '/' + targetName
      try {
        await api('POST', clipMode.value === 'copy' ? '/api/fs/copy' : '/api/fs/rename', {
          from: item.path,
          to,
          replace: choice === 'replace',
        })
        reserved.add(targetName)
        succeeded += 1
        if (clipMode.value === 'move') moved.add(item.path)
      } catch (cause) {
        failed.push(`${item.name}：${cause instanceof Error ? cause.message : cause}`)
      }
    }
    if (clipMode.value === 'move') clip.value = clip.value.filter(item => !moved.has(item.path))
    notice.value = failed.length
      ? `已${clipMode.value === 'copy' ? '复制' : '移动'} ${succeeded} 项，${failed.length} 项未完成：${failed.join('；')}`
      : `已${clipMode.value === 'copy' ? '复制' : '移动'} ${succeeded} 项`
    await load(path.value)
  } finally {
    pasteBusy.value = false
  }
}

const previewSrc = computed(() => previewEntry.value
  ? '/api/fs/raw?path=' + encodeURIComponent(fullPath(previewEntry.value)) + '&token=' + encodeURIComponent(engineToken())
  : '')

async function openPreview(entry: Entry) {
  previewEntry.value = entry
  previewOpen.value = true
  previewText.value = ''
  expandedName.value = ''
  if (isTextFile(entry.name)) {
    try {
      const response = await authedFetch(previewSrc.value)
      previewText.value = (await response.text()).slice(0, 200000)
    } catch { previewText.value = '（无法读取）' }
  }
}

function isTextFile(name: string): boolean { return /\.(txt|md|json|log|sh|py|rs|js|ts|vue|toml|yaml|yml|conf|ini|env|html|css|xml)$/i.test(name) }
function isImage(name: string): boolean { return /\.(png|jpe?g|gif|webp|svg)$/i.test(name) }
function openExternal(entry = previewEntry.value) { if (entry) window.CoomiAndroid?.openFile?.(fullPath(entry)) }

function setAsSessionDir() {
  void session.setSessionCwd(path.value)
  notice.value = '已设为当前会话目录'
}

function goDashboard() {
  if (window.CoomiAndroid?.openDashboard) window.CoomiAndroid.openDashboard()
  else router.push('/')
}

onMounted(async () => {
  try {
    const health = await api('GET', '/api/runtime/health')
    await load(health.home || health.cwd || '/')
  } catch {
    await load(path.value)
  }
})
onBeforeUnmount(clearPressTimer)
</script>

<template>
  <div class="page">
    <PageHead title="文件管理" @back="goDashboard" />
    <main class="body">
      <div class="crumbs">
        <button class="crumb" @click="load('/')">/</button>
        <template v-for="(crumb, index) in crumbs" :key="crumb.path">
          <span class="sep">/</span>
          <button class="crumb" :class="{ cur: crumb.path === path }" @click="load(crumb.path)">{{ crumb.label }}</button>
        </template>
      </div>

      <p v-if="notice" class="notice">{{ notice }}</p>
      <p v-if="error" class="notice err">{{ error === '禁止访问' ? '禁止访问' : `加载失败：${error}` }}</p>

      <div v-if="selectionActive" class="selection-toolbar">
        <button class="icon-btn" title="退出多选" @click="cancelSelection"><CoomiIcon name="close" :size="17" /></button>
        <span class="selection-count">已选 {{ selectedPaths.size }} 项</span>
        <button class="tool-action" @click="selectAll"><CoomiIcon name="check" :size="15" /><span>{{ selectedPaths.size === entries.length ? '取消全选' : '全选' }}</span></button>
        <button class="tool-action" :disabled="selectedPaths.size === 0" @click="placeOnClipboard(selectedEntries(), 'copy')"><CoomiIcon name="copy" :size="15" /><span>复制</span></button>
        <button class="tool-action" :disabled="selectedPaths.size === 0" @click="placeOnClipboard(selectedEntries(), 'move')"><CoomiIcon name="scissors" :size="15" /><span>剪切</span></button>
        <button class="tool-action danger" :disabled="selectedPaths.size === 0" @click="removeEntries(selectedEntries())"><CoomiIcon name="trash" :size="15" /><span>删除</span></button>
      </div>
      <div v-else class="toolbar">
        <button class="tool-action" @click="load(parentPath)" :disabled="path === '/'"><CoomiIcon name="chevronLeft" :size="15" /><span>上一级</span></button>
        <button class="tool-action" @click="startCreate('dir')"><CoomiIcon name="plus" :size="15" /><span>文件夹</span></button>
        <button class="tool-action" @click="startCreate('file')"><CoomiIcon name="fileWrite" :size="15" /><span>文件</span></button>
        <button class="tool-action" @click="paste" :disabled="clip.length === 0 || pasteBusy"><CoomiIcon name="paste" :size="15" /><span>粘贴{{ clip.length ? `(${clip.length})` : '' }}</span></button>
        <button class="tool-action" @click="beginSelection()"><CoomiIcon name="check" :size="15" /><span>选择</span></button>
        <button class="tool-action" @click="setAsSessionDir"><CoomiIcon name="target" :size="15" /><span>会话目录</span></button>
      </div>

      <div v-if="loading" class="hint">加载中…</div>
      <div v-else-if="entries.length === 0" class="empty">空目录</div>
      <div v-else class="file-list">
        <div v-for="entry in entries" :key="entry.name" class="file-item">
          <div
            class="file-row"
            :class="{ selected: isSelected(entry), expanded: expandedName === entry.name }"
            @pointerdown="onPressStart($event, entry)"
            @pointermove="onPressMove"
            @pointerup="clearPressTimer"
            @pointercancel="clearPressTimer"
            @click="onRowClick(entry)"
          >
            <span v-if="selectionActive" class="selection-mark" :class="{ on: isSelected(entry) }"><CoomiIcon v-if="isSelected(entry)" name="check" :size="13" /></span>
            <CoomiIcon :name="entry.is_dir ? 'folder' : 'fileRead'" :size="19" class="file-icon" />
            <span class="file-name" :class="{ mono: !entry.is_dir }">{{ entry.name }}</span>
            <span class="file-meta">{{ entry.is_dir ? '' : fmtSize(entry.size) }} {{ fmtTime(entry.modified) }}</span>
            <button v-if="!selectionActive" class="more-btn" :title="`${entry.name} 操作`" @click.stop="toggleMenu(entry)"><CoomiIcon name="moreVertical" :size="18" /></button>
          </div>
          <div v-if="expandedName === entry.name && !selectionActive" class="inline-actions">
            <button v-if="!entry.is_dir" @click="openPreview(entry)"><CoomiIcon name="eye" :size="15" /><span>预览</span></button>
            <button v-if="!entry.is_dir" @click="openExternal(entry)"><CoomiIcon name="external" :size="15" /><span>打开</span></button>
            <button @click="startRename(entry)"><CoomiIcon name="pencil" :size="15" /><span>重命名</span></button>
            <button @click="placeOnClipboard([entry], 'move')"><CoomiIcon name="scissors" :size="15" /><span>剪切</span></button>
            <button @click="placeOnClipboard([entry], 'copy')"><CoomiIcon name="copy" :size="15" /><span>复制</span></button>
            <button @click="copyPath(entry)"><CoomiIcon name="link" :size="15" /><span>路径</span></button>
            <button class="danger" @click="removeEntries([entry])"><CoomiIcon name="trash" :size="15" /><span>删除</span></button>
          </div>
        </div>
      </div>

      <div v-if="inputMode !== 'none'" class="sheet-mask" @click.self="inputMode = 'none'">
        <div class="sheet compact-sheet">
          <p class="sheet-title">{{ inputMode === 'rename' ? '重命名' : creating === 'dir' ? '新建文件夹' : '新建文件' }}</p>
          <input v-model="inputValue" class="path-input" placeholder="名称" autofocus @keyup.enter="commitInput" />
          <div class="sheet-actions"><button class="button ghost" @click="inputMode = 'none'">取消</button><button class="button primary" @click="commitInput">确定</button></div>
        </div>
      </div>

      <div v-if="deleteRequest" class="sheet-mask" @click.self="!deleteBusy && (deleteRequest = null)">
        <div class="sheet compact-sheet" role="alertdialog" aria-modal="true" aria-label="确认永久删除">
          <div class="delete-mark"><CoomiIcon name="trash" :size="20" /></div>
          <p class="sheet-title">永久删除所选内容？</p>
          <p class="delete-copy">
            将删除 {{ deleteRequest.filter(item => !item.is_dir).length }} 个文件和
            {{ deleteRequest.filter(item => item.is_dir).length }} 个文件夹。文件夹内的全部内容也会被删除，此操作无法恢复。
          </p>
          <div class="sheet-actions">
            <button class="button ghost" :disabled="deleteBusy" @click="deleteRequest = null">取消</button>
            <button class="button danger-fill" :disabled="deleteBusy" @click="confirmDelete">{{ deleteBusy ? '删除中…' : '永久删除' }}</button>
          </div>
        </div>
      </div>

      <div v-if="conflictRequest" class="sheet-mask" @click.self="resolveConflict('cancel')">
        <div class="sheet compact-sheet">
          <p class="sheet-title">存在同名项目</p>
          <p class="conflict-name">{{ conflictRequest.name }}</p>
          <label class="apply-all"><input v-model="conflictApplyAll" type="checkbox" />应用到本次全部冲突</label>
          <div class="conflict-actions">
            <button @click="resolveConflict('skip')">跳过</button>
            <button @click="resolveConflict('keep')">保留两份</button>
            <button class="danger" @click="resolveConflict('replace')">完整覆盖</button>
          </div>
          <button class="cancel-conflict" @click="resolveConflict('cancel')">取消本次粘贴</button>
        </div>
      </div>

      <div v-if="previewOpen && previewEntry" class="sheet-mask" @click.self="previewOpen = false">
        <div class="sheet preview-sheet">
          <div class="preview-head">
            <span class="preview-name">{{ previewEntry.name }}</span>
            <button class="icon-btn" title="外部打开" @click="openExternal()"><CoomiIcon name="external" :size="15" /></button>
            <button class="icon-btn" title="关闭" @click="previewOpen = false"><CoomiIcon name="close" :size="15" /></button>
          </div>
          <div class="preview-body">
            <img v-if="isImage(previewEntry.name)" :src="previewSrc" class="preview-image" alt="" />
            <pre v-else-if="isTextFile(previewEntry.name)" class="preview-text">{{ previewText }}</pre>
            <div v-else class="preview-other"><p>该类型无法内联预览。</p><button class="button primary" @click="openExternal()">用其它应用打开</button></div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px calc(var(--safe-bottom) + 24px); }
.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; margin-bottom: 10px; }
.crumb { max-width: 180px; padding: 5px 6px; overflow: hidden; border-radius: var(--r-sm); color: var(--blue); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.crumb.cur { color: var(--text-2); font-weight: 600; }
.sep { color: var(--text-3); font-size: 12px; }
.notice { margin: 0 0 10px; padding: 8px 12px; border-radius: var(--r-sm); background: var(--ok-soft); color: var(--ok); font-size: 12.5px; line-height: 1.5; }
.notice.err { background: var(--danger-soft); color: var(--danger); }
.toolbar, .selection-toolbar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 10px; }
.selection-toolbar { position: sticky; top: -12px; z-index: 10; margin-inline: -12px; padding: 10px 12px; background: var(--page); border-bottom: 1px solid var(--border); }
.selection-count { flex: 1; min-width: 72px; color: var(--text); font-size: 13px; font-weight: 600; }
.tool-action, .icon-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 34px; padding: 0 10px; border-radius: var(--r-sm); background: var(--fill-strong); color: var(--text-2); font-size: 12px; }
.icon-btn { width: 34px; padding: 0; }
.tool-action:disabled { opacity: .38; }
.tool-action.danger, .inline-actions .danger { color: var(--danger); background: var(--danger-soft); }
.tool-action.pick { color: var(--blue); background: var(--blue-soft); }
.delete-mark { display: grid; place-items: center; width: 42px; height: 42px; margin-bottom: 10px; border-radius: 50%; background: var(--danger-soft); color: var(--danger); }
.delete-copy { margin: 6px 0 0; color: var(--text-3); font-size: 13px; line-height: 1.65; }
.danger-fill { background: var(--danger); color: #fff; }
.hint, .empty { padding: 20px 0; color: var(--text-3); font-size: 13px; text-align: center; }
.file-list { display: flex; flex-direction: column; gap: 3px; }
.file-item { overflow: hidden; border-radius: var(--r-md); background: var(--bg-card); }
.file-row { display: flex; align-items: center; gap: 10px; min-height: 54px; padding: 8px 8px 8px 12px; touch-action: pan-y; }
.file-row.selected { background: var(--blue-soft); }
.file-row.expanded { background: var(--fill); }
.selection-mark { display: grid; place-items: center; width: 20px; height: 20px; flex-shrink: 0; border: 1.5px solid var(--border-strong); border-radius: 50%; color: #fff; }
.selection-mark.on { border-color: var(--blue); background: var(--blue); }
.file-icon { color: var(--text-3); flex-shrink: 0; }
.file-row.selected .file-icon { color: var(--blue); }
.file-name { flex: 1; min-width: 0; overflow: hidden; color: var(--text); font-size: 13.5px; text-overflow: ellipsis; white-space: nowrap; }
.file-name.mono { font-family: var(--font-mono); font-size: 12.5px; }
.file-meta { flex-shrink: 0; color: var(--text-3); font-size: 11px; }
.more-btn { display: grid; place-items: center; width: 38px; height: 38px; flex-shrink: 0; border-radius: var(--r-sm); color: var(--text-3); }
.more-btn:active { background: var(--fill-strong); color: var(--text); }
.inline-actions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding: 8px; border-top: 1px solid var(--border); background: var(--fill); }
.inline-actions button { display: flex; align-items: center; justify-content: center; gap: 4px; min-width: 0; min-height: 36px; padding: 0 6px; border-radius: var(--r-sm); background: var(--bg); color: var(--text-2); font-size: 11.5px; }
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
.conflict-name { margin: -4px 0 14px; overflow: hidden; color: var(--text-2); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.apply-all { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; color: var(--text-2); font-size: 13px; }
.apply-all input { width: 18px; height: 18px; accent-color: var(--blue); }
.conflict-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.conflict-actions button, .cancel-conflict { min-height: 42px; border-radius: var(--r-sm); background: var(--fill-strong); color: var(--text); font-size: 13px; }
.conflict-actions .danger { color: var(--danger); background: var(--danger-soft); }
.cancel-conflict { width: 100%; margin-top: 8px; background: transparent; color: var(--text-3); }
.preview-sheet { height: 74vh; display: flex; flex-direction: column; }
.preview-head { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; }
.preview-name { flex: 1; min-width: 0; overflow: hidden; color: var(--text); font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.preview-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; align-items: center; }
.preview-image { max-width: 100%; max-height: 100%; border-radius: var(--r-sm); }
.preview-text { width: 100%; margin: 0; padding: 10px; border-radius: var(--r-sm); background: var(--code-bg); color: var(--code-text); font-family: var(--font-mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; }
.preview-other { padding-top: 40px; color: var(--text-3); font-size: 13px; text-align: center; }
.preview-other .button { margin-top: 12px; }
@media (max-width: 390px) {
  .inline-actions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .file-meta { display: none; }
  .selection-toolbar .tool-action span { display: none; }
  .selection-toolbar .tool-action { width: 34px; padding: 0; }
}
</style>
