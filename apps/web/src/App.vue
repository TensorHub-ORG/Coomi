<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { RouterView } from 'vue-router'

const floating = ref(window.__coomiFloating === true)

// 所有页面切换统一为「从左侧滑入 / 往左侧滑出」的单一转场，不区分进入或退出
const slideName = 'view-slide'

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