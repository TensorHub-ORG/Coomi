<script setup lang="ts">
/**
 * 空态首屏：品牌标记 + 模式分段控件 + 任务建议。
 * 三个模式不是装饰，各自映射到真实命令：
 *   快速 → set_permission_mode('auto')；计划 → enter_plan_mode；谨慎 → set_permission_mode('ask')。
 */
import { computed } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { useConnectionStore } from '@/stores/connection'
import CoomiIcon from './CoomiIcon.vue'
import CoomiMark from './CoomiMark.vue'

const session = useSessionStore()
const config = useConfigStore()
const connection = useConnectionStore()

const MODES = [
  { key: 'fast', label: '快速', icon: 'bolt', desc: '读写自动放行，破坏性操作仍会问你' },
  { key: 'plan', label: '计划', icon: 'target', desc: '先给方案，你确认之后才动手' },
  { key: 'careful', label: '谨慎', icon: 'shield', desc: '每一次写入都等你点头' },
] as const

const SUGGESTIONS: { icon: string; text: string; guide?: string }[] = [
  { icon: 'phone', text: '查看手机系统信息与型号信息' },
  { icon: 'globe', text: '今日科技圈热点话题' },
  { icon: 'sparkle', text: 'Coomi 新手使用指南', guide: 'newbie' },
  { icon: 'cube', text: '自定义拓展进化指南', guide: 'extension' },
]

const active = computed(() => (config.planMode ? 'plan' : config.permissionMode === 'ask' ? 'careful' : 'fast'))
const hint = computed(() => MODES.find(m => m.key === active.value)?.desc ?? '')

function pick(key: 'fast' | 'plan' | 'careful') {
  if (key === 'plan') {
    if (!config.planMode) session.togglePlanMode()
    return
  }
  if (config.planMode) session.togglePlanMode()
  session.setPermissionMode(key === 'fast' ? 'auto' : 'ask')
}
</script>

<template>
  <div class="empty">
    <div class="hero">
      <div class="mark-wrap">
        <CoomiMark :size="46" class="logo" />
        <span class="halo" aria-hidden="true" />
      </div>
      <h1>有什么可以帮你？</h1>
      <p class="sub">我在你手机里的 Linux 环境真实执行命令、读写文件、跑脚本。</p>
    </div>

    <p v-if="connection.demo" class="demobar">
      <CoomiIcon name="alert" :size="14" />
      <span>演示模式：对话由脚本驱动，只用来预览界面，不会真的执行任何命令。</span>
    </p>

    <div class="seg" role="tablist">
      <button
        v-for="m in MODES"
        :key="m.key"
        class="sitem"
        :class="{ on: active === m.key }"
        role="tab"
        :aria-selected="active === m.key"
        @click="pick(m.key)"
      >
        <CoomiIcon :name="m.icon" :size="14" />
        <span>{{ m.label }}</span>
      </button>
      <span class="seg-thumb" :class="'seg-' + active" aria-hidden="true" />
    </div>
    <p class="hint" :class="{ on: !!hint }">{{ hint || ' ' }}</p>

    <div class="sugs">
      <button
        v-for="(s, i) in SUGGESTIONS"
        :key="s.text"
        class="sug cascade"
        :style="{ animationDelay: 50 * i + 'ms' }"
        @click="s.guide ? session.sendGuide(s.guide) : session.sendMessage(s.text)"
      >
        <span class="sicon"><CoomiIcon :name="s.icon" :size="16" /></span>
        <span class="stext">{{ s.text }}</span>
        <span class="sarrow"><CoomiIcon name="chevronRight" :size="12" /></span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.empty {
  margin: 0 auto; padding: 10px 6px 10px;
  display: flex; flex-direction: column; align-items: center;
  text-align: center;
  max-width: 460px;
}
.hero { display: flex; flex-direction: column; align-items: center; }
.mark-wrap { position: relative; margin-bottom: 12px; }
.logo { display: block; animation: coomi-breathe 3.4s ease-in-out infinite; }
.halo {
  position: absolute; inset: -14px; z-index: -1; border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--blue) 20%, transparent), transparent 68%);
  animation: halo-pulse 3.4s ease-in-out infinite;
}
.halo::after {
  content: ''; position: absolute; inset: 10px; border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--blue) 10%, transparent), transparent 64%);
}
@keyframes halo-pulse {
  0%, 100% { opacity: .5; transform: scale(.96); }
  50% { opacity: 1; transform: scale(1.07); }
}
@keyframes coomi-breathe {
  0%, 100% { transform: scale(1); opacity: .92; }
  50% { transform: scale(1.04); opacity: 1; }
}
h1 {
  font-size: 24px; font-weight: 720; letter-spacing: -0.5px; color: var(--text);
  line-height: 1.28;
}
.sub {
  max-width: 320px; margin-top: 8px;
  font-size: 14px; line-height: 1.65; color: var(--text-2);
}
.demobar {
  display: flex; align-items: flex-start; gap: 7px;
  max-width: 320px; margin-top: 14px; padding: 9px 13px;
  border-radius: 12px; background: var(--orange-soft);
  font-size: 12.5px; line-height: 1.55; color: var(--orange); text-align: left;
}
.demobar :deep(svg) { flex-shrink: 0; margin-top: 1px; color: var(--orange); }

