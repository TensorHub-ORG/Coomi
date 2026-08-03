<script setup lang="ts">
/**
 * 文件管理器：浏览 Termux 独立环境的目录，支持新建/重命名/删除/复制/粘贴/
 * 复制路径/打开（内置预览与外部 app 打开）/设为会话目录。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { authedFetch, engineToken } from '@/bridge/http'

const router = useRouter()
const session = useSessionStore()

interface Entry { name: string; is_dir: boolean; size: number; modified: number }

const HOME = '/data/user/0/com.coomi.android/files'
const path = ref(HOME)
const entries = ref<Entry[]>([])
const loading = ref(true)
const error = ref('')
const notice = ref('')
const selected = ref<Entry | null>(null)
const clip = ref<string[]>([]) // 剪贴板（复制/剪切队列）
const clipMode = ref<'copy' | 'move'>('copy')

const parentPath = computed(() => {
  const p = path.value.replace(/\/+$/, '')
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
})
const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean)
  const out: { label: string; path: string }[] = []
  let acc = ''
  for (const part of parts) { acc += '/' + part; out.push({ label: part, path: acc }) }
  return out
})

async function api(method: string, url: string, body?: unknown): Promise<any> {
  const res = await authedFetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // 无权限目录（应用私有目录之上）明确提示「禁止访问」。
    if (res.status === 403) throw new Error('禁止访问')
    throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`)
  }
  return data
}

async function load(dir: string) {
  loading.value = true
  error.value = ''
  try {
    const data = await api('GET', '/api/fs/list?path=' + encodeURIComponent(dir))
    path.value = data.path
    entries.value = data.entries ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function open(entry: Entry) {
  if (entry.is_dir) { selected.value = null; void load(path.value.replace(/\/+$/, '') + '/' + entry.name) }
  else { selected.value = entry; previewOpen.value = true }
}

function fmtSize(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + 'G'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + 'M'
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + 'k'
  return String(n)
}

function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ── 操作 ──
const renaming = ref<Entry | null>(null)
const creating = ref<'dir' | 'file' | null>(null)
const inputValue = ref('')

function startRename(e: Entry) { renaming.value = e; inputValue.value = e.name; inputMode.value = 'rename' }
function startCreate(kind: 'dir' | 'file') { creating.value = kind; inputValue.value = ''; inputMode.value = 'create' }

const inputMode = ref<'none' | 'rename' | 'create'>('none')

function commitInput() {
  const name = inputValue.value.trim()
  if (inputMode.value === 'rename') void commitRename(name)
  else void commitCreate(name)
}

async function commitRename(name: string) {
  const target = renaming.value
  if (!target || !name) { inputMode.value = 'none'; return }
  try {
    await api('POST', '/api/fs/rename', { from: path.value + '/' + target.name, to: path.value + '/' + name })
    notice.value = '已重命名'
    inputMode.value = 'none'
    await load(path.value)
  } catch (e) { notice.value = `重命名失败：${e instanceof Error ? e.message : e}` }
}

async function commitCreate(name: string) {
  const kind = creating.value
  if (!name || !kind) { inputMode.value = 'none'; return }
  try {
    if (kind === 'dir') await api('POST', '/api/fs/mkdir', { path: path.value + '/' + name })
    else await api('POST', '/api/fs/write', { path: path.value + '/' + name, content: '' })
    notice.value = kind === 'dir' ? '已新建文件夹' : '已新建文件'
    inputMode.value = 'none'
    await load(path.value)
  } catch (e) { notice.value = `新建失败：${e instanceof Error ? e.message : e}` }
}

async function remove(e: Entry) {
  if (!confirm(`确定删除「${e.name}」？${e.is_dir ? '文件夹内容将一并删除。' : ''}`)) return
  try {
    await api('POST', '/api/fs/delete', { path: path.value + '/' + e.name })
    notice.value = '已删除'
    await load(path.value)
  } catch (err) { notice.value = `删除失败：${err instanceof Error ? err.message : err}` }
}

function copy(e: Entry, mode: 'copy' | 'move') {
  clip.value = [path.value + '/' + e.name]
  clipMode.value = mode
  notice.value = `${mode === 'copy' ? '已复制' : '已剪切'}：${e.name}`
}

function copyPath(e: Entry) {
  const full = path.value + '/' + e.name
  void navigator.clipboard?.writeText(full).catch(() => {})
  notice.value = '已复制路径：' + full
}

async function paste() {
  if (clip.value.length === 0) { notice.value = '剪贴板为空'; return }
  try {
    for (const from of clip.value) {
      const name = from.split('/').pop() || 'item'
      const to = path.value + '/' + name
      if (clipMode.value === 'copy') await api('POST', '/api/fs/copy', { from, to })
      else await api('POST', '/api/fs/rename', { from, to })
    }
    notice.value = `已${clipMode.value === 'copy' ? '粘贴' : '移动'} ${clip.value.length} 项`
    clip.value = []
    await load(path.value)
  } catch (e) { notice.value = `粘贴失败：${e instanceof Error ? e.message : e}` }
}

// ── 预览（图片 / 文本 / 其它）──
const previewOpen = ref(false)
const previewSrc = computed(() => selected.value
  ? '/api/fs/raw?path=' + encodeURIComponent(path.value + '/' + selected.value.name)
    + '&token=' + encodeURIComponent(engineToken())
  : '')
const previewText = ref('')
async function openPreview() {
  const e = selected.value
  if (!e) return
  previewOpen.value = true
  previewText.value = ''
  if (isTextFile(e.name)) {
    try {
      const res = await authedFetch(previewSrc.value)
      previewText.value = (await res.text()).slice(0, 200000)
    } catch { previewText.value = '（无法读取）' }
  }
}
function isTextFile(name: string): boolean {
  return /\.(txt|md|json|log|sh|py|rs|js|ts|vue|toml|yaml|yml|conf|ini|env|html|css|xml)$/i.test(name)
}
function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
}
function openExternal() {
  if (selected.value) window.CoomiAndroid?.openFile?.(path.value + '/' + selected.value.name)
}

function setAsSessionDir() {
  void session.setSessionCwd(path.value)
  notice.value = '已设为当前会话目录'
}

onMounted(() => void load(path.value))
// 从控制台进入：返回统一回控制台（浏览器环境回聊天主页）
function goDashboard() {
  if (window.CoomiAndroid?.openDashboard) window.CoomiAndroid.openDashboard()
  else router.push('/')
}
</script>

<template>
  <div class="page">
    <PageHead title="文件管理" @back="goDashboard" />
    <main class="body">
      <!-- 路径导航 -->
      <div class="crumbs">
        <button class="crumb" @click="load('/')">/</button>
        <template v-for="c in crumbs" :key="c.path">
          <span class="sep">/</span>
          <button class="crumb" :class="{ cur: c.path === path }" @click="load(c.path)">{{ c.label }}</button>
        </template>
      </div>

      <p v-if="notice" class="notice">{{ notice }}</p>
      <p v-if="error" class="notice err">{{ error === '禁止访问' ? '禁止访问' : `加载失败：${error}` }}</p>

      <!-- 工具条 -->
      <div class="toolbar">
        <button class="tbtn" @click="load(parentPath)" :disabled="path === '/'">
          <CoomiIcon name="chevronLeft" :size="15" /><span>上一级</span>
        </button>
        <button class="tbtn" @click="startCreate('dir')"><CoomiIcon name="plus" :size="15" /><span>新建文件夹</span></button>
        <button class="tbtn" @click="startCreate('file')"><CoomiIcon name="plus" :size="15" /><span>新建文件</span></button>
        <button class="tbtn" @click="paste" :disabled="clip.length === 0"><CoomiIcon name="paste" :size="15" /><span>粘贴{{ clip.length ? `(${clip.length})` : '' }}</span></button>
        <button class="tbtn" @click="setAsSessionDir"><CoomiIcon name="target" :size="15" /><span>设为会话目录</span></button>
      </div>

      <!-- 列表 -->
      <div v-if="loading" class="hint">加载中…</div>
      <div v-else-if="entries.length === 0" class="empty">空目录</div>
      <div v-else class="file-list">
        <div v-for="e in entries" :key="e.name" class="file-row" :class="{ sel: selected?.name === e.name }" @click="open(e)">
          <CoomiIcon :name="e.is_dir ? 'folder' : 'fileRead'" :size="18" class="ficon" />
          <span class="fname" :class="{ mono: !e.is_dir }">{{ e.name }}</span>
          <span class="fmeta">{{ e.is_dir ? '' : fmtSize(e.size) }} {{ fmtTime(e.modified) }}</span>
        </div>
      </div>

      <!-- 选中项操作条 -->
      <div v-if="selected" class="opbar">
        <span class="opname">{{ selected.name }}</span>
        <button class="tbtn" @click="openPreview"><CoomiIcon name="eye" :size="15" /><span>预览</span></button>
        <button class="tbtn" @click="openExternal"><CoomiIcon name="external" :size="15" /><span>外部打开</span></button>
        <button class="tbtn" @click="copy(selected, 'copy')"><CoomiIcon name="copy" :size="15" /><span>复制</span></button>
        <button class="tbtn" @click="copy(selected, 'move')"><CoomiIcon name="scissors" :size="15" /><span>剪切</span></button>
        <button class="tbtn" @click="startRename(selected)"><CoomiIcon name="pencil" :size="15" /><span>重命名</span></button>
        <button class="tbtn" @click="copyPath(selected)"><CoomiIcon name="link" :size="15" /><span>复制路径</span></button>
        <button class="tbtn danger" @click="remove(selected)"><CoomiIcon name="trash" :size="15" /><span>删除</span></button>
      </div>

      <!-- 输入弹层：新建 / 重命名 -->
      <div v-if="inputMode !== 'none'" class="sheet-mask" @click.self="inputMode = 'none'">
        <div class="sheet">
          <p class="sheet-title">{{ inputMode === 'rename' ? '重命名' : creating === 'dir' ? '新建文件夹' : '新建文件' }}</p>
          <input v-model="inputValue" class="path-input" placeholder="名称" autofocus @keyup.enter="commitInput" />
          <div class="sheet-actions">
            <button class="btn ghost" @click="inputMode = 'none'">取消</button>
            <button class="btn primary" @click="commitInput">确定</button>
          </div>
        </div>
      </div>

      <!-- 预览 -->
      <div v-if="previewOpen && selected" class="sheet-mask" @click.self="previewOpen = false">
        <div class="sheet preview">
          <div class="pv-head">
            <span class="pv-name">{{ selected.name }}</span>
            <div class="pv-actions">
              <button class="tbtn" @click="openExternal"><CoomiIcon name="external" :size="14" /><span>外部打开</span></button>
              <button class="tbtn" @click="copyPath(selected)"><CoomiIcon name="link" :size="14" /><span>复制路径</span></button>
              <button class="tbtn" @click="previewOpen = false"><CoomiIcon name="close" :size="14" /><span>关闭</span></button>
            </div>
          </div>
          <div class="pv-body">
            <img v-if="isImage(selected.name)" :src="previewSrc" class="pv-img" alt="" />
            <pre v-else-if="isTextFile(selected.name)" class="pv-text">{{ previewText }}</pre>
            <div v-else class="pv-other">
              <p>该类型无法内联预览。</p>
              <button class="btn primary" @click="openExternal">用其它应用打开</button>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); }
.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; margin-bottom: 10px; }
.crumb {
  padding: 5px 6px; border-radius: var(--r-sm); font-size: 13px; color: var(--blue);
  max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.crumb.cur { color: var(--text-2); font-weight: 600; }
.sep { color: var(--text-3); font-size: 12px; }
.notice { margin: 0 0 10px; padding: 8px 12px; border-radius: var(--r-sm); background: var(--ok-soft); color: var(--ok); font-size: 12.5px; }
.notice.err { background: var(--danger-soft); color: var(--danger); }
.hint { color: var(--text-3); font-size: 13px; padding: 12px 0; }
.empty { color: var(--text-3); font-size: 13px; padding: 24px 0; text-align: center; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.tbtn {
  display: inline-flex; align-items: center; gap: 5px;
  min-height: 34px; padding: 0 11px; border-radius: var(--r-sm);
  background: var(--fill-strong); color: var(--text-2); font-size: 12.5px; font-weight: 550;
}
.tbtn:disabled { opacity: 0.4; }
.tbtn.danger { color: var(--danger); background: var(--danger-soft); }
.file-list { display: flex; flex-direction: column; gap: 2px; }
.file-row {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 12px; border-radius: var(--r-md); background: var(--bg-card);
}
.file-row.sel { background: var(--blue-soft); }
.ficon { color: var(--text-3); flex-shrink: 0; }
.file-row.sel .ficon { color: var(--blue); }
.fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; color: var(--text); }
.fname.mono { font-family: var(--font-mono); font-size: 12.5px; }
.fmeta { color: var(--text-3); font-size: 11.5px; flex-shrink: 0; }
.opbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; padding: 10px; border-radius: var(--r-md); background: var(--fill-strong); }
.opname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--text-2); }
.sheet-mask { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.4); display: flex; align-items: flex-end; }
.sheet { width: 100%; background: var(--bg-card); border-radius: 18px 18px 0 0; padding: 18px 16px calc(16px + var(--safe-bottom)); }
.sheet-title { margin: 0 0 12px; font-size: 16px; font-weight: 650; }
.path-input {
  width: 100%; min-height: 44px; padding: 0 12px;
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  background: var(--bg-input); color: var(--text); font-size: 14px;
}
.sheet-actions { display: flex; gap: 10px; margin-top: 16px; }
.sheet-actions .btn { flex: 1; }
.btn.primary { background: var(--blue); color: #fff; }
.btn.ghost { background: var(--fill-strong); color: var(--text); }
.preview { height: 72vh; display: flex; flex-direction: column; }
.pv-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.pv-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 14px; }
.pv-actions { display: flex; gap: 6px; flex-shrink: 0; }
.pv-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; }
.pv-img { max-width: 100%; max-height: 100%; border-radius: var(--r-sm); }
.pv-text { width: 100%; margin: 0; padding: 10px; background: var(--code-bg); border-radius: var(--r-sm); font-family: var(--font-mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; color: var(--code-text); }
.pv-other { text-align: center; color: var(--text-3); font-size: 13px; padding-top: 40px; }
.pv-other .btn { margin-top: 12px; }
</style>
