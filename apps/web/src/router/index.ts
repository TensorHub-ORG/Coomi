import { createRouter, createWebHashHistory, type RouteLocationNormalized, type RouterScrollBehavior } from 'vue-router'

// ── 导航方向跟踪 ──────────────────────────────────────────────
// 记录导航历史，判断当前导航是「前进」还是「返回」，
// 用于给页面转场指定滑动方向（进入从左滑入，返回从右滑回）。
const navHist: string[] = []   // 栈，元素为 route.fullPath
let navDirection: 'forward' | 'back' | 'replace' = 'replace'

export function getNavDirection() { return navDirection }

// ── 记住每个路由的滚动位置，返回时恢复 ─────────────────────────
// 记住每个路由的滚动位置，返回时恢复
const posCache = new Map<string, number>()
const scrollBehavior: RouterScrollBehavior = (to, from, savedPosition) => {
  if (from?.fullPath && from.matched.length) {
    posCache.set(from.fullPath, window.scrollY ?? posCache.get(from.fullPath) ?? 0)
  }
  if (navDirection === 'back' && savedPosition) {
    return new Promise<typeof savedPosition>((resolve) => setTimeout(() => resolve(savedPosition), 280))
  }
  if (navDirection === 'back') {
    const y = posCache.get(to.fullPath)
    if (y !== undefined) return new Promise<{ left: number; top: number }>((resolve) => setTimeout(() => resolve({ left: 0, top: y }), 280))
  }
  if (to.hash) return { el: to.hash, behavior: 'smooth' }
  return { top: 0 }
}

export const router = createRouter({
  history: createWebHashHistory(),
  scrollBehavior,
  routes: [
    { path: '/', name: 'chat', component: () => import('@/views/ChatView.vue') },
    { path: '/sessions', name: 'sessions', component: () => import('@/views/SessionsView.vue') },
    { path: '/tasks', name: 'tasks', component: () => import('@/views/TasksView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/prompts', name: 'prompts', component: () => import('@/views/PromptsView.vue') },
    { path: '/appearance', name: 'appearance', component: () => import('@/views/AppearanceView.vue') },
    { path: '/quick-commands', name: 'quick-commands', component: () => import('@/views/QuickCommandsView.vue') },
    { path: '/persona', name: 'persona', component: () => import('@/views/PersonaView.vue') },
    { path: '/providers', name: 'providers', component: () => import('@/views/ProvidersView.vue') },
    { path: '/providers/new', name: 'provider-new', component: () => import('@/views/ProviderDetailView.vue') },
    { path: '/providers/:id', name: 'provider-detail', component: () => import('@/views/ProviderDetailView.vue') },
    { path: '/deepseek-login', name: 'deepseek-login', component: () => import('@/views/DeepSeekLoginView.vue') },
    { path: '/studio', name: 'studio', component: () => import('@/views/StudioListView.vue') },
    { path: '/studio/new', name: 'studio-new', component: () => import('@/views/StudioEditorView.vue') },
    { path: '/studio/:id/edit', name: 'studio-edit', component: () => import('@/views/StudioEditorView.vue') },
    { path: '/studio/:id/chat', name: 'studio-chat', component: () => import('@/views/StudioChatView.vue') },
    { path: '/runtime', name: 'runtime', component: () => import('@/views/RuntimeView.vue') },
    { path: '/custom-iteration', name: 'custom-iteration', component: () => import('@/views/CustomIterationView.vue') },
    { path: '/life', name: 'life', component: () => import('@/views/LifeView.vue') },
    { path: '/life/memory', name: 'life-memory', component: () => import('@/views/LifeMemoryView.vue') },
    { path: '/life/journal', name: 'life-journal', component: () => import('@/views/LifeJournalView.vue') },
    { path: '/life/growth', name: 'life-growth', component: () => import('@/views/GrowthView.vue') },
    { path: '/life/timemachine', name: 'life-timemachine', component: () => import('@/views/TimeMachineView.vue') },
    { path: '/catalog', name: 'catalog', component: () => import('@/views/CatalogView.vue') },
    { path: '/workflows', name: 'workflows', component: () => import('@/views/WorkflowView.vue') },
    { path: '/hooks', name: 'hooks', component: () => import('@/views/HooksView.vue') },
    { path: '/memory', name: 'memory', component: () => import('@/views/MemoryView.vue') },
    { path: '/files', name: 'files', component: () => import('@/views/FileManagerView.vue') },
    { path: '/git', name: 'git', component: () => import('@/views/GitPanelView.vue') },
    { path: '/restore', name: 'restore', component: () => import('@/views/RestoreView.vue') },
    { path: '/ops', name: 'ops', component: () => import('@/views/OpsView.vue') },
    { path: '/data', name: 'data', component: () => import('@/views/DataView.vue') },
    { path: '/maintenance', name: 'maintenance', component: () => import('@/views/MaintenanceView.vue') },
    { path: '/usage', name: 'usage', component: () => import('@/views/UsageView.vue') },
    { path: '/updates', name: 'updates', component: () => import('@/views/UpdatesView.vue') },
    { path: '/ux-program', name: 'ux-program', component: () => import('@/views/UxProgramView.vue') },
  ],
})

// ── 导航方向跟踪：区分前进 / 返回，供转场动画使用 ──────────────
router.afterEach((to) => {
  const prev = navHist[navHist.length - 1]
  if (to.fullPath === prev) {
    // popstate（系统返回 / 浏览器返回）—— 同一路由又出现了 = 返回
    navDirection = 'back'
    navHist.pop()
  } else if (to.fullPath === navHist[navHist.length - 2]) {
    // push 后返回历史中较早的页面 —— 也视为返回
    navDirection = 'back'
    navHist.pop()
  } else {
    // 新路由压栈 —— 前进
    navDirection = 'forward'
    navHist.push(to.fullPath)
  }
})
