<script setup lang="ts">
/**
 * 主对话发送液滴覆盖层。消息会立刻发给引擎；这里只负责把发送按钮的位置
 * 连接到新用户气泡，任何定位或动画能力异常都会立刻降级为普通显示。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useSessionStore } from '@/stores/session'

interface RectSnapshot { left: number; top: number; width: number; height: number }
interface MorphRequest { messageId: string; source: RectSnapshot }

const session = useSessionStore()
const dot = ref<HTMLElement | null>(null)
const active = ref(false)
let cancelled = false
let running: Animation[] = []
const pendingIds = new Set<string>()

function finish(id: string) {
  running.forEach(animation => animation.cancel())
  running = []
  active.value = false
  pendingIds.delete(id)
  session.completeSendMorph(id)
}

async function nextFrame(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}

async function findTarget(id: string): Promise<HTMLElement | null> {
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&')
  for (let attempt = 0; attempt < 18 && !cancelled; attempt++) {
    await nextFrame()
    const target = document.querySelector<HTMLElement>(`[data-message-id="${escaped}"] .bubble`)
    if (target && target.getBoundingClientRect().width > 0) return target
  }
  return null
}

async function run(detail: MorphRequest) {
  if (active.value || cancelled) { pendingIds.delete(detail.messageId); session.completeSendMorph(detail.messageId); return }
  const target = await findTarget(detail.messageId)
  const node = dot.value
  if (!target || !node || cancelled || typeof node.animate !== 'function') {
    session.completeSendMorph(detail.messageId)
    return
  }

  active.value = true
  await nextFrame()
  if (cancelled || !active.value) return finish(detail.messageId)
  const source = detail.source
  const end = target.getBoundingClientRect()
  const sx = source.left + source.width / 2
  const sy = source.top + source.height / 2
  const tx = end.left + end.width / 2
  const ty = end.top + end.height / 2
  node.style.left = '0'
  node.style.top = '0'
  node.style.width = '36px'
  node.style.height = '36px'
  node.style.borderRadius = '50%'
  node.style.opacity = '1'

  try {
    const fly = node.animate([
      { transform: `translate(${sx - 18}px, ${sy - 18}px) scale(1)`, borderRadius: '50%' },
      { offset: .22, transform: `translate(${sx - 5}px, ${sy - 5}px) scale(.28)`, borderRadius: '50%' },
      { offset: .68, transform: `translate(${sx + (tx - sx) * .68 - 5}px, ${sy + (ty - sy) * .68 - 17}px) scale(.28)`, borderRadius: '55% 45% 62% 38%' },
      { transform: `translate(${tx - 5}px, ${ty - 5}px) scale(.28)`, borderRadius: '50%' },
    ], { duration: 440, easing: 'cubic-bezier(.24,.72,.2,1)', fill: 'forwards' })
    running.push(fly)
    await fly.finished
    if (cancelled) return finish(detail.messageId)

    node.style.width = `${end.width}px`
    node.style.height = `${end.height}px`
    const spread = node.animate([
      { transform: `translate(${tx - end.width / 2}px, ${ty - end.height / 2}px) scale(.035,.12)`, borderRadius: '55% 45% 62% 38%', opacity: 1 },
      { offset: .64, transform: `translate(${end.left}px, ${end.top}px) scale(1.04,.96)`, borderRadius: '21px 21px 9px 21px', opacity: 1 },
      { transform: `translate(${end.left}px, ${end.top}px) scale(1)`, borderRadius: '19px 19px 7px 19px', opacity: 1 },
    ], { duration: 270, easing: 'cubic-bezier(.18,.84,.22,1.18)', fill: 'forwards' })
    running.push(spread)
    await spread.finished
    finish(detail.messageId)
  } catch {
    finish(detail.messageId)
  }
}

function onRequest(event: Event) {
  const detail = (event as CustomEvent<MorphRequest>).detail
  if (!detail?.messageId || !detail.source) return
  pendingIds.add(detail.messageId)
  void run(detail)
}

onMounted(() => window.addEventListener('coomi:send-morph', onRequest))
onBeforeUnmount(() => {
  cancelled = true
  window.removeEventListener('coomi:send-morph', onRequest)
  running.forEach(animation => animation.cancel())
  pendingIds.forEach(id => session.completeSendMorph(id))
  pendingIds.clear()
})
</script>

<template>
  <div v-show="active" ref="dot" class="send-morph-dot" aria-hidden="true" />
</template>

<style scoped>
.send-morph-dot {
  position: fixed; z-index: 95; pointer-events: none;
  background: var(--blue); color: transparent;
  box-shadow: 0 0 18px color-mix(in srgb, var(--blue) 52%, transparent);
  will-change: transform, width, height, border-radius, opacity;
}
@media (prefers-reduced-motion: reduce) { .send-morph-dot { display: none !important; } }
</style>
