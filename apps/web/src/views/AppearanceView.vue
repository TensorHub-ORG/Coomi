<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useConfigStore, THEME_MODES } from '@/stores/config'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { goBack } from '@/bridge/navigation'
import { normalizeDisplayScale } from '@/utils/displayScale'

const router = useRouter()
const config = useConfigStore()
const customAppearanceEnabled = ref(document.documentElement.dataset.customAppearance === 'true')
const displayScale = ref(100)

function readDisplayScale() {
  try {
    const native = window.CoomiAndroid?.getAppearanceConfig?.()
    const configValue = native ? (JSON.parse(native) as AppearanceConfig).displayScale : undefined
    const stored = localStorage.getItem('coomi.appearance.displayScale')
    displayScale.value = Math.round(normalizeDisplayScale(configValue ?? stored ?? 1) * 100)
  } catch { displayScale.value = 100 }
}

function applyScale(value = displayScale.value) {
  displayScale.value = Math.max(75, Math.min(110, Math.round(value)))
  const scale = displayScale.value / 100
  window.__coomiApplyDisplayScale?.(scale)
  window.CoomiAndroid?.setDisplayScale?.(scale)
}

function syncCustomAppearance() {
  customAppearanceEnabled.value = document.documentElement.dataset.customAppearance === 'true'
}

onMounted(() => {
  readDisplayScale()
  window.addEventListener('coomi:appearance-changed', syncCustomAppearance)
})
onBeforeUnmount(() => window.removeEventListener('coomi:appearance-changed', syncCustomAppearance))
</script>

<template>
  <div class="page">
    <PageHead title="外观" @back="goBack(router, '/settings')" />
    <main class="body">
      <p class="sec-label">主题</p>
      <div class="group theme-options" :class="{ disabled: customAppearanceEnabled }">
        <button v-for="m in THEME_MODES" :key="m.mode" class="row" :disabled="customAppearanceEnabled" @click="config.setThemeMode(m.mode)">
          <span class="ri" :class="{ on: config.themeMode === m.mode }">
            <CoomiIcon :name="m.mode === 'dark' ? 'moon' : m.mode === 'light' ? 'sun' : 'phone'" :size="17" />
          </span>
          <span class="rt">
            <span class="rmain">{{ m.label }}</span>
            <span class="rsub">{{ m.desc }}</span>
          </span>
          <CoomiIcon v-if="config.themeMode === m.mode" name="check" :size="17" class="tick" />
        </button>
      </div>
      <p v-if="customAppearanceEnabled" class="note">当前由系统或原生外观配置接管主题选择。</p>
      <p class="sec-label scale-label">显示比例</p>
      <div class="group scale-card">
        <div class="scale-head">
          <span><strong>软件显示比例</strong><small>缩小后同一屏可显示更多内容，手机状态栏保持原大小</small></span>
          <b>{{ displayScale }}%</b>
        </div>
        <input v-model.number="displayScale" type="range" min="75" max="110" step="5" aria-label="软件显示比例" @input="applyScale()" />
        <div class="scale-presets">
          <button v-for="value in [80, 90, 100]" :key="value" :class="{ on: displayScale === value }" @click="applyScale(value)">{{ value }}%</button>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); }
.sec-label { margin: 2px 0 0; }
.group { border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.row { display: flex; align-items: center; gap: 11px; width: 100%; min-height: 56px; padding: 11px 13px; text-align: left; background: var(--bg); }
.row + .row { border-top: 1px solid var(--border); }
.row:active { background: var(--fill); }
.theme-options.disabled { opacity: .42; }
.theme-options .row:disabled { color: inherit; cursor: default; }
.theme-options .row:disabled:active { background: var(--bg); }
.ri { display: grid; place-items: center; flex-shrink: 0; width: 32px; height: 32px; border-radius: 9px; background: var(--fill-strong); color: var(--text-2); }
.ri.on { background: var(--blue-soft); color: var(--blue); }
.rt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.rmain { font-size: 14.5px; font-weight: 550; color: var(--text); }
.rsub { font-size: 12.2px; line-height: 1.5; color: var(--text-3); }
.tick { flex-shrink: 0; color: var(--blue); }
.note { margin: 12px 4px 0; font-size: 12px; line-height: 1.6; color: var(--text-3); }
.scale-label { margin-top: 22px; }
.scale-card { padding: 15px 14px 13px; }
.scale-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.scale-head span { display:flex; flex-direction:column; gap:3px; min-width:0; }
.scale-head strong { font-size:14.5px; color:var(--text); }
.scale-head small { font-size:12px; line-height:1.5; color:var(--text-3); }
.scale-head b { flex-shrink:0; color:var(--blue); font-size:14px; }
.scale-card input { width:100%; margin:14px 0 10px; accent-color:var(--blue); }
.scale-presets { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; }
.scale-presets button { height:32px; border-radius:10px; background:var(--fill); color:var(--text-2); font-size:12.5px; }
.scale-presets button.on { background:var(--blue-soft); color:var(--blue); font-weight:650; box-shadow:inset 0 0 0 1px var(--blue-border); }
</style>
