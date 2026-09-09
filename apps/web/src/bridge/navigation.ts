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
    if (route === '/') return false
    // 三级页（记忆库/心情日记）先回二级（数字生命体）。
    if (route.startsWith('/life/')) goBack(router, '/life')
    else if (route === '/appearance' || route === '/persona') goBack(router, '/settings')
    else if (route.startsWith('/studio/')) goBack(router, '/studio')
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
      || route === '/ux-program'
      || route === '/studio'
      || route === '/providers'
      || route.startsWith('/providers/')
    ) goBack(router, 'dashboard')
    else goBack(router, '/')
    return true
  }
}
