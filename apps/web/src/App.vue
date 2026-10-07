<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterView, useRouter } from 'vue-router'
import { useConfigStore } from './stores/config'
import { gsap } from './composables/useGsap'

const router = useRouter()
const direction = ref<'forward' | 'back'>('forward')
const config = useConfigStore()

router.beforeEach((to, from) => {
  const depth = (path: string) => path.split('/').filter(Boolean).length
  direction.value = depth(to.path) < depth(from.path) ? 'back' : 'forward'
})

// 全局动画总开关：同步到 <html data-all-animations-off> 让 CSS 选择器一次性生效。
// 开启「关闭所有动画」时，顺手清掉正在跑的 GSAP tween / timeline，
// 并通知所有组件收尾。
watch(() => config.allAnimationsOff, (off) => {
  const root = document.documentElement
  if (off) {
    root.dataset.allAnimationsOff = '1'
    // 不销毁 GSAP 根时间线，否则重新开启动画后新补间也无法播放。
    gsap.globalTimeline.getChildren(true, true, true).forEach(animation => {
      animation.progress(1)
      animation.kill()
    })
    // 触发组件自行清理
    window.dispatchEvent(new CustomEvent('coomi:all-animations-off'))
  } else {
    delete root.dataset.allAnimationsOff
  }
}, { immediate: true })
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
[data-all-animations-off] .page-forward-enter-active,
[data-all-animations-off] .page-forward-leave-active,
[data-all-animations-off] .page-back-enter-active,
[data-all-animations-off] .page-back-leave-active{transition:opacity .08s ease}
[data-all-animations-off] .page-forward-enter-from,
[data-all-animations-off] .page-forward-leave-to,
[data-all-animations-off] .page-back-enter-from,
[data-all-animations-off] .page-back-leave-to{transform:none}
</style>
