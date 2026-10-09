<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiGet, apiSend } from '@/bridge/http'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'
import CoomiIcon from './CoomiIcon.vue'
interface Note {id:string;title:string;updatedAt:string;revision:number}
interface Draft extends Note {content:string}
defineProps<{embedded?:boolean}>()
const emit=defineEmits<{fill:[text:string]}>()
const notes=ref<Note[]>([]),query=ref(''),error=ref(''),busy=ref(false),loaded=ref(false),draft=ref<Draft|null>(null),deleting=ref<Note|null>(null),discard=ref(false)
const original=ref('')
const visible=computed(()=>notes.value.filter(n=>n.title.toLowerCase().includes(query.value.trim().toLowerCase())))
const dirty=computed(()=>!!draft.value && JSON.stringify([draft.value.title,draft.value.content])!==original.value)
const draftKey=(id:string)=>`coomi.note-draft.${id}`
function date(value:string) {return value?new Date(value).toLocaleDateString():''}
async function load() {
  busy.value=true;error.value=''
  try {const data=await apiGet<{notes:Note[]}>('/api/notes');notes.value=data.notes;loaded.value=true}
  catch {error.value='无法读取笔记，请连接引擎后重试'} finally {busy.value=false}
}
async function edit(note?:Note) {
  busy.value=true;error.value=''
  try {
    let newId:string=crypto.randomUUID()
    if(!note)try {const previous=localStorage.getItem('coomi.note-new-id');if(previous)newId=previous}catch {/* start new */}
    const data=note?await apiGet<{note:Note;content:string}>(`/api/notes/${note.id}`):{note:{id:newId,title:'',updatedAt:'',revision:0},content:''}
    original.value=JSON.stringify([data.note.title,data.content])
    let content=data.content,title=data.note.title
    try {const saved=JSON.parse(localStorage.getItem(draftKey(data.note.id))||'null');if(saved?.revision===data.note.revision){content=saved.content;title=saved.title}} catch {/* ignore invalid draft */}
    draft.value={...data.note,title,content}
  } catch {error.value='无法打开笔记，请重试'} finally {busy.value=false}
}
watch(draft,value=>{
  if(value) try {localStorage.setItem(draftKey(value.id),JSON.stringify({title:value.title,content:value.content,revision:value.revision}));if(value.revision===0)localStorage.setItem('coomi.note-new-id',value.id)} catch {/* engine save remains available */}
},{deep:true})
function closeEditor() {if(busy.value)return;if(dirty.value)discard.value=true;else draft.value=null}
function discardChanges() {if(draft.value)try {localStorage.removeItem(draftKey(draft.value.id));if(draft.value.revision===0)localStorage.removeItem('coomi.note-new-id')}catch {/* editor still closes */}discard.value=false;draft.value=null}
async function save() {
  if(!draft.value)return
  busy.value=true;error.value=''
  const current={...draft.value}
  try {
    const data=await apiSend<{note:Note}>(`/api/notes/${current.id}`,'PUT',{title:current.title,content:current.content,revision:current.revision})
    notes.value=[data.note,...notes.value.filter(n=>n.id!==data.note.id)]
    try {localStorage.removeItem(draftKey(current.id));if(current.revision===0)localStorage.removeItem('coomi.note-new-id')}catch {/* file saved in engine */}draft.value=null
  } catch {error.value='保存失败或笔记已被其他窗口修改。草稿已保留，请重试或重新打开笔记。'} finally {busy.value=false}
}
async function remove() {
  if(!deleting.value)return
  busy.value=true;error.value=''
  const note=deleting.value
  try {await apiSend(`/api/notes/${note.id}`,'DELETE',{revision:note.revision});notes.value=notes.value.filter(n=>n.id!==note.id);try {localStorage.removeItem(draftKey(note.id))}catch {/* note deleted on disk */}deleting.value=null}
  catch {error.value='删除失败，请刷新后重试'}finally {busy.value=false}
}
function read(note:Note) {emit('fill',`请读取笔记「${note.title}」，使用 read_note，笔记 ID：${note.id}。`)}
watch(draft,value=>{if(value)registerOverlay('note-editor',closeEditor);else unregisterOverlay('note-editor')})
watch(discard,value=>{if(value)registerOverlay('note-discard',()=>{discard.value=false});else unregisterOverlay('note-discard')})
watch(deleting,value=>{if(value)registerOverlay('note-delete',()=>{deleting.value=null});else unregisterOverlay('note-delete')})
onMounted(load)
onBeforeUnmount(()=>{unregisterOverlay('note-editor');unregisterOverlay('note-discard');unregisterOverlay('note-delete')})
</script>
<template>
  <section class="note-library" :class="{embedded}" aria-label="笔记本">
    <div class="toolbar"><input v-model="query" type="search" aria-label="搜索笔记" placeholder="搜索笔记…" /><button :disabled="busy || !loaded" @click="edit()" aria-label="新建笔记"><CoomiIcon name="plus" :size="17" />新建</button></div>
    <p v-if="error && !draft" class="error" role="alert">{{error}} <button @click="load" :disabled="busy">重试</button></p>
    <p v-if="!visible.length" class="empty">{{busy?'加载中…':query?'没有匹配的笔记':'暂无笔记'}}</p>
    <article v-for="note in visible" :key="note.id" class="note-row">
      <button class="note-main" @click="edit(note)" :disabled="busy"><CoomiIcon name="notebook" :size="17" /><span><strong>{{note.title}}</strong><small>TXT · {{date(note.updatedAt)}}</small></span><CoomiIcon name="chevronRight" :size="15" /></button>
      <div class="row-actions"><button @click="deleting=note" :disabled="busy" aria-label="删除笔记" title="删除笔记"><CoomiIcon name="trash" :size="15" /></button><button class="read" @click="read(note)">读取笔记</button></div>
    </article>
    <Teleport to="body">
      <!-- Keep teleported editor/confirmation touches inside the parent shortcut panel. -->
      <form v-if="draft" class="note-editor" :data-context-tools="embedded ? '' : undefined" role="dialog" aria-modal="true" aria-label="编辑笔记" @keydown.esc.stop.prevent="closeEditor" @submit.prevent="save">
        <header><button type="button" @click="closeEditor" :disabled="busy" aria-label="返回笔记列表" title="返回"><CoomiIcon name="chevronLeft" :size="20" /></button><strong>笔记</strong><span>{{dirty?'未保存':'已保存'}}</span><button type="submit" class="primary" :disabled="busy || !draft.title.trim()">{{busy?'保存中…':'保存'}}</button></header>
        <input class="note-title" v-model="draft.title" maxlength="80" required placeholder="笔记名称" aria-label="笔记名称" :disabled="busy" />
        <textarea v-model="draft.content" class="note-content" placeholder="记录此刻的想法…" aria-label="笔记内容" :disabled="busy" />
        <footer><span>TXT</span><span>{{draft.content.length}} 字</span></footer>
        <p v-if="error" class="error" role="alert">{{error}}</p>
      </form>
      <div v-if="discard || deleting" class="note-mask" :data-context-tools="embedded ? '' : undefined" @keydown.esc.stop.prevent="discard=false;deleting=null" @click.self="discard=false;deleting=null">
        <div class="note-confirm" role="dialog" aria-modal="true" :aria-label="discard?'放弃修改':'删除笔记'">
          <strong>{{discard?'放弃未保存的修改？':`删除「${deleting?.title}」？`}}</strong>
          <div><button @click="discard=false;deleting=null">取消</button><button class="danger" @click="discard?discardChanges():remove()" :disabled="busy">{{discard?'放弃修改':'删除'}}</button></div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
