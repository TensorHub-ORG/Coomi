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
const ripple = ref<HTMLElement | null>(null)
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
  const node = dot.value
  const target = await findTarget(detail.messageId)
  if (!target || !node || cancelled || typeof node.animate !== 'function') {
    session.completeSendMorph(detail.messageId)
    return
  }

  active.value = true
  await nextFrame()
  if (cancelled || !active.value) return finish(detail.messageId)

  const source = detail.source
  const startCX = source.left + source.width / 2
  const startCY = source.top + source.height / 2
  const DURATION = 560
  const t0 = performance.now()
  let lastEnd: DOMRect | null = null
  node.style.left = '0'
  node.style.top = '0'
  node.style.opacity = '1'

  // 逐帧动画: 每帧重测目标气泡位置(自动滚动/键盘弹出会移动它), 水滴实时跟随。
  await new Promise<void>(resolve => {
    const step = () => {
      if (cancelled) { resolve(); return }
      const now = performance.now()
      const t = Math.min(1, (now - t0) / DURATION)
      const end = target.getBoundingClientRect()
      if (end.width > 0 && end.height > 0) lastEnd = end
      const rect = lastEnd ?? end
      const endCX = rect.left + rect.width / 2
      const endCY = rect.top + rect.height / 2
      const ease = 1 - Math.pow(1 - t, 3)
      const cx = startCX + (endCX - startCX) * ease
      const cy = startCY + (endCY - startCY) * ease
      const w = source.width + (30 - source.width) * ease
      node.style.width = `${w}px`
      node.style.height = `${w}px`
      // 水墨感: 有机非对称圆角随进度轻微摆动, 像墨滴在表面张力下呼吸。
      const wob = Math.sin(t * 9) * 3
      node.style.borderRadius = `${46 + wob}% ${54 - wob}% ${50 - wob}% ${50 + wob}% / ${50 - wob}% ${52 + wob}% ${48 + wob}% ${50 - wob}%`
      node.style.transform = `translate3d(${cx - w / 2}px, ${cy - w / 2}px, 0) rotate(${t * 14}deg)`
      node.style.opacity = String(1 - t * .4)
      if (t < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })

  // 到达后: 透明水波波纹发散(两圈), 不再做铺开转圈。
  const rect = lastEnd ?? target.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  node.style.opacity = '0'
  // 水墨扩散: 墨斑以有机形状在落点晕开, 边缘随扩散虚化, 如墨滴入纸。
  if (ripple.value && typeof ripple.value.animate === 'function') {
    const blots = [ripple.value]
    const r2 = ripple.value.nextElementSibling as HTMLElement | null
    if (r2) blots.push(r2)
    blots.forEach((el, idx) => {
      el.style.left = `${cx - 30}px`
      el.style.top = `${cy - 30}px`
      const anim = el.animate([
        { transform: 'scale(.25) rotate(0deg)', opacity: idx === 0 ? .5 : .3, filter: 'blur(0px)' },
        { transform: `scale(${1.35 + idx * .45}) rotate(${idx === 0 ? 14 : -10}deg)`, opacity: 0, filter: 'blur(3px)' },
      ], { duration: 640, delay: idx * 150, easing: 'cubic-bezier(.14,.78,.28,1)', fill: 'forwards' })
      running.push(anim)
    })
    await new Promise<void>(r => setTimeout(r, 800))
  }
  finish(detail.messageId)
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
  <i v-show="active" ref="ripple" class="send-morph-ripple" aria-hidden="true" />
  <i v-show="active" class="send-morph-ripple send-morph-ripple-2" aria-hidden="true" />
</template>

<style scoped>
.send-morph-dot {
  position: fixed; z-index: 95; pointer-events: none;
  background: color-mix(in srgb, var(--text) 78%, var(--blue));
  color: transparent;
  filter: blur(.3px);
  box-shadow: 0 0 14px color-mix(in srgb, var(--text) 30%, transparent);
  will-change: transform, width, height, border-radius, opacity;
}
.send-morph-ripple {
  position: fixed; z-index: 94; width: 60px; height: 60px;
  pointer-events: none; opacity: 0;
  background: radial-gradient(circle, color-mix(in srgb, var(--text) 22%, transparent) 0%, color-mix(in srgb, var(--text) 9%, transparent) 52%, transparent 70%);
  border-radius: 46% 54% 52% 48% / 50% 44% 56% 50%;
}

@media (prefers-reduced-motion: reduce) {
  .send-morph-dot, .send-morph-ripple { display: none !important; }
}
</style>
