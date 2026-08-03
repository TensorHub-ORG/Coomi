import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { readThemeMode, applyTheme, type ThemeMode } from './stores/config'
import './styles/global.css'

/**
 * 主题初始化：
 * - Android WebView 内由 CoomiActivity 经 JS 桥提供档位（优先级最高）；
 * - 桌面浏览器：localStorage 有手动档位则用之，否则跟随系统深浅色实时切换。
 */
function initTheme() {
  const bridge = (window as any).CoomiAndroid
  if (bridge && typeof bridge.getThemeMode === 'function') {
    // 原生全权负责档位与 data-theme 注入（含系统深浅色切换时实时重注入）。
    try { applyTheme(readThemeMode()) } catch { /* 桥异常时保持默认 */ }
    return
  }
  const apply = (mode: ThemeMode) => applyTheme(mode)
  const saved = localStorage.getItem('coomi.themeMode')
  if (saved === 'light' || saved === 'dark') {
    apply(saved)
    return
  }
  // 跟随系统：监听系统深浅色变化实时切换
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  apply('system')
  const onChange = () => apply('system')
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange)
  else mq.addListener(onChange)
}

initTheme()
createApp(App).use(createPinia()).use(router).mount('#app')
