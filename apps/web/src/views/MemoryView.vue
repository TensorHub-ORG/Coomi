<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { authedFetch } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'

type Scope = 'local' | 'project' | 'global'
type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
interface MemoryItem {
  name: string
  description: string
  content: string
  scope: Scope
  type: MemoryType
  lifecycle: 'candidate' | 'stable' | 'core'
  hit_count: number
  last_triggered: string | null
}

const router = useRouter()
const memories = ref<MemoryItem[]>([])
const editing = ref<MemoryItem | null>(null)
const editingExisting = ref(false)
const loading = ref(true)
const notice = ref('')
const expanded = ref(new Set<string>())
const pendingDelete = ref<MemoryItem | null>(null)
const deletingName = ref('')

function toggleExpanded(name: string) {
  const next = new Set(expanded.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expanded.value = next
}

async function load() {
  loading.value = true
  try {
    const response = await authedFetch('/api/memory')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    memories.value = (await response.json()).memories ?? []
  } catch (error) {
    notice.value = `加载失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    loading.value = false
  }
}

function createMemory() {
  editingExisting.value = false
  editing.value = {
    name: '', description: '', content: '', scope: 'global', type: 'user',
    lifecycle: 'candidate', hit_count: 0, last_triggered: null,
  }
}

async function save() {
  const item = editing.value
  if (!item || !item.name.trim() || !item.content.trim()) {
    notice.value = '名称和记忆内容不能为空'
    return
  }
  const response = await authedFetch(editingExisting.value ? `/api/memory/${encodeURIComponent(item.name)}` : '/api/memory', {
    method: editingExisting.value ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    notice.value = data.error ?? `保存失败：HTTP ${response.status}`
    return
  }
  editing.value = null
  notice.value = '已保存'
  await load()
}

function requestRemove(item: MemoryItem) {
  pendingDelete.value = item
}

async function confirmRemove() {
  const item = pendingDelete.value
  if (!item || deletingName.value) return
  deletingName.value = item.name
  const response = await authedFetch(`/api/memory/${encodeURIComponent(item.name)}`, { method: 'DELETE' })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    notice.value = data.error ?? `删除失败：HTTP ${response.status}`
    deletingName.value = ''
    return
  }
  const data = await response.json().catch(() => ({ deleted: true }))
  pendingDelete.value = null
  deletingName.value = ''
  if (data.deleted === false) {
    notice.value = '该记忆不存在或已被删除'
    await load()
    return
  }
  if (editing.value?.name === item.name) editing.value = null
  memories.value = memories.value.filter(memory => memory.name !== item.name)
  notice.value = '已删除'
  await load()
}

onMounted(load)
</script>

<template>
  <div class="page">
    <PageHead title="持久记忆" @back="goBack(router, 'dashboard')">
      <template #right>
        <button class="icon-btn" aria-label="新增记忆" @click="createMemory"><CoomiIcon name="plus" /></button>
      </template>
    </PageHead>
    <main class="body">
      <p class="scope-note">这里只管理 Coomi 内建持久记忆，与任何 MCP、Skill 或第三方记忆扩展无关。</p>
      <p v-if="loading" class="empty">加载中…</p>
      <p v-else-if="!memories.length" class="empty">暂无内建持久记忆</p>
      <article v-for="item in memories" :key="item.name" :class="['memory', { expanded: expanded.has(item.name) }]">
        <button class="memory-head" :aria-expanded="expanded.has(item.name)" @click="toggleExpanded(item.name)">
          <div><h2>{{ item.name }}</h2><p class="description">{{ item.description || '无描述' }}</p></div>
          <span :class="['life', item.lifecycle]">{{ item.lifecycle }}</span>
          <CoomiIcon class="chevron" name="chevronDown" :size="17" />
        </button>
        <p :class="['content', { preview: !expanded.has(item.name) }]">{{ item.content }}</p>
        <div v-if="expanded.has(item.name)" class="meta">
          <span>{{ item.scope }}</span><span>命中 {{ item.hit_count }} 次</span>
          <span>{{ item.last_triggered ? `最近 ${new Date(item.last_triggered).toLocaleDateString()}` : '从未命中' }}</span>
        </div>
        <div v-if="expanded.has(item.name)" class="actions">
          <button @click="editing = { ...item }; editingExisting = true"><CoomiIcon name="pencil" :size="15" />编辑</button>
          <button class="danger" :disabled="deletingName === item.name" @click="requestRemove(item)"><CoomiIcon name="trash" :size="15" />删除</button>
        </div>
      </article>
      <p v-if="notice" class="notice">{{ notice }}</p>
    </main>
    <div v-if="editing" class="scrim" @click.self="editing = null">
      <section class="editor" role="dialog" aria-modal="true">
        <div class="editor-head">
          <h2>{{ editingExisting ? '编辑记忆' : '新增记忆' }}</h2>
          <button class="icon-btn" aria-label="关闭" @click="editing = null"><CoomiIcon name="close" /></button>
        </div>
        <label>名称<input v-model="editing.name" :disabled="editingExisting" maxlength="80" placeholder="英文、数字、- 或 _" /></label>
        <label>描述<input v-model="editing.description" maxlength="240" /></label>
        <div class="selects">
          <label>范围<select v-model="editing.scope"><option value="global">全局</option><option value="project">项目</option><option value="local">当前目录</option></select></label>
          <label>类型<select v-model="editing.type"><option value="user">用户偏好</option><option value="feedback">纠正反馈</option><option value="project">项目信息</option><option value="reference">参考信息</option></select></label>
        </div>
        <label>内容<textarea v-model="editing.content" rows="7" /></label>
        <button class="save" @click="save">保存</button>
      </section>
    </div>
    <div v-if="pendingDelete" class="scrim confirm-scrim" @click.self="pendingDelete = null">
      <section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-memory-title">
        <h2 id="delete-memory-title">删除持久记忆</h2>
        <p>确定删除“{{ pendingDelete.name }}”？此操作无法撤销。</p>
        <div class="confirm-actions">
          <button :disabled="!!deletingName" @click="pendingDelete = null">取消</button>
          <button class="confirm-delete" :disabled="!!deletingName" @click="confirmRemove">{{ deletingName ? '删除中…' : '删除' }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; background: var(--page); color: var(--text); }
.body { flex: 1; overflow-y: auto; padding: 12px 12px calc(var(--safe-bottom) + 24px); }
.scope-note { margin: 2px 2px 12px; padding: 10px 12px; border-left: 3px solid var(--blue); background: var(--blue-soft); color: var(--text-2); font-size: 12.5px; line-height: 1.6; }
.empty { padding: 32px 0; text-align: center; color: var(--text-3); }
.memory { margin-bottom: 10px; padding: 13px; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.memory-head { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: start; width: 100%; gap: 10px; text-align: left; }
.memory h2, .editor h2 { font-size: 15px; color: var(--text); }
.memory-head p { margin-top: 3px; font-size: 12px; color: var(--text-3); }
.description { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.memory.expanded .description { overflow: visible; white-space: normal; }
.chevron { align-self: center; color: var(--text-3); transition: transform .16s ease; }
.memory.expanded .chevron { transform: rotate(180deg); }
.life { align-self: flex-start; padding: 3px 7px; border-radius: 4px; background: var(--fill); color: var(--text-2); font-size: 10px; text-transform: uppercase; }
.life.core { background: var(--blue-soft); color: var(--blue); }
.life.stable { color: var(--ok); }
.content { margin-top: 10px; white-space: pre-wrap; font-size: 13px; line-height: 1.65; color: var(--text-2); }
.content.preview { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.meta, .actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 10px; font-size: 11px; color: var(--text-3); }
.actions { justify-content: flex-end; padding-top: 9px; border-top: 1px solid var(--border); }
.actions button { display: flex; align-items: center; gap: 4px; color: var(--blue); }
.actions .danger { color: var(--danger); }
.notice { margin: 10px 2px; color: var(--text-2); font-size: 12.5px; }
.scrim { position: fixed; inset: 0; z-index: 20; display: flex; align-items: flex-end; background: rgba(0,0,0,.45); }
.editor { width: 100%; max-height: 90%; overflow-y: auto; padding: 16px 14px calc(var(--safe-bottom) + 16px); border-radius: 8px 8px 0 0; background: var(--bg); }
.editor-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.editor label { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; font-size: 12px; color: var(--text-2); }
.editor input, .editor select, .editor textarea { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--fill); color: var(--text); font: inherit; }
.editor textarea { resize: vertical; line-height: 1.5; }
.selects { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.save { width: 100%; min-height: 44px; margin-top: 14px; border-radius: var(--r-md); background: var(--blue); color: #fff; font-weight: 650; }
.confirm-scrim { align-items: center; padding: 18px; }
.confirm-dialog { width: 100%; max-width: 360px; margin: auto; padding: 18px; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-2); }
.confirm-dialog h2 { color: var(--text); font-size: 16px; }
.confirm-dialog p { margin-top: 9px; color: var(--text-2); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.confirm-actions button { min-width: 72px; min-height: 40px; padding: 0 14px; border-radius: var(--r-md); background: var(--fill); color: var(--text-2); }
.confirm-actions .confirm-delete { background: var(--danger); color: #fff; }
.confirm-actions button:disabled { opacity: .55; }
</style>