.seg {
  position: relative;
  display: flex; gap: 3px; margin-top: 16px; padding: 5px;
  border-radius: var(--r-pill); background: var(--fill);
}
.sitem {
  position: relative; z-index: 1;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 36px; min-width: 86px; padding: 0 14px;
  border: 0; border-radius: var(--r-pill); background: none;
  font-size: 13.5px; font-weight: 600; color: var(--text-3);
  transition: color .18s ease;
}
.sitem.on { color: var(--blue); }
.seg-thumb {
  position: absolute; top: 5px; bottom: 5px; z-index: 0;
  width: 86px;
  border-radius: var(--r-pill);
  background: var(--bg); box-shadow: 0 1px 4px rgba(23, 32, 54, 0.08), 0 3px 12px rgba(23, 32, 54, 0.07);
  transition: transform 0.34s var(--spring), left 0.34s var(--spring);
}
.seg-thumb.seg-fast { left: 5px; transform: none; }
.seg-thumb.seg-plan { left: 5px; transform: translateX(89px); }
.seg-thumb.seg-careful { left: 5px; transform: translateX(178px); }
.hint { min-height: 18px; margin-top: 8px; font-size: 12px; color: var(--text-3); transition: color .18s; }
.hint.on { color: var(--text-2); }

.sugs { width: 100%; display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.sug {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 12px 11px 11px;
  border: 1px solid var(--border); border-radius: 16px;
  background: var(--bg);
  box-shadow: var(--shadow-1);
  text-align: left;
  transition: transform 0.3s var(--spring), border-color .18s ease, box-shadow .18s ease;
}
.sug:active { transform: scale(0.96); background: var(--fill); border-color: var(--border-strong); }
@media (hover: hover) and (pointer: fine) {
  .sug:hover { transform: translateY(-2px); box-shadow: var(--shadow-2); border-color: var(--border-strong); }
}
.sicon {
  display: grid; place-items: center; flex-shrink: 0;
  width: 37px; height: 37px; border-radius: 12px;
  background: linear-gradient(135deg, var(--blue-soft), color-mix(in srgb, var(--blue-soft) 62%, var(--bg)));
  color: var(--blue);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--blue-border) 55%, transparent);
}
.stext { flex: 1; min-width: 0; font-size: 14px; line-height: 1.45; color: var(--text); font-weight: 500; }
.sarrow {
  display: grid; place-items: center; flex-shrink: 0;
  width: 26px; height: 26px; border-radius: 50%;
  background: var(--fill); color: var(--text-3);
  transition: background .16s, color .16s, transform .16s;
}
.sug:active .sarrow { background: var(--blue-soft); color: var(--blue); transform: translateX(2px); }
</style>

