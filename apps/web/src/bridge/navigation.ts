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

export function installSystemBackHandler(router: Router): void {
  window.__coomiHandleSystemBack = () => {
    if (closeTopOverlay()) return true
    const route = router.currentRoute.value.path
    // 会话页 / 控制台主页：交给原生（会话→控制台；控制台→退到桌面即退出）。
    if (route === '/' || route === '/home') return false
    // 三级页（记忆库/心情日记）先回二级（数字生命体）。
    if (route.startsWith('/life/')) goBack(router, '/life')
    else if (route === '/appearance' || route === '/persona') goBack(router, '/settings')
    else if (
      route === '/hooks'
      || route === '/life'
      || route === '/memory'
      || route === '/runtime'
      || route === '/custom-iteration'
      || route === '/files'
      || route === '/catalog'
      || route === '/workflows'
      || route === '/maintenance'
      || route === '/usage'
      || route === '/updates'
      || route === '/prompts'
      || route === '/ux-program'
      || route === '/git'
      || route === '/restore'
      || route === '/ops'
      || route === '/data'
      || route === '/collab'
      || route === '/im'
      || route === '/providers'
      || route.startsWith('/providers/')
    ) goBack(router, 'dashboard')
    else if (route.startsWith('/im/')) goBack(router, '/im')
    else if (route.startsWith('/collab/')) goBack(router, '/collab')
    else goBack(router, '/')
    return true
  }
}

/**
 * 统一返回入口（页面内返回按钮使用）：
 * 覆盖层 → 嵌套历史 → 分层兜底（会话页/控制台主页交给原生）。
 */
export function systemBack(router: Router): void {
  if (closeTopOverlay()) return
  const route = router.currentRoute.value.path
  if (route === '/' || route === '/home') {
    if (window.CoomiAndroid?.openDashboard) window.CoomiAndroid.openDashboard()
    else goBack(router, 'dashboard')
    return
  }
  if (route.startsWith('/life/')) { goBack(router, '/life'); return }
  if (route === '/appearance' || route === '/persona') { goBack(router, '/settings'); return }
  goBack(router, 'dashboard')
}
