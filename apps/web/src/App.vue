<script setup lang="ts">
import { ref } from 'vue'
import { RouterView, useRouter } from 'vue-router'

const router = useRouter()
const direction = ref<'forward' | 'back'>('forward')
router.beforeEach((to, from) => {
  const depth = (path: string) => path.split('/').filter(Boolean).length
  direction.value = depth(to.path) < depth(from.path) ? 'back' : 'forward'
})
</script>

<template>
  <RouterView v-slot="{ Component }">
    <Transition :name="direction === 'back' ? 'page-back' : 'page-forward'" mode="out-in">
      <component :is="Component" />
    </Transition>
  </RouterView>
</template>

<style>
.page-forward-enter-active,.page-forward-leave-active,.page-back-enter-active,.page-back-leave-active{transition:transform .22s cubic-bezier(.22,.68,.19,1),opacity .18s ease;will-change:transform,opacity}
.page-forward-enter-from{transform:translateX(18px);opacity:0}.page-forward-leave-to{transform:translateX(-10px);opacity:0}
.page-back-enter-from{transform:translateX(-14px);opacity:0}.page-back-leave-to{transform:translateX(16px);opacity:0}
@media(prefers-reduced-motion:reduce){.page-forward-enter-active,.page-forward-leave-active,.page-back-enter-active,.page-back-leave-active{transition:opacity .1s ease}.page-forward-enter-from,.page-forward-leave-to,.page-back-enter-from,.page-back-leave-to{transform:none}}
</style>