<style scoped>
.note-library {height:100%;min-height:0;overflow:auto;padding:4px 16px 16px;color:var(--text);font-size:13px}
.toolbar {display:flex;gap:8px;padding-bottom:12px}.toolbar input {flex:1;min-width:0;padding:9px;border:1px solid var(--border);border-radius:8px;background:var(--fill);color:var(--text);font:inherit}
button {display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:32px;padding:6px 9px;border-radius:8px;background:var(--fill);color:var(--text-2);font:inherit}button:disabled {opacity:.45}
.note-row {border-top:1px solid var(--border);padding:8px 0}.note-main {display:flex;width:100%;text-align:left;background:transparent;gap:9px;padding:8px 0}.note-main span {flex:1;min-width:0}.note-main strong {display:block;overflow-wrap:anywhere;color:var(--text);font-weight:600;font-size:13px}small {display:block;margin-top:5px;color:var(--text-3);font-size:11px}
.row-actions {display:flex;justify-content:flex-end;gap:7px}.row-actions>button:first-child {background:transparent}.read {color:var(--blue);background:var(--blue-soft)}.empty {padding:24px 0;color:var(--text-3)}
.note-editor {position:fixed;inset:0;z-index:300;display:flex;flex-direction:column;background:var(--bg);color:var(--text);padding:var(--safe-top) 16px var(--safe-bottom);font-size:13px}
.note-editor header {display:flex;align-items:center;gap:10px;min-height:56px;border-bottom:1px solid var(--border)}header strong {flex:1;font-size:15px}header span {font-size:11px;color:var(--text-3)}header>button:first-child {background:transparent}
.note-title {padding:17px 2px;border:0;border-bottom:1px solid var(--border);border-radius:0;background:transparent;color:var(--text);font:inherit;font-size:17px;font-weight:600;min-width:0;width:100%}
.note-content {flex:1;min-height:0;width:100%;resize:none;padding:16px 2px;border:0;border-radius:0;background:transparent;color:var(--text);font:inherit;line-height:1.8;outline:none}
footer {display:flex;justify-content:space-between;padding:10px 0;color:var(--text-3);font-size:11px}.primary {background:var(--blue);color:var(--user-text,#fff)}.error {color:var(--danger);padding:8px;line-height:1.5}
.note-mask {position:fixed;inset:0;z-index:320;background:rgba(0,0,0,.35);display:grid;place-items:center;padding:20px}.note-confirm {width:100%;max-width:340px;border-radius:8px;padding:20px;background:var(--bg);color:var(--text);font-size:14px}.note-confirm strong {overflow-wrap:anywhere}.note-confirm>div {display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.danger {color:var(--danger)}
</style>
