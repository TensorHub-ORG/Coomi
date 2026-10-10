<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useConfigStore } from '@/stores/config'
const config = useConfigStore()
const percent = ref(config.connectionSettings.autoCompactPercent)
const busy = ref(false), loaded = ref(false), error = ref(''), saved = ref(false)
async function load() {
  busy.value = true
  loaded.value = await config.fetchConnectionSettings()
  if (loaded.value) { percent.value = config.connectionSettings.autoCompactPercent; error.value = '' }
  else error.value = '无法加载设置，请连接引擎后重试'
  busy.value = false
}
async function save() {
  saved.value = false
  if (!Number.isInteger(percent.value) || percent.value < 10 || percent.value > 95) {
    error.value = '请输入 10–95 之间的整数百分比'; return
  }
  busy.value = true
  if (await config.saveConnectionSettings({ ...config.connectionSettings, autoCompactPercent: percent.value })) {
    saved.value = true; error.value = ''
  } else error.value = '保存失败，请重试'
  busy.value = false
}
onMounted(load)
</script>
<template>
  <section class="compaction-settings">
    <p class="label">自动上下文压缩</p>
    <form @submit.prevent="save">
      <label for="auto-compact-percent"><strong>压缩阈值</strong><small>上下文用量达到此比例时自动压缩，默认 80%</small></label>
      <div class="controls"><input id="auto-compact-percent" v-model.number="percent" type="number" min="10" max="95" step="1" inputmode="numeric" aria-label="自动压缩阈值（百分比）" :disabled="busy || !loaded" /><span>%</span><button :disabled="busy || !loaded">保存</button></div>
    </form>
    <p class="hint">10–95%，下次任务生效；接近模型上限时会提前压缩，避免请求超出容量。输入 /compact 可立即手动压缩。</p>
    <p v-if="error" class="error" role="alert">{{ error }} <button @click="load" :disabled="busy">重试</button></p>
    <p v-if="saved" class="success" role="status">已保存</p>
  </section>
</template>
<style scoped>
.label {font-size:11px;color:var(--text-3);padding:16px 4px 8px}.compaction-settings form {display:flex;align-items:center;gap:12px;padding:14px;border-radius:12px;background:var(--bg)}label {flex:1;min-width:0}strong {display:block;font-size:13px;font-weight:500;color:var(--text)}small {display:block;font-size:11px;line-height:1.5;color:var(--text-3);margin-top:5px}.controls {display:flex;align-items:center;gap:5px;color:var(--text-2);font-size:12px}input {width:48px;min-width:0;padding:7px 4px;border:1px solid var(--border);border-radius:6px;background:var(--fill);color:var(--text);font:inherit}button {padding:7px 9px;border-radius:6px;background:var(--blue-soft);color:var(--blue);font-size:12px}button:disabled,input:disabled {opacity:.5}.hint {padding:8px 4px;color:var(--text-3);font-size:11px;line-height:1.6}.error,.success {font-size:12px;padding:5px 4px}.error {color:var(--danger)}.success {color:var(--ok)}
</style>
