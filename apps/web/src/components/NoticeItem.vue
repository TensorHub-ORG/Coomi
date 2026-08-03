<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NoticeItem } from '@/stores/viewModel'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ notice: NoticeItem }>()

const open = ref(false)

const icon = computed(() => {
  switch (props.notice.tone) {
    case 'error': return 'alert'
    case 'warn': return 'alert'
    case 'success': return 'check'
    default: return ''
  }
})

function toggle() { if (props.notice.detail) open.value = !open.value }
</script>

<template>
  <div class="notice cascade" :class="notice.tone" @click="toggle">
    <CoomiIcon v-if="icon" :name="icon" :size="14" />
    <span>{{ notice.text }}</span>
    <CoomiIcon v-if="notice.detail" name="chevronRight" :size="14" class="chev" :class="{ open }" />
  </div>
  <div v-if="notice.detail && open" class="notice-detail cascade">
    <pre>{{ notice.detail }}</pre>
  </div>
</template>

<style scoped>
.notice {
  align-self: center; display: inline-flex; align-items: center; gap: 6px;
  min-width: 0; max-width: 92%; padding: 6px 14px;
  border-radius: var(--r-pill); background: var(--fill);
  font-size: 12.5px; line-height: 1.5; color: var(--text-3);
}
.notice span { min-width: 0; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
.notice.warn { background: var(--orange-soft); color: var(--orange); }
.notice.success { background: var(--ok-soft); color: var(--ok); }
.notice.error {
  align-self: stretch; width: 100%; max-width: 100%; align-items: flex-start; overflow: hidden;
  padding: 10px 13px; border-radius: var(--r-md);
  background: var(--danger-soft); color: #9b3a2c;
  text-align: left; word-break: break-word;
}
.notice.error :deep(svg) { flex-shrink: 0; margin-top: 1px; color: var(--danger); }
.chev { flex-shrink: 0; transition: transform .18s; }
.chev.open { transform: rotate(90deg); }

.notice-detail {
  align-self: center; width: 100%; max-width: 92%;
  margin-top: -4px; padding: 9px 13px;
  border-radius: var(--r-md); background: var(--code-bg);
}
.notice-detail pre {
  margin: 0; font-family: var(--font-mono); font-size: 11.8px; line-height: 1.6;
  color: var(--code-text); white-space: pre-wrap; word-break: break-word;
  max-height: 260px; overflow-y: auto;
}
</style>
