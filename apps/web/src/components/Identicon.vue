<script setup lang="ts">
/**
 * GitHub 风格 identicon 头像：由 seed 确定性生成 5×5 对称像素图案。
 * 同一 seed 恒定同一图案，无需网络与存储。
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ seed: string; size?: number }>(), { size: 32 })

function hash(text: string): number {
  let h = 2166136261
  for (let index = 0; index < text.length; index++) {
    h ^= text.charCodeAt(index)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

const seedHash = computed(() => hash(props.seed))

/** 15 位比特流 → 左 3 列，右 2 列镜像。 */
const cells = computed(() => {
  const out: Array<{ x: number; y: number }> = []
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 5; y++) {
      if ((seedHash.value >>> (x * 5 + y)) & 1) {
        out.push({ x, y })
        if (x < 2) out.push({ x: 4 - x, y })
      }
    }
  }
  return out
})

const hue = computed(() => seedHash.value % 360)
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 5 5"
    shape-rendering="crispEdges"
    class="identicon"
    role="img"
    :aria-label="`${seed} 的头像`"
  >
    <rect width="5" height="5" :fill="`hsl(${hue}, 70%, 91%)`" />
    <rect v-for="(cell, index) in cells" :key="index" :x="cell.x" :y="cell.y" width="1" height="1" :fill="`hsl(${hue}, 52%, 40%)`" />
  </svg>
</template>

<style scoped>
.identicon { display: block; }
</style>
