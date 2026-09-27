<script setup lang="ts">
/**
 * Coomi 品牌标记。
 * 形状复刻 assets/coomi-agent.png：同心的四叶星环（两个椭圆求并即为一层花瓣）
 * 加中心浅蓝四角星。用 SVG 而不是位图，闪屏 / 顶栏 / 抽屉可以任意缩放不糊。
 */
withDefaults(defineProps<{ size?: number; muted?: boolean }>(), { size: 44, muted: false })

// 每层花瓣的半径：[短轴, 长轴]
const RINGS: [number, number][] = [
  [13.2, 23.4],
  [9.7, 19.4],
  [7.2, 14.6],
  [4.9, 10.6],
]
</script>

<template>
  <svg
    class="mark"
    :class="{ muted }"
    :width="size"
    :height="size"
    viewBox="0 0 48 48"
    aria-hidden="true"
  >
    <g v-for="(r, i) in RINGS" :key="i" :class="i % 2 === 0 ? 'ink' : 'paper'">
      <ellipse cx="24" cy="24" :rx="r[0]" :ry="r[1]" />
      <ellipse cx="24" cy="24" :rx="r[1]" :ry="r[0]" />
    </g>
    <path
      class="spark"
      d="M24 13.2 26.5 21.5 34.8 24 26.5 26.5 24 34.8 21.5 26.5 13.2 24 21.5 21.5Z"
    />
  </svg>
</template>

<style scoped>
.mark { display: block; flex-shrink: 0; }
.ink { fill: #2d61c6; }
.paper { fill: #ffffff; }
.spark { fill: #92b6ec; }
.mark.muted .ink { fill: var(--text-3); }
.mark.muted .spark { fill: var(--border-strong); }
</style>
