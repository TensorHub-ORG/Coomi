<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useConfigStore, THEME_MODES } from '@/stores/config'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { goBack } from '@/bridge/navigation'

const router = useRouter()
const config = useConfigStore()
const customAppearanceEnabled = ref(document.documentElement.dataset.customAppearance === 'true')

function syncCustomAppearance() {
  customAppearanceEnabled.value = document.documentElement.dataset.customAppearance === 'true'
}

onMounted(() => window.addEventListener('coomi:appearance-changed', syncCustomAppearance))
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
</style>
