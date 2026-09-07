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
    <CoomiMark :size="52" class="logo" />
    <h1>有什么可以帮你？</h1>
    <p class="sub">我在你手机里的 Linux 环境真实执行命令、读写文件、跑脚本。</p>

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
        <CoomiIcon :name="m.icon" :size="15" />
        <span>{{ m.label }}</span>
      </button>
    </div>
    <p class="hint">{{ hint }}</p>

    <div class="sugs">
      <button
        v-for="(s, i) in SUGGESTIONS"
        :key="s.text"
        class="sug cascade"
        :style="{ animationDelay: 40 * i + 'ms' }"
        @click="s.guide ? session.sendGuide(s.guide) : session.sendMessage(s.text)"
      >
        <span class="sicon"><CoomiIcon :name="s.icon" :size="17" /></span>
        <span class="stext">{{ s.text }}</span>
        <CoomiIcon name="chevronRight" :size="14" class="sarrow" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.empty {
  margin: auto 0; padding: 22px 4px 8px;
  display: flex; flex-direction: column; align-items: center;
  text-align: center;
}
.logo { margin-bottom: 14px; animation: coomi-breathe 3.4s ease-in-out infinite; }
@keyframes coomi-breathe {
  0%, 100% { transform: scale(1); opacity: .88; filter: drop-shadow(0 0 0 transparent); }
  50% { transform: scale(1.05); opacity: 1; filter: drop-shadow(0 0 10px color-mix(in srgb, var(--blue) 35%, transparent)); }
}
h1 { font-size: 21px; font-weight: 600; letter-spacing: -.3px; color: var(--text); }
.sub {
  max-width: 268px; margin-top: 8px;
  font-size: 13.5px; line-height: 1.65; color: var(--text-3);
}
.demobar {
  display: flex; align-items: flex-start; gap: 7px;
  max-width: 320px; margin-top: 14px; padding: 9px 12px;
  border-radius: var(--r-md); background: var(--orange-soft);
  font-size: 12.5px; line-height: 1.55; color: #8a4a30; text-align: left;
}
.demobar :deep(svg) { flex-shrink: 0; margin-top: 1px; color: var(--orange); }

.seg {
  display: flex; gap: 2px; margin-top: 20px; padding: 3px;
  border-radius: var(--r-pill); background: var(--fill);
}
.sitem {
  display: inline-flex; align-items: center; gap: 5px;
  height: 34px; padding: 0 14px;
  border: 0; border-radius: var(--r-pill); background: none;
  font-size: 13.5px; font-weight: 600; color: var(--text-3);
  transition: background .16s, color .16s;
}
.sitem.on { background: var(--bg); color: var(--blue); box-shadow: var(--shadow-1); }
.hint { min-height: 17px; margin-top: 10px; font-size: 12px; color: var(--text-3); }

.sugs { width: 100%; display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
.sug {
  display: flex; align-items: center; gap: 11px;
  padding: 12px 12px 12px 11px;
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); text-align: left;
}
.sug:active { background: var(--fill); }
.sicon {
  display: grid; place-items: center; flex-shrink: 0;
  width: 32px; height: 32px; border-radius: 10px;
  background: var(--blue-soft); color: var(--blue);
}
.stext { flex: 1; font-size: 14.5px; line-height: 1.4; color: var(--text); }
.sarrow { color: var(--text-3); }
</style>

