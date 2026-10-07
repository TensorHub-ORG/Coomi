import type { Router } from 'vue-router'
import { closeTopOverlay } from './overlayStack'

type BackFallback = 'dashboard' | string

function hasRouterHistory(): boolean {
  return Boolean(window.history.state?.back)
}

export function goBack(router: Router, fallback: BackFallback): void {
  if (fallback === 'dashboard' && window.CoomiAndroid?.openDashboard) {
    window.CoomiAndroid.openDashboard()
    return
  }
  if (hasRouterHistory()) {
    router.back()
    return
  }
  void router.replace(fallback === 'dashboard' ? '/' : fallback)
}

type BackTarget = 'session' | 'console' | 'exit' | string

/** 每个路由的父级(与各页面左上角返回按钮的落点一致)。 */
const routeParents: Array<[RegExp, BackTarget]> = [
  [/^\/providers\/[^/]+/, '/providers'],
  [/^\/life\//, '/life'],
  [/^\/im\/[^/]+/, '/im'],
  [/^\/collab\/[^/]+/, '/collab'],
  [/^\/settings/, 'session'],
  [/^\/appearance/, '/settings'],
  [/^\/persona/, '/settings'],
  [/^\/studio/, 'session'],
  [/^\/collab/, 'session'],
  [/^\/im/, 'session'],
  [/^\/quick-commands/, 'console'],
  [/^\/(hooks|memory|runtime|files|catalog|workflows|maintenance|usage|updates|prompts|ux-program|git|restore|ops|data)/, 'console'],
  [/^\/providers/, 'console'],
  [/^\/life/, 'console'],
]

function applyBack(router: Router, target: BackTarget): void {
  if (target === 'session') { void router.replace('/'); return }
  if (target === 'console') {
    if (window.CoomiAndroid?.openDashboard) window.CoomiAndroid.openDashboard()
    else void router.replace('/home')
    return
  }
  if (target === 'exit') {
    if (window.CoomiAndroid?.closeHostActivity) window.CoomiAndroid.closeHostActivity()
    return
  }
  void router.replace(target)
}

/** 统一返回入口: 覆盖层 → 嵌套历史 → 每页父级。硬件返回与页内按钮共用。 */
export function systemBack(router: Router): 'handled' | 'native-console' | 'native-exit' {
  if (closeTopOverlay()) return 'handled'
  const route = router.currentRoute.value.path
  if (route === '/') return 'native-console'
  if (route === '/home') return 'native-exit'
  if (window.history.state?.back) { router.back(); return 'handled' }
  for (const [re, target] of routeParents) {
    if (re.test(route)) { applyBack(router, target); return 'handled' }
  }
  applyBack(router, 'console')
  return 'handled'
}

export function installSystemBackHandler(router: Router): void {
  window.__coomiHandleSystemBack = () => {
    const result = systemBack(router)
    return result === 'handled'
  }
}
