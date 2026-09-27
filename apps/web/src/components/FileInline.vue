<script setup lang="ts">
/**
 * 对话中的文件展示组件：把 Agent 输出流里出现的本地文件路径渲染成可点击的
 * 文件卡片（样式对齐工具调用卡片），点击后可在 app 内预览 / 保存 / 另存为 /
 * 用其它应用打开 / 复制路径。
 */
import { computed, ref } from 'vue'
import { authedFetch, engineToken } from '@/bridge/http'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ paths: string[] }>()

const open = ref(false)
const notice = ref('')
const activePath = ref('')
const previewText = ref('')

const activeName = computed(() => activePath.value.split('/').pop() || activePath.value)

function isTextFile(name: string): boolean {
  return /\.(txt|md|json|log|sh|py|rs|js|ts|vue|toml|yaml|yml|conf|ini|env|html|css|xml)$/i.test(name)
}
function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
}
const previewSrc = computed(() =>
  '/api/fs/raw?path=' + encodeURIComponent(activePath.value)
  + '&token=' + encodeURIComponent(engineToken()))

function openSheet(path: string) {
  activePath.value = path
  notice.value = ''
  previewText.value = ''
  open.value = true
  if (isTextFile(path)) {
    void authedFetch(previewSrc.value)
      .then(r => r.text())
      .then(t => { previewText.value = t.slice(0, 200000) })
      .catch(() => { previewText.value = '（无法读取）' })
  }
}

function saveAs() {
  window.CoomiAndroid?.exportFile?.(activePath.value, activeName.value)
  notice.value = '已打开另存为…'
}

function openExternal() {
  window.CoomiAndroid?.openFile?.(activePath.value)
}

function copyPath() {
  void navigator.clipboard?.writeText(activePath.value).catch(() => {})
  notice.value = '已复制路径'
}
</script>

<template>
  <div class="file-chips">
    <button v-for="p in paths" :key="p" class="chip" @click="openSheet(p)">
      <CoomiIcon name="fileRead" :size="14" />
      <span class="chip-name">{{ p.split('/').pop() }}</span>
      <CoomiIcon name="chevronRight" :size="12" class="arw" />
    </button>
  </div>

  <div v-if="open" class="mask" @click.self="open = false">
    <div class="sheet">
      <div class="head">
        <CoomiIcon name="fileRead" :size="16" />
        <span class="name">{{ activeName }}</span>
        <button class="x" @click="open = false"><CoomiIcon name="close" :size="15" /></button>
      </div>
      <p class="path">{{ activePath }}</p>
      <p v-if="notice" class="notice">{{ notice }}</p>

      <div class="body">
        <img v-if="isImage(activeName)" :src="previewSrc" class="img" alt="" loading="lazy" decoding="async" />
        <pre v-else-if="isTextFile(activeName)" class="text">{{ previewText }}</pre>
        <div v-else class="other">
          <p>该类型不支持内联预览。</p>
        </div>
      </div>

      <div class="actions">
        <button class="btn" @click="saveAs"><CoomiIcon name="download" :size="15" /><span>另存为</span></button>
        <button class="btn" @click="openExternal"><CoomiIcon name="external" :size="15" /><span>用其它应用打开</span></button>
        <button class="btn" @click="copyPath"><CoomiIcon name="link" :size="15" /><span>复制路径</span></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 10px; border-radius: var(--r-sm);
  background: var(--blue-soft); color: var(--blue);
  font-size: 12px; font-weight: 550;
}
.chip-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arw { opacity: 0.6; }
.mask { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, 0.45); display: flex; align-items: flex-end; }
.sheet {
  width: 100%; background: var(--bg-card);
  border-radius: 18px 18px 0 0;
  padding: 16px 16px calc(14px + var(--safe-bottom));
  display: flex; flex-direction: column;
}
.head { display: flex; align-items: center; gap: 8px; color: var(--text); }
.head .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14.5px; font-weight: 650; }
.x { color: var(--text-3); padding: 4px; }
.path { margin: 4px 0 0; font-family: var(--font-mono); font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notice { margin: 8px 0 0; font-size: 12px; color: var(--ok); }
.body { max-height: 46vh; overflow: auto; margin-top: 12px; }
.img { max-width: 100%; border-radius: var(--r-sm); }
.text { margin: 0; padding: 10px; background: var(--code-bg); border-radius: var(--r-sm); font-family: var(--font-mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; color: var(--code-text); }
.other { text-align: center; color: var(--text-3); font-size: 13px; padding: 30px 0; }
.actions { display: flex; gap: 8px; margin-top: 14px; }
.actions .btn {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-height: 42px; border-radius: var(--r-md);
  background: var(--fill-strong); color: var(--text-2); font-size: 12.5px; font-weight: 550;
}
</style>
