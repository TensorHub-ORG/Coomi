/** 插件页面注册表（v2.1）。
 *
 *  数据源：引擎 `GET /api/plugins/views`，内容由桌面壳在**启用插件时**写进
 *  `<home>/plugin-views.json`（停用/卸载即撤销）—— 与子智能体模板、persona 同一套路径。
 *  这里只做两件事：拉一次、把绝对路径转成能装进 iframe 的 asset URL。
 *
 *  安全边界（与壳侧校验配套）：
 *   · entry 必须是插件目录内的 .html（壳已拒绝绝对路径 / `..`）；
 *   · 页面跑在**独立 origin 的 iframe** 里（asset:// 与主页面不同源），不给 Tauri IPC、
 *     不注入 boot 脚本；需要引擎数据时走 postMessage 让宿主代发，且只放行只读 GET。
 */
import { create } from 'zustand'
import { useEngine } from './engine'

export interface PluginViewItem {
  /** 侧边栏与路由用的 key：`plugin:<pluginId>:<viewId>`（与四个核心页不会撞）。 */
  key: string
  pluginId: string
  id: string
  title: string
  icon: string
  order: number
  /** 页面文件的绝对路径（插件目录内）。 */
  entry: string
}

interface PluginViewsState {
  views: PluginViewItem[]
  loaded: boolean
  /** 拉一次注册表（引擎不可达 / 老引擎没有这个接口时保持空表，不报错）。 */
  load: () => Promise<void>
}

/** 把绝对路径转成 WebView 能加载的 asset URL：
    壳开了 protocol-asset，且 tauri.conf.json 的 assetProtocol.scope 已包含
    `$APPDATA/Coomi/plugins/**` —— 插件页面就落在这个范围里。 */
export function assetUrlFor(path: string): string {
  const convert = (window as unknown as {
    __TAURI__?: { core?: { convertFileSrc?: (p: string) => string } }
  }).__TAURI__?.core?.convertFileSrc
  if (typeof convert === 'function') {
    try { return convert(path) } catch { /* 落到下面的手写兜底 */ }
  }
  return 'asset://localhost/' + encodeURIComponent(path.replace(/\\/g, '/'))
}

/** 把引擎返回的原始条目整理成前端用的形态（坏条目直接跳过）。 */
function normalize(raw: unknown): PluginViewItem[] {
  if (!Array.isArray(raw)) return []
  const out: PluginViewItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = String(row.id ?? '').trim()
    const pluginId = String(row.pluginId ?? '').trim()
    const entry = String(row.entry ?? '').trim()
    const title = String(row.title ?? '').trim()
    if (!id || !pluginId || !entry || !title) continue
    out.push({
      key: 'plugin:' + pluginId + ':' + id,
      pluginId,
      id,
      title,
      icon: String(row.icon ?? '').trim(),
      order: Number.isFinite(Number(row.order)) ? Number(row.order) : 50,
      entry,
    })
  }
  return out.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

export const usePluginViews = create<PluginViewsState>((set) => ({
  views: [],
  loaded: false,
  load: async () => {
    try {
      const data = await useEngine.getState().api<{ views?: unknown }>('/api/plugins/views')
      set({ views: normalize(data?.views), loaded: true })
    } catch {
      // 引擎还没就绪 / 老引擎没有这个接口：保持空表。下一次引擎就绪会再拉一次。
      set({ loaded: true })
    }
  },
}))
