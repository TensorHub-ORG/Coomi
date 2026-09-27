import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { installSystemBackHandler } from './bridge/navigation'
import { readThemeMode, applyTheme, type ThemeMode } from './stores/config'
import './styles/global.css'

const CUSTOM_PROPERTIES = [
  '--page', '--bg', '--bg-card', '--bg-elevated', '--fill', '--bg-input', '--code-bg',
  '--fill-strong', '--fill-press', '--border', '--border-strong', '--text', '--text-2', '--text-3',
  '--code-text', '--blue', '--blue-press', '--blue-soft', '--blue-soft-2', '--blue-border',
  '--accent', '--accent-hover', '--accent-soft', '--accent-border', '--user-bubble', '--user-text',
  '--ok', '--ok-soft', '--warn', '--warn-soft', '--orange', '--orange-soft', '--orange-border',
  '--danger', '--danger-soft', '--danger-border',
]

function mixColor(first: string, second: string, secondWeight: number): string {
  const parse = (value: string) => [1, 3, 5].map(index => Number.parseInt(value.slice(index, index + 2), 16))
  const [r1, g1, b1] = parse(first)
  const [r2, g2, b2] = parse(second)
  const channel = (a: number, b: number) => Math.round(a * (1 - secondWeight) + b * secondWeight).toString(16).padStart(2, '0')
  return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}`
}

function contrastText(background: string): string {
  const [r, g, b] = [1, 3, 5].map(index => Number.parseInt(background.slice(index, index + 2), 16))
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#16181c' : '#ffffff'
}

function overlayColor(background: string, opacity: number): string {
  const normalized = /^#[0-9a-f]{6}$/i.test(background) ? background : '#ffffff'
  const [r, g, b] = [1, 3, 5].map(index => Number.parseInt(normalized.slice(index, index + 2), 16))
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

function applyAppearance(config: AppearanceConfig) {
  const root = document.documentElement
  const customAppearanceEnabled = Boolean(config.customEnabled)
  root.dataset.customAppearance = customAppearanceEnabled ? 'true' : 'false'
  for (const property of CUSTOM_PROPERTIES) root.style.removeProperty(property)
  const colors = config.colors ?? {}
  if (config.customEnabled) {
    const set = (property: string, key: string) => {
      const value = colors[key]
      if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value ?? '')) root.style.setProperty(property, value)
    }
    set('--page', 'page')
    for (const property of ['--bg', '--bg-card', '--bg-elevated']) set(property, 'surface')
    for (const property of ['--fill', '--bg-input', '--code-bg']) set(property, 'fill')
    for (const property of ['--border', '--border-strong']) set(property, 'border')
    set('--text', 'text'); set('--text-2', 'text_secondary'); set('--text-3', 'text_muted')
    for (const property of ['--blue', '--accent', '--user-bubble']) set(property, 'accent')
    set('--ok', 'success'); set('--warn', 'warning'); set('--danger', 'danger')
    const surface = colors.surface
    const text = colors.text
    const fill = colors.fill
    const border = colors.border
    const accent = colors.accent
    const success = colors.success
    const warning = colors.warning
    const danger = colors.danger
    const valid = (value?: string) => /^#[0-9a-f]{6}$/i.test(value ?? '')
    if (valid(fill) && valid(text)) {
      root.style.setProperty('--fill-strong', mixColor(fill, text, 0.07))
      root.style.setProperty('--fill-press', mixColor(fill, text, 0.13))
    }
    if (valid(border) && valid(text)) root.style.setProperty('--border-strong', mixColor(border, text, 0.12))
    if (valid(text)) root.style.setProperty('--code-text', text)
    if (valid(accent) && valid(surface)) {
      root.style.setProperty('--blue-press', mixColor(accent, '#000000', 0.18))
      root.style.setProperty('--blue-soft', mixColor(accent, surface, 0.86))
      root.style.setProperty('--blue-soft-2', mixColor(accent, surface, 0.76))
      root.style.setProperty('--blue-border', mixColor(accent, surface, 0.58))
      root.style.setProperty('--accent-hover', mixColor(accent, '#000000', 0.18))
      root.style.setProperty('--accent-soft', mixColor(accent, surface, 0.86))
      root.style.setProperty('--accent-border', mixColor(accent, surface, 0.58))
      root.style.setProperty('--user-text', contrastText(accent))
    }
    if (valid(success) && valid(surface)) root.style.setProperty('--ok-soft', mixColor(success, surface, 0.86))
    if (valid(warning) && valid(surface)) {
      root.style.setProperty('--warn-soft', mixColor(warning, surface, 0.86))
      root.style.setProperty('--orange', warning)
      root.style.setProperty('--orange-soft', mixColor(warning, surface, 0.86))
      root.style.setProperty('--orange-border', mixColor(warning, surface, 0.62))
    }
    if (valid(danger) && valid(surface)) {
      root.style.setProperty('--danger-soft', mixColor(danger, surface, 0.86))
      root.style.setProperty('--danger-border', mixColor(danger, surface, 0.62))
    }
  }
  const chatBackgroundEnabled = Boolean(config.chatBackground)
  root.dataset.chatBackground = chatBackgroundEnabled ? 'true' : 'false'
  const mask = Math.max(0, Math.min(95, config.chatMask ?? 72)) / 100
  const activeSurface = config.customEnabled && /^#[0-9a-f]{6}$/i.test(colors.surface ?? '')
    ? colors.surface
    : getComputedStyle(root).getPropertyValue('--bg').trim()
  root.style.setProperty(
    '--chat-background-overlay',
    chatBackgroundEnabled ? overlayColor(activeSurface, mask) : activeSurface,
  )
  root.style.setProperty(
    '--chat-background-image',
    chatBackgroundEnabled
      ? `url('/__coomi_appearance/chat-background?v=${config.revision ?? 0}')`
      : 'none',
  )
  window.dispatchEvent(new CustomEvent('coomi:appearance-changed', {
    detail: { customEnabled: customAppearanceEnabled },
  }))
}

window.__coomiApplyAppearance = applyAppearance

/**
 * 主题初始化：
 * - Android WebView 内由 CoomiActivity 经 JS 桥提供档位（优先级最高）；
 * - 桌面浏览器：localStorage 有手动档位则用之，否则跟随系统深浅色实时切换。
 */
function initTheme() {
  const bridge = (window as any).CoomiAndroid
  if (bridge && typeof bridge.getThemeMode === 'function') {
    // 原生全权负责档位与 data-theme 注入（含系统深浅色切换时实时重注入）。
    try {
      applyTheme(readThemeMode())
      if (typeof bridge.getAppearanceConfig === 'function') {
        applyAppearance(JSON.parse(String(bridge.getAppearanceConfig() ?? '{}')))
      }
    } catch { /* 桥异常时保持默认 */ }
    return
  }
  const apply = (mode: ThemeMode) => applyTheme(mode)
  const saved = readThemeMode()
  if (saved !== 'system') {
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
installSystemBackHandler(router)
createApp(App).use(createPinia()).use(router).mount('#app')
