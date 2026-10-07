import type { Router } from 'vue-router'
import { BackNavigation, type BackTarget } from './backNavigation'
import { closeTopOverlay } from './overlayStack'

const navigation = new BackNavigation()
let pageBack: { component: unknown; handler: () => void } | null = null

export function registerPageBack(router: Router, handler: () => void): () => void {
  const records = router.currentRoute.value.matched
  const registration = { component: records[records.length - 1]?.components?.default, handler }
  pageBack = registration
  return () => { if (pageBack === registration) pageBack = null }
}

function applyBack(router: Router, target: BackTarget): void {
  if (target === 'dashboard') {
    if (window.CoomiAndroid?.openDashboard) window.CoomiAndroid.openDashboard()
    else {
      navigation.prepareReturn('/')
      void router.replace('/')
    }
    return
  }
  if (target === 'exit') {
    if (window.CoomiAndroid?.closeHostActivity) window.CoomiAndroid.closeHostActivity()
    else applyBack(router, 'dashboard')
    return
  }
  navigation.prepareReturn(target)
  void router.replace(target)
}

export function goBack(router: Router, fallback: BackTarget = 'dashboard'): void {
  if (closeTopOverlay()) return
  const route = router.currentRoute.value
  applyBack(router, route.path === '/' ? 'dashboard' : navigation.target(route.fullPath, fallback))
}

export function systemBack(router: Router): 'handled' | 'native-console' {
  if (closeTopOverlay()) return 'handled'
  const records = router.currentRoute.value.matched
  if (pageBack && pageBack.component === records[records.length - 1]?.components?.default) {
    pageBack.handler()
    return 'handled'
  }
  if (router.currentRoute.value.path === '/') return 'native-console'
  applyBack(router, navigation.target(router.currentRoute.value.fullPath))
  return 'handled'
}

export function installSystemBackHandler(router: Router): void {
  router.afterEach((to, from, failure) => {
    if (!failure && !from.name && new URLSearchParams(window.location.search).get('entry') === 'console') {
      navigation.openNative(to.fullPath)
    }
    if (!failure) navigation.enter(to.fullPath, from.name ? from.fullPath : undefined)
  })
  window.addEventListener('coomi:navigate', event => {
    const path = (event as CustomEvent<{ route?: string }>).detail?.route
    if (!path?.startsWith('/') || path.startsWith('//')) return
    navigation.openNative(path)
    void router.replace(path)
  })
  window.__coomiHandleSystemBack = () => systemBack(router) === 'handled'
}
