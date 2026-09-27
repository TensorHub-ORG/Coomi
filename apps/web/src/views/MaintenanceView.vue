<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet, apiSend } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { useSessionStore } from '@/stores/session'
const router = useRouter(); const items = ref<Array<{ path: string; size: number; safe: boolean }>>([]); const total = ref(0); const selected = ref<string[]>([]); const prompt = ref(''); const defaultPrompt = ref(''); const busy = ref(''); const notice = ref(''); const error = ref('')
const session = useSessionStore()
const size = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`
async function scan() { busy.value = 'scan'; error.value = ''; try { const r = await apiGet<{ items: typeof items.value; total_size: number }>('/api/maintenance/scan'); items.value = r.items; total.value = r.total_size; selected.value = r.items.map(i => i.path) } catch (e) { error.value = String(e) } finally { busy.value = '' } }
async function clean() { if (!selected.value.length) return; busy.value = 'clean'; try { await apiSend('/api/maintenance/clean', 'POST', { paths: selected.value }); notice.value = '安全缓存已清理'; await scan() } catch (e) { error.value = String(e) } finally { busy.value = '' } }
async function savePrompt() { try { await apiSend('/api/settings/maintenance-prompts', 'PUT', { cleanup_prompt: prompt.value }); notice.value = '提示词已保存' } catch (e) { error.value = String(e) } }
function resetPrompt() { prompt.value = defaultPrompt.value }
async function smartClean() {
  await savePrompt()
  const text = prompt.value.trim()
  if (!text) return
  session.newSession()
  localStorage.setItem(`coomi.draft.${session.sessionId}`, text)
  await router.push('/')
  await nextTick()
  window.dispatchEvent(new CustomEvent('coomi:prefill-draft', { detail: { sessionId: session.sessionId, text } }))
}
onMounted(async () => { await scan(); try { const r = await apiGet<{ cleanup: string; cleanup_default: string }>('/api/settings/maintenance-prompts'); prompt.value = r.cleanup; defaultPrompt.value = r.cleanup_default } catch { /* old engine */ } })
</script>
<template><div class="page"><PageHead title="清理工具" @back="goBack(router, 'dashboard')"/><main class="body"><div v-if="notice || error" class="notice" :class="{ error: !!error }">{{ error || notice }}</div><p class="sec-label">固定清理</p><section class="group"><div class="summary"><span>可安全处理的缓存与临时文件</span><strong>{{ size(total) }}</strong></div><div v-for="item in items" :key="item.path" class="line"><label><input v-model="selected" type="checkbox" :value="item.path"/> <code>{{ item.path }}</code></label><span>{{ size(item.size) }}</span></div><div class="actions"><button class="secondary" :disabled="!!busy" @click="scan"><CoomiIcon name="refresh" :size="15"/>扫描</button><button class="primary" :disabled="!!busy || !selected.length" @click="clean"><CoomiIcon name="broom" :size="15"/>清理</button></div></section><p class="sec-label">智能清理</p><section class="group prompt"><textarea v-model="prompt" rows="8"/><div class="prompt-actions"><button @click="resetPrompt">重置</button><button @click="savePrompt">保存</button><button class="primary" @click="smartClean">在会话中执行</button></div></section></main></div></template>
<style scoped>.page{display:flex;flex-direction:column;height:100%;background:var(--page)}.body{flex:1;overflow:auto;padding:14px 12px calc(var(--safe-bottom) + 24px)}.sec-label{margin:16px 0 6px}.group{overflow:hidden;border-radius:var(--r-card);background:var(--bg);box-shadow:var(--shadow-1)}.summary,.line{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 13px;border-bottom:1px solid var(--border);font-size:13px}.summary strong{color:var(--blue)}.line label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.line code{font-size:12px;color:var(--text-2)}.actions,.prompt-actions{display:flex;justify-content:flex-end;gap:8px;padding:10px 12px}.actions button,.prompt-actions button{display:inline-flex;align-items:center;gap:5px;min-height:34px;padding:0 11px;border-radius:6px;background:var(--fill-strong);color:var(--text-2);font-size:13px}.actions .primary,.prompt-actions .primary{background:var(--blue);color:#fff}.prompt{padding:10px}.prompt textarea{display:block;width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--border-strong);border-radius:6px;background:var(--page);color:var(--text);font:inherit;font-size:12.5px;line-height:1.5}.notice{margin-bottom:10px;padding:9px 11px;border-radius:6px;background:var(--blue-soft);color:var(--blue);font-size:12px}.notice.error{background:color-mix(in srgb,var(--danger) 10%,var(--bg));color:var(--danger)}</style>
