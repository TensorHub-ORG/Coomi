<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { usePromptsStore } from '@/stores/prompts'
import type { SavedPrompt } from '@/utils/promptLibrary'
import CoomiIcon from './CoomiIcon.vue'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })
const emit = defineEmits<{ fill: [text: string] }>()
const prompts = usePromptsStore()
const query = ref(''), category = ref(''), tags = ref('')
const draft = ref<SavedPrompt | null>(null)
const deleting = ref('')
const categories = computed(() => [...new Set(prompts.all.flatMap(p => p.tags))])
const visible = computed(() => prompts.all.filter(p => (!category.value || p.tags.includes(category.value))
  && `${p.title} ${p.content} ${p.tags.join(' ')}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())))
function edit(p?: SavedPrompt) {
  draft.value = p ? { ...p, tags: [...p.tags] } : { id: crypto.randomUUID(), title: '', content: '', tags: [] }
  tags.value = p?.tags.join('，') ?? ''
  deleting.value = ''
  prompts.error = ''
}
onMounted(() => { void prompts.refresh() })
async function save() {
  if (!draft.value) return
  const editing = draft.value
  const entry = { ...draft.value, tags: tags.value.split(/[,，\n]/), id: draft.value.id.startsWith('builtin:') ? crypto.randomUUID() : draft.value.id }
  if (await prompts.save(entry) && draft.value === editing) { draft.value = null; category.value = '' }
}
async function remove(id: string) { if (await prompts.remove(id)) deleting.value = '' }
</script>
<template>
  <section class="prompt-library" :class="{ embedded: props.embedded }" aria-label="常用提示词指令">
    <form v-if="draft" class="editor" @submit.prevent="save">
      <div class="editor-heading"><strong>{{ draft.id.startsWith('builtin:') ? '编辑并另存为自定义' : '编辑提示词' }}</strong><button type="button" aria-label="取消编辑" @click="draft = null"><CoomiIcon name="close" :size="17" /></button></div>
      <label>名称<input v-model="draft.title" :disabled="prompts.busy" required maxlength="80" placeholder="给提示词起个名字" /></label>
      <label>分类标签<input v-model="tags" :disabled="prompts.busy" placeholder="如：开发，写作（逗号分隔）" /></label>
      <label>内容<textarea v-model="draft.content" :disabled="prompts.busy" required rows="7" placeholder="填写完整提示词…" /></label>
      <p v-if="prompts.error" class="error" role="alert">{{ prompts.error }}</p>
      <div class="actions"><button type="button" @click="emit('fill', draft.content)" :disabled="!draft.content.trim()">填入输入框</button><button class="primary" type="submit" :disabled="prompts.busy">{{ prompts.busy ? '保存中…' : '保存' }}</button></div>
    </form>
    <template v-else>
      <div class="toolbar"><input v-model="query" type="search" aria-label="搜索提示词" placeholder="搜索提示词…" /><button aria-label="新建提示词" @click="edit()"><CoomiIcon name="plus" :size="17" /><span>新建</span></button></div>
      <nav class="categories" aria-label="提示词分类"><button :class="{ selected: !category }" @click="category = ''">全部</button><button v-for="tag in categories" :key="tag" :class="{ selected: category === tag }" @click="category = tag">{{ tag }}</button></nav>
      <p v-if="prompts.error" class="error" role="alert">{{ prompts.error }} <button @click="prompts.refresh()" :disabled="prompts.busy">重试</button></p>
      <p v-if="!visible.length" class="empty">没有匹配的提示词，可新建或切换分类。</p>
      <article v-for="p in visible" :key="p.id" class="prompt-row">
        <div class="prompt-heading"><strong>{{ p.title }}</strong><small>{{ p.id.startsWith('builtin:') ? '内置' : '自定义' }}</small></div>
        <p class="preview">{{ p.content }}</p>
        <div class="row-bottom"><span class="tags">{{ p.tags.join(' · ') }}</span><button class="text-button" @click="edit(p)">编辑</button><button v-if="!p.id.startsWith('builtin:')" class="text-button" @click="deleting = p.id">删除</button><button class="fill" @click="emit('fill', p.content)">填入</button></div>
        <div v-if="deleting === p.id" class="delete-confirm"><span>删除此提示词？</span><button @click="deleting = ''">取消</button><button @click="remove(p.id)" :disabled="prompts.busy">删除</button></div>
      </article>
    </template>
  </section>
</template>
<style scoped>
.prompt-library {
  height: 100%; min-height: 0; overflow: auto;
  padding: 4px clamp(14px, calc((100% - 760px) / 2), 64px) 12px;
  color: var(--text); font-size: 13px; container-type: inline-size;
  scrollbar-gutter: stable;
}
.prompt-library.embedded { padding: 4px 14px 12px; }
.toolbar,.actions,.editor-heading,.row-bottom,.prompt-heading,.delete-confirm { display:flex; align-items:center; gap:8px; }
.toolbar input { flex:1; min-width:0; }
button { display:inline-flex; align-items:center; justify-content:center; gap:4px; min-height:32px; padding:5px 9px; border-radius:var(--r-sm); background:var(--fill); color:var(--text-2); white-space:nowrap; font:inherit; }
button:disabled { opacity:.45; }
input,textarea { width:100%; min-width:0; border:1px solid var(--border); border-radius:var(--r-sm); background:var(--bg-input,var(--fill)); color:var(--text); padding:9px; font:inherit; }
textarea { resize:vertical; min-height:120px; line-height:1.6; }
.categories { display:flex; flex-wrap:wrap; gap:5px; overflow:visible; padding:10px 0; flex-shrink:0; }
.embedded .categories { flex-wrap:nowrap; overflow-x:auto; }
.categories button { border-radius:var(--r-pill); background:transparent; }
.categories .selected,.fill { background:var(--blue-soft); color:var(--blue); }
.prompt-row { border-top:1px solid var(--border); padding:12px 0; }
.prompt-heading strong { flex:1; overflow-wrap:anywhere; font-size:13px; font-weight:600; }
small,.tags { color:var(--text-3); font-size:11px; }
.preview { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden; margin:7px 0; line-height:1.6; color:var(--text-2); overflow-wrap:anywhere; }
.tags { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.row-bottom { flex-wrap:wrap; }
.row-bottom .tags { flex:1 1 90px; }
.text-button { background:transparent; padding:4px; font-size:12px; }
.editor { display:grid; gap:12px; }
.editor-heading strong { flex:1; font-weight:600; }
label { display:grid; gap:6px; color:var(--text-2); }
.actions { justify-content:flex-end; }
.primary { background:var(--blue); color:white; }
.error { color:var(--danger); line-height:1.5; }
.empty { color:var(--text-3); padding:18px 0; }
.delete-confirm { margin-top:8px; flex-wrap:wrap; color:var(--danger); }
.delete-confirm span { flex:1; }
@container (max-width:280px) { .prompt-heading strong {font-size:12px} button {padding-inline:6px} .row-bottom {gap:4px} }
</style>
