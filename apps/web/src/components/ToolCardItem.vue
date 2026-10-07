<script setup lang="ts">
/**
 * 工具调用卡片。
 *
 * 折叠态一行说清「谁 / 对什么 / 结果如何」，展开态才给参数、内容、diff、输出。
 * 状态是有语义色的：运行中蓝 + 左侧流光，成功绿勾，失败红叉且输出染红，
 * 待授权橙（真正的确认交给底部 ApprovalSheet，卡片只说明原因），缓存命中灰闪电。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ToolCard } from '@/stores/viewModel'
import { useConfigStore } from '@/stores/config'
import { asText, toolMeta, toolTarget } from '@/utils/toolMeta'
import { gsap, prefersReducedMotion } from '@/composables/useGsap'
import CoomiIcon from './CoomiIcon.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

const props = defineProps<{ card: ToolCard }>()
const config = useConfigStore()

/** 大字段单独成块，不塞进参数表。 */
const BIG = new Set(['content', 'old_string', 'new_string', 'prompt'])

const manual = ref<boolean | null>(null)
/** 收回动画未完成时保持元素可见（否则 v-show 会立即隐藏，动画看不到）。 */
const collapsing = ref(false)
const full = ref(false)
const bodyRef = ref<HTMLElement | null>(null)
const rootEl = ref<HTMLElement | null>(null)

/**
 * 工具调用从左侧划入（新发起的调用）。
 *
 * 「由快到慢」= easeOut 曲线：开始时位移快，接近到位时慢下来，像抽屉被推了一下。
 * 只在「新的调用刚插入」时动（status=starting/running），历史恢复的卡片不动，避免整体闪。
 * 开关合并进水滴动画总开关：关水滴动画 = 工具卡也不做入场动画。
 */
onMounted(() => {
  const el = rootEl.value
  if (!el) return
  if (props.card.status !== 'starting' && props.card.status !== 'running') return
  if (prefersReducedMotion() || !config.sendMorphAnimation || config.allAnimationsOff) return
  gsap.fromTo(el,
    { x: -24, opacity: 0 },
    { x: 0, opacity: 1, duration: 0.42, ease: 'power3.out' },
  )
})

// ── 图片瀑布流 + 全屏预览（点击放大 / 另存为）──
const previewSrc = ref('')
const previewName = ref('coomi-image.png')
const previewStage = ref<HTMLElement | null>(null)
const previewImage = ref<HTMLImageElement | null>(null)
const previewScale = ref(1)
const previewX = ref(0)
const previewY = ref(0)
const pointers = new Map<number, { x: number; y: number }>()
let gestureScale = 1
let gestureX = 0
let gestureY = 0
let gestureDistance = 0
let gestureMidX = 0
let gestureMidY = 0

const previewTransform = computed(() => ({
  transform: `translate3d(${previewX.value}px, ${previewY.value}px, 0) scale(${previewScale.value})`,
}))

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function clampPreviewPosition() {
  const stage = previewStage.value
  const image = previewImage.value
  if (!stage || !image) return
  const maxX = Math.max(0, (image.offsetWidth * previewScale.value - stage.clientWidth) / 2)
  const maxY = Math.max(0, (image.offsetHeight * previewScale.value - stage.clientHeight) / 2)
  previewX.value = clamp(previewX.value, -maxX, maxX)
  previewY.value = clamp(previewY.value, -maxY, maxY)
}

function resetPreviewTransform() {
  previewScale.value = 1
  previewX.value = 0
  previewY.value = 0
  pointers.clear()
}

function closePreview() {
  unregisterOverlay(`image-preview:${props.card.callId}`)
  previewSrc.value = ''
  resetPreviewTransform()
}

function pointerDistance(points: Array<{ x: number; y: number }>) {
  return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
}

function pointerMidpoint(points: Array<{ x: number; y: number }>) {
  return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
}

function startGesture() {
  const points = [...pointers.values()]
  gestureScale = previewScale.value
  gestureX = previewX.value
  gestureY = previewY.value
  if (points.length >= 2) {
    gestureDistance = Math.max(1, pointerDistance(points))
    const midpoint = pointerMidpoint(points)
    gestureMidX = midpoint.x
    gestureMidY = midpoint.y
  } else if (points.length === 1) {
    gestureMidX = points[0].x
    gestureMidY = points[0].y
  }
}

function onPreviewPointerDown(event: PointerEvent) {
  previewStage.value?.setPointerCapture(event.pointerId)
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  startGesture()
}

function onPreviewPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  const points = [...pointers.values()]
  if (points.length >= 2) {
    const midpoint = pointerMidpoint(points)
    previewScale.value = clamp(gestureScale * pointerDistance(points) / gestureDistance, 1, 5)
    previewX.value = gestureX + midpoint.x - gestureMidX
    previewY.value = gestureY + midpoint.y - gestureMidY
  } else if (points.length === 1 && previewScale.value > 1) {
    previewX.value = gestureX + points[0].x - gestureMidX
    previewY.value = gestureY + points[0].y - gestureMidY
  }
  clampPreviewPosition()
}

function onPreviewPointerEnd(event: PointerEvent) {
  pointers.delete(event.pointerId)
  startGesture()
}

function togglePreviewZoom(event: MouseEvent) {
  if (previewScale.value > 1) {
    resetPreviewTransform()
    return
  }
  const stage = previewStage.value
  if (!stage) return
  const rect = stage.getBoundingClientRect()
  previewScale.value = 2.5
  previewX.value = (rect.width / 2 - (event.clientX - rect.left)) * 1.5
  previewY.value = (rect.height / 2 - (event.clientY - rect.top)) * 1.5
  clampPreviewPosition()
}

function openPreview(src: string) {
  resetPreviewTransform()
  previewSrc.value = src
  registerOverlay(`image-preview:${props.card.callId}`, closePreview)
  const mime = src.match(/^data:([^;]+)/)?.[1] ?? 'image/png'
  const ext = (mime.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
  previewName.value = `coomi-${Date.now()}.${ext}`
}

onBeforeUnmount(() => unregisterOverlay(`image-preview:${props.card.callId}`))

function savePreview() {
  if (!previewSrc.value) return
  if (window.CoomiAndroid?.saveImageData) {
    window.CoomiAndroid.saveImageData(previewSrc.value, previewName.value)
  } else {
    // 浏览器兜底：直接下载
    const a = document.createElement('a')
    a.href = previewSrc.value
    a.download = previewName.value
    a.click()
  }
}

const meta = computed(() => toolMeta(props.card.toolName))
const target = computed(() => toolTarget(props.card.arguments))
const isShowImage = computed(() => props.card.toolName === 'show_image')
const imgPath = computed(() => asStr(props.card.arguments?.path))
const asStr = asText

const st = computed(() => {
  switch (props.card.status) {
    case 'success': return { label: '', cls: 'ok', spin: false, icon: 'check' }
    case 'error': return { label: '失败', cls: 'err', spin: false, icon: 'close' }
    case 'cancelled': return { label: '已取消', cls: 'cancelled', spin: false, icon: 'close' }
    case 'awaiting_approval': return { label: '待授权', cls: 'wait', spin: false, icon: 'shield' }
    case 'cache_hit': return { label: '缓存', cls: 'cache', spin: false, icon: 'bolt' }
    case 'starting': return { label: '准备', cls: 'run', spin: true, icon: '' }
    default: return { label: '运行中', cls: 'run', spin: true, icon: '' }
  }
})

const argRows = computed(() =>
  Object.entries(props.card.arguments ?? {})
    .filter(([k, v]) => !BIG.has(k) && v != null && v !== '')
    .map(([k, v]) => ({ k, v: asStr(v) })),
)

const contentArg = computed(() => asStr(props.card.arguments?.content) || asStr(props.card.arguments?.prompt))
const oldStr = computed(() => asStr(props.card.arguments?.old_string))
const newStr = computed(() => asStr(props.card.arguments?.new_string))
const isDiff = computed(() => Boolean(oldStr.value || newStr.value))
const output = computed(() => props.card.resultPreview ?? '')

const diffLines = computed(() => {
  const out: { sign: '-' | '+'; text: string }[] = []
  if (oldStr.value) for (const t of oldStr.value.split('\n')) out.push({ sign: '-', text: t })
  if (newStr.value) for (const t of newStr.value.split('\n')) out.push({ sign: '+', text: t })
  return out
})

const hasBody = computed(() => argRows.value.length > 0 || Boolean(contentArg.value) || isDiff.value || Boolean(output.value) || Boolean(props.card.riskSummary) || (props.card.images?.length ?? 0) > 0 || Boolean(props.card.imageMissing))
const open = computed(() => manual.value ?? props.card.expanded ?? false)
const long = computed(() => output.value.length > 700 || output.value.split('\n').length > 14)

function toggle() { if (hasBody.value) manual.value = !open.value }

/**
 * 展开 / 收起用 GSAP 做一次高度补间。
 *
 * 只动 height 到 auto 并配合透明度：内容长度不可预知，纯 CSS transition 无法从 0
 * 过渡到 auto，而这一步的瞬时重排只发生在用户点开的瞬间（不是每帧），代价可以接受。
 * 关闭动画时直接切换显示，不做多余计算。
 */
watch(open, (value, previous) => {
  const element = bodyRef.value
  if (!element || previous === undefined) return
  // 动画开关合并到水滴动画开关：关掉水滴动画的同时也关掉工具卡展开动画，
  // 让用户在「要动效 / 不要动效」上只有一个总开关。
  if (prefersReducedMotion() || !config.sendMorphAnimation || config.allAnimationsOff) {
    gsap.killTweensOf(element)
    gsap.set(element, { clearProps: 'transform,opacity,transformOrigin' })
    collapsing.value = false
    return
  }
  gsap.killTweensOf(element)
  if (value) {
    collapsing.value = false
    // 展开：用 scaleY 替代 height 动画 —— 不触发重排，GPU 合成，
    // Android WebView 里长列表工具卡展开不再整屏闪。
    nextTick(() => requestAnimationFrame(() => {
      if (!open.value || config.allAnimationsOff || prefersReducedMotion()) return
      gsap.fromTo(element,
        { scaleY: 0.05, opacity: 0, transformOrigin: 'top center' },
        {
          scaleY: 1, opacity: 1,
          duration: 0.28, ease: 'power3.out',
          onComplete: () => { gsap.set(element, { clearProps: 'scaleY,opacity,transformOrigin' }) },
        })
    }))
  } else {
    // 收起：先播动画再允许 v-show 隐藏（collapsing 标志保持元素可见）。
    collapsing.value = true
    gsap.fromTo(element,
      { scaleY: 1, opacity: 1, transformOrigin: 'top center' },
      {
        scaleY: 0.05, opacity: 0,
        duration: 0.22, ease: 'power3.in',
        onComplete: () => {
          gsap.set(element, { clearProps: 'scaleY,opacity,transformOrigin' })
          collapsing.value = false
        },
      })
  }
})

watch(() => config.allAnimationsOff, (off) => {
  if (!off || !bodyRef.value) return
  gsap.killTweensOf(bodyRef.value)
  gsap.set(bodyRef.value, { clearProps: 'transform,opacity,transformOrigin' })
  collapsing.value = false
})

onBeforeUnmount(() => {
  if (bodyRef.value) gsap.killTweensOf(bodyRef.value)
})
</script>

<template>
  <div ref="rootEl" class="tool" :class="[st.cls, { open }]" :data-call-id="card.callId">
    <button class="head" :class="{ tapable: hasBody }" @click="toggle">
      <span class="tile" :class="st.cls">
        <CoomiIcon :name="meta.icon" :size="17" />
        <span v-if="st.spin" class="ring" />
      </span>

      <span class="txt">
        <span class="verb">{{ meta.verb }}</span>
        <code v-if="target" class="target">{{ target }}</code>
      </span>

      <span class="st" :class="st.cls">
        <CoomiIcon v-if="st.icon" :name="st.icon" :size="14" />
        <span v-if="st.label">{{ st.label }}</span>
        <span v-if="card.elapsed != null" class="ms">{{ card.elapsed.toFixed(1) }}s</span>
      </span>

      <CoomiIcon v-if="hasBody" name="chevronRight" :size="14" class="chev" :class="{ open }" />
    </button>

    <div v-if="card.status === 'awaiting_approval'" class="risk">
      <CoomiIcon name="alert" :size="15" />
      <span>{{ card.riskSummary || '需要你授权后才会执行' }}<template v-if="card.access"> · {{ card.access }}</template></span>
    </div>

    <div v-show="(open || collapsing) && hasBody" ref="bodyRef" class="body">
      <!-- 图片瀑布流：工具产生的图片平铺展示，点击全屏预览 -->
      <div v-if="card.images && card.images.length" class="sec" :class="{ showimg: isShowImage }">
        <p class="slabel">图片</p>
        <div class="imgs" :class="{ showimg: isShowImage }">
          <img
            v-for="(src, i) in card.images"
            :key="i"
            class="thumb"
            :class="{ showimg: isShowImage }"
            :src="src"
            :alt="`图片 ${i + 1}`"
            loading="lazy"
            decoding="async"
            @click.stop="openPreview(src)"
          />
        </div>
        <p v-if="isShowImage && imgPath" class="ipath">{{ imgPath }}</p>
      </div>
      <div v-else-if="card.imageMissing" class="sec">
        <p class="slabel">图片</p>
        <p class="inone">找不到图片：图片数据不可用（可能已被上下文压缩清理）</p>
      </div>

      <div v-if="argRows.length" class="sec">
        <p class="slabel">参数</p>
        <div class="args">
          <div v-for="r in argRows" :key="r.k" class="arg">
            <span class="ak">{{ r.k }}</span>
            <code class="av">{{ r.v }}</code>
          </div>
        </div>
      </div>

      <div v-if="isDiff" class="sec">
        <p class="slabel">改动</p>
        <div class="diff">
          <div v-for="(l, i) in diffLines" :key="i" class="dl" :class="l.sign === '+' ? 'add' : 'del'">
            <span class="dsign">{{ l.sign }}</span><span class="dtext">{{ l.text || ' ' }}</span>
          </div>
        </div>
      </div>

      <div v-if="contentArg && !isDiff" class="sec">
        <p class="slabel">内容</p>
        <pre class="mono">{{ contentArg }}</pre>
      </div>

      <div v-if="output" class="sec">
        <p class="slabel">{{ card.isError ? '错误输出' : '输出' }}</p>
        <pre class="mono out" :class="{ err: card.isError, clip: long && !full }">{{ output }}</pre>
        <button v-if="long" class="more" @click.stop="full = !full">
          {{ full ? '收起' : '展开全部' }}
        </button>
      </div>
    </div>

    <!-- 全屏图片预览：点击放大 / 另存为 -->
    <Teleport to="body">
      <div v-if="previewSrc" class="iv-mask">
        <div
          ref="previewStage"
          class="iv-stage"
          @pointerdown="onPreviewPointerDown"
          @pointermove="onPreviewPointerMove"
          @pointerup="onPreviewPointerEnd"
          @pointercancel="onPreviewPointerEnd"
          @dblclick.prevent="togglePreviewZoom"
        >
          <img ref="previewImage" :src="previewSrc" class="iv-img" :style="previewTransform" decoding="async" draggable="false" />
        </div>
        <div class="iv-bar">
          <button class="iv-btn primary" @click.stop="savePreview">另存为</button>
          <button class="iv-btn" @click.stop="closePreview">关闭</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tool {
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--bg); overflow: hidden;
  transition: border-color .16s, background .16s;
}
.tool.run { border-color: var(--blue-border); }
.tool.err { border-color: var(--danger-border); }
.tool.wait { border-color: var(--orange-border); background: var(--orange-soft); }

