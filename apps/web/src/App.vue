<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { RouterView } from 'vue-router'
import { getNavDirection } from '@/router'

const floating = ref(window.__coomiFloating === true)

// 根据导航方向选择转场动画：前进从左滑入，返回从右滑回（原生 push/pop 风格）
const slideName = computed(() => (getNavDirection() === 'back' ? 'view-slide-back' : 'view-slide-forward'))

function applyFloatingState(value: boolean) {
  floating.value = value
  window.__coomiFloating = value
  document.documentElement.dataset.coomiFloating = String(value)
}

function onFloatingState(event: CustomEvent<boolean>) {
  if (typeof event.detail === 'boolean') applyFloatingState(event.detail)
}


applyFloatingState(floating.value)
window.addEventListener('coomi:floating-state', onFloatingState)
onBeforeUnmount(() => {
  window.removeEventListener('coomi:floating-state', onFloatingState)
  delete document.documentElement.dataset.coomiFloating
})
</script>
<template>
  <RouterView v-slot="{ Component, route }">
    <Transition
      :name="slideName"
      mode="out-in"
    >
      <component
        :is="Component"
        :key="route.name"
        :floating="route.name === 'chat' ? floating : undefined"
      />
    </Transition>
  </RouterView>
</template>