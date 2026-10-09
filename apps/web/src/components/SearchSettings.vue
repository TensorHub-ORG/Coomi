<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiGet, apiSend } from '@/bridge/http'
import CoomiIcon from './CoomiIcon.vue'
const configured=ref(false), key=ref(''), visible=ref(false), busy=ref(false), loaded=ref(false), error=ref(''), notice=ref('')
async function load() {
  busy.value=true; error.value=''
  try { const data=await apiGet<{tavilyConfigured:boolean}>('/api/settings/search'); configured.value=data.tavilyConfigured; loaded.value=true }
  catch { error.value='无法读取联网配置，请重试' } finally { busy.value=false }
}
async function save(clear=false) {
  busy.value=true;error.value='';notice.value=''
  try {
    const data=await apiSend<{tavilyConfigured:boolean}>('/api/settings/search','PUT',{tavilyApiKey:clear?'':key.value.trim()})
    configured.value=data.tavilyConfigured;key.value='';visible.value=false;notice.value=clear?'已移除密钥':'已保存'
  } catch { error.value='保存失败，请重试' } finally {busy.value=false}
}
onMounted(load)
</script>
<template>
  <section class="search-settings">
    <header><CoomiIcon name="globe" :size="19" /><strong>tavily（联网搜索）</strong><span :class="{ready:configured}">{{ configured?'已配置':'未配置' }}</span></header>
    <form @submit.prevent="save()">
      <label for="tavily-key">API 密钥</label>
      <div class="key-field"><input id="tavily-key" v-model="key" :type="visible?'text':'password'" autocomplete="off" spellcheck="false" maxlength="512" :placeholder="configured?'输入新密钥以替换':'tvly-…'" :disabled="busy || !loaded" /><button type="button" :aria-label="visible?'隐藏密钥':'显示密钥'" :title="visible?'隐藏密钥':'显示密钥'" @click="visible=!visible"><CoomiIcon name="eye" :size="17" /></button></div>
      <p v-if="error" class="error" role="alert">{{ error }} <button type="button" @click="load" :disabled="busy">重试</button></p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <div class="actions"><button v-if="configured" type="button" :disabled="busy" @click="save(true)">移除密钥</button><button class="primary" type="submit" :disabled="busy || !loaded || !key.trim()">{{busy?'保存中…':'保存'}}</button></div>
    </form>
  </section>
</template>
<style scoped>
.search-settings { padding:18px 0;color:var(--text);font-size:13px; }
header {display:flex;align-items:center;gap:8px;padding-bottom:18px;border-bottom:1px solid var(--border)}
strong {flex:1;font-size:14px;overflow-wrap:anywhere} header span {font-size:11px;color:var(--text-3)} header .ready {color:var(--ok)}
form {display:grid;gap:10px;padding-top:18px}label {color:var(--text-2)}
.key-field {display:flex;border:1px solid var(--border);border-radius:8px;background:var(--fill)}
input {width:100%;min-width:0;flex:1;padding:11px;background:transparent;color:var(--text);font:inherit;border:0}
button {display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:7px 11px;background:var(--fill);color:var(--text-2);border-radius:8px;font:inherit}
.key-field button {background:transparent}.actions {display:flex;justify-content:flex-end;gap:8px}.primary {background:var(--blue);color:var(--user-text,#fff)}button:disabled {opacity:.45}.error {color:var(--danger)}.notice {color:var(--ok)}
</style>