/* 运行中：左边一条呼吸的光带，比转圈更容易在长时间线里被扫到。 */
.tool.run { position: relative; }
.tool.run::before {
  content: ''; position: absolute; inset: 0 auto 0 0; width: 2px;
  background: linear-gradient(180deg, transparent, var(--blue), transparent);
  animation: glow 1.4s ease-in-out infinite;
}
@keyframes glow { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }

.head {
  display: flex; align-items: center; gap: 10px;
  width: 100%; min-height: 46px; padding: 8px 11px;
  border: 0; background: none; text-align: left;
}
.head.tapable:active { background: var(--fill); }

.tile {
  position: relative; display: grid; place-items: center; flex-shrink: 0;
  width: 30px; height: 30px; border-radius: 9px;
  background: var(--fill-strong); color: var(--text-2);
}
.tile.run { background: var(--blue-soft); color: var(--blue); }
.tile.ok { background: var(--ok-soft); color: var(--ok); }
.tile.err { background: var(--danger-soft); color: var(--danger); }
.tile.wait { background: var(--bg); color: var(--orange); }
.tile.cancelled { background: var(--fill-strong); color: var(--text-3); }
.ring {
  position: absolute; inset: 0;
  border-radius: 12px;
  pointer-events: none;
}
.ring::before {
  content: '';
  position: absolute; left: 8px; top: 50%;
  width: 6px; height: 6px; margin-top: -3px;
  border-radius: 50%;
  background: var(--blue);
  /* 用 transform 跑位移：早前动画 left 会每帧触发重排，长列表里工具卡一跑就整屏闪。 */
  animation: coomi-dot-travel 1.15s ease-in-out infinite;
  will-change: transform, opacity;
}
@keyframes coomi-dot-travel {
  0% { transform: translateX(0); opacity: .25; }
  20% { opacity: 1; }
  50% { transform: translateX(6px); opacity: 1; }
  75% { opacity: .6; }
  100% { transform: translateX(0); opacity: .25; }
}

.txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.verb { font-size: 13.8px; font-weight: 600; color: var(--text); }
.target {
  font-family: var(--font-mono); font-size: 11.6px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.st {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
  font-size: 11.5px; font-weight: 600; color: var(--text-3);
}
.st.run { color: var(--blue); }
.st.ok { color: var(--ok); }
.st.err { color: var(--danger); }
.st.wait { color: var(--orange); }
.st.cancelled { color: var(--text-3); }
.ms { font-weight: 400; color: var(--text-3); }
.chev { flex-shrink: 0; color: var(--text-3); transition: transform .18s; }
.chev.open { transform: rotate(90deg); }

.risk {
  display: flex; align-items: flex-start; gap: 7px;
  padding: 8px 12px 10px; border-top: 1px solid var(--orange-border);
  font-size: 12.5px; line-height: 1.55; color: #8a4a30;
}
.risk :deep(svg) { flex-shrink: 0; margin-top: 1px; color: var(--orange); }

.body { border-top: 1px solid var(--border); padding: 4px 11px 11px; }
.sec { margin-top: 9px; }
.slabel { font-size: 10.5px; font-weight: 600; letter-spacing: .06em; color: var(--text-3); text-transform: uppercase; }

.args { margin-top: 5px; display: flex; flex-direction: column; gap: 4px; }
.arg { display: flex; gap: 8px; font-size: 12px; line-height: 1.5; }
.ak { flex-shrink: 0; min-width: 68px; color: var(--text-3); }
.av {
  flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 11.6px;
  color: var(--code-text); word-break: break-all;
}

.mono {
  margin-top: 6px; padding: 9px 10px;
  border-radius: var(--r-sm); background: var(--code-bg);
  font-family: var(--font-mono); font-size: 11.8px; line-height: 1.6;
  color: var(--code-text); white-space: pre-wrap; word-break: break-word;
  overflow-x: auto;
}
.out.err { background: var(--danger-soft); color: #9b3a2c; }
.out.clip { max-height: 210px; overflow: hidden; mask-image: linear-gradient(180deg, #000 72%, transparent); }
.more {
  width: 100%; margin-top: 6px; padding: 7px 0;
  border: 0; border-radius: var(--r-sm); background: var(--fill);
  font-size: 12px; font-weight: 600; color: var(--text-2);
}
.more:active { background: var(--fill-press); }

.diff {
  margin-top: 6px; border-radius: var(--r-sm);
  background: var(--code-bg); overflow: hidden;
  font-family: var(--font-mono); font-size: 11.6px; line-height: 1.62;
}
.dl { display: flex; gap: 6px; padding: 0 8px; }
.dl.del { background: #fdecea; color: #99392c; }
.dl.add { background: #e9f7ef; color: #1c7a52; }
.dsign { flex-shrink: 0; opacity: .55; }
.dtext { flex: 1; white-space: pre-wrap; word-break: break-word; }

/* ── 图片瀑布流（卡片内缩略图网格）── */
.imgs {
  display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px;
}
.thumb {
  width: 96px; height: 96px; object-fit: cover;
  border-radius: 10px; border: 1px solid var(--border);
  background: var(--fill);
}
.thumb:active { opacity: .8; }

/* show_image：大图展示 + 底部路径 */
.imgs.showimg {
  flex-direction: column; align-items: stretch;
}
.thumb.showimg {
  width: 100%; max-width: 340px; height: auto; max-height: 340px;
  object-fit: contain; margin-inline: auto;
}
.ipath {
  margin-top: 6px; font-family: var(--font-mono); font-size: 11.4px;
  color: var(--text-3); word-break: break-all;
}
.inone {
  margin-top: 4px; font-size: 12.5px; color: var(--text-3);
}

/* ── 全屏图片预览 ── */
.iv-mask {
  position: fixed; inset: 0; z-index: 200;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: rgba(4, 6, 10, .92);
  padding: 18px 14px calc(var(--safe-bottom, 0px) + 18px);
}
.iv-stage {
  position: relative; flex: 1; align-self: stretch; min-height: 0;
  display: grid; place-items: center; overflow: hidden;
  touch-action: none; user-select: none;
}
.iv-img {
  max-width: 100%; max-height: 100%; object-fit: contain;
  transform-origin: center; will-change: transform;
}
.iv-bar {
  display: flex; align-items: center; gap: 10px; margin-top: 14px;
}
.iv-btn {
  min-width: 84px; height: 38px; padding: 0 16px; border-radius: var(--r-pill);
  background: rgba(255, 255, 255, .12); color: #fff;
  font-size: 13.5px; font-weight: 600;
}
.iv-btn:active { background: rgba(255, 255, 255, .2); }
.iv-btn.primary { background: var(--blue); }
</style>
