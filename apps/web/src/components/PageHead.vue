<script setup lang="ts">
/**
 * 二级页头。返回箭头 + 标题，右侧留一个插槽给页面自己的动作。
 * 四个设置类页面共用，免得各写一套间距。
 */
import CoomiIcon from './CoomiIcon.vue'

defineProps<{ title: string }>()
const emit = defineEmits<{ back: [] }>()
</script>

<template>
  <header class="bar">
    <button class="icon-btn" aria-label="返回" @click="emit('back')">
      <CoomiIcon name="chevronLeft" />
    </button>
    <h1 class="title">{{ title }}</h1>
    <div class="right"><slot name="right" /></div>
  </header>
</template>

<style scoped>
.bar {
  display: flex; align-items: center; gap: 4px; flex-shrink: 0;
  padding: calc(var(--safe-top) + 6px) 8px 6px;
  background: var(--bg); border-bottom: 1px solid var(--border);
}
.title { flex: 1; min-width: 0; font-size: 16.5px; font-weight: 650; color: var(--text); }
.right { display: flex; align-items: center; gap: 2px; }
</style>
