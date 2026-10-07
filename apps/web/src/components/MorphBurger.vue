<script setup lang="ts">
/**
 * 汉堡按钮（三条杠）。
 *
 * 点击时图标用 Morphicons 从「三线菜单」自然变形为「向上箭头」/「关闭」，
 * 同时向上展开抽屉面板 —— 展开动画也是变形驱动，不是单纯的显示/隐藏。
 * 图标数据来自 lucide（vanilla 包，导出 IconNode），MorphIcon 直接消费。
 */
import { ref, watch } from 'vue'
import { MorphIcon } from 'morphicons/vue'
import { Menu, ChevronUp, X } from 'lucide'
import { useConfigStore } from '@/stores/config'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ toggle: [] }>()

const config = useConfigStore()

/** 展开时图标：优先变形为向上箭头（面板向上开），X 作为 alternative。 */
const icon = ref(Menu)

watch(() => props.open, (open) => {
  icon.value = open ? ChevronUp : Menu
}, { immediate: false })

/** 点一下：切换抽屉开关。 */
function onClick() {
  emit('toggle')
}
</script>

<template>
  <button class="morph-burger" aria-label="菜单" :aria-expanded="open" @click="onClick">
    <MorphIcon
      :icon="icon"
      :size="22"
      stroke-width="1.9"
      :spring="{ stiffness: 300, damping: 22 }"
      :reduced-motion="(config.sendMorphAnimation && !config.allAnimationsOff) ? 'never' : 'always'"
      class="burger-icon"
    />
  </button>
</template>

<style scoped>
.morph-burger {
  display: inline-flex; align-items: center; justify-content: center;
  width: 38px; height: 38px; flex-shrink: 0;
  border: 0; border-radius: 50%; background: none; color: var(--text-2);
}
.morph-burger:active { background: var(--fill-press); }
.burger-icon { display: block; }
</style>
