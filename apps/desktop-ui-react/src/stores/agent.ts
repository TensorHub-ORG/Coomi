/** 执行偏好：思考强度与任务放行程度。引擎侧持久化在 settings.json / web-settings.json，
 *  同时用 WS 命令让当前连接立即生效。 */
import { create } from 'zustand'
import { useEngine } from './engine'
import { useSession } from './session'

export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'ultra'
export type PermissionMode = 'ask' | 'auto' | 'full'

export const EFFORT_LABELS: Array<{ value: ReasoningEffort; label: string; hint: string }> = [
  { value: 'auto', label: '自动', hint: '交给模型自己判断' },
  { value: 'low', label: '低', hint: '快，适合简单任务' },
  { value: 'medium', label: '中', hint: '默认平衡' },
  { value: 'high', label: '高', hint: '复杂任务更稳' },
  { value: 'xhigh', label: '极高', hint: '慢，但推理更深' },
  { value: 'ultra', label: '极限', hint: '最慢，最难的问题' },
]

export const PERMISSION_LABELS: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'ask', label: '每次询问', hint: '危险操作一律先问我' },
  { value: 'auto', label: '自动放行', hint: '只读与写入自动通过，删除类仍询问' },
  { value: 'full', label: '完全放行', hint: '不再打断，包含删除类操作' },
]

interface AgentState {
  effort: ReasoningEffort
  permission: PermissionMode
  maxToolRounds: number
  loaded: boolean
  /** 厂商配置（providers）的版本号：设置页保存 / 删除 / 激活 / 切换模型后 +1。
      订阅它的页面（对话页的模型选择器）据此重新拉 /api/providers ——
      以前只有设置页刷新自己那份，回到对话页还是旧列表，
      于是刚加完厂商却被提示「还没有配置模型」（2026-09-29）。 */
  providerRevision: number
  bumpProviders: () => void
  load: () => Promise<void>
  setEffort: (v: ReasoningEffort) => Promise<void>
  setPermission: (v: PermissionMode) => Promise<void>
  setMaxToolRounds: (n: number) => Promise<void>
}

export const useAgent = create<AgentState>((set, get) => ({
  effort: 'auto',
  permission: 'ask',
  maxToolRounds: 192,
  loaded: false,
  providerRevision: 0,

  load: async () => {
    try {
      const d = await useEngine.getState().api<{ reasoningEffort?: string; permissionMode?: string; maxToolRounds?: number }>('/api/agent/preferences')
      set({
        effort: (d.reasoningEffort as ReasoningEffort) ?? 'auto',
        permission: (d.permissionMode as PermissionMode) ?? 'ask',
        maxToolRounds: d.maxToolRounds ?? 192,
        loaded: true,
      })
    } catch { /* 引擎未就绪时保持默认 */ }
  },

  setEffort: async (v) => {
    set({ effort: v })
    // WS 命令即时作用于当前连接；HTTP 负责持久化，二者都要。
    useSession.getState().sendCommand({ command: 'set_reasoning_effort', effort: v })
    try { await useEngine.getState().api('/api/agent/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reasoningEffort: v }) }) } catch { /* 忽略 */ }
    void get().load()
  },

  setPermission: async (v) => {
    set({ permission: v })
    useSession.getState().sendCommand({ command: 'set_permission_mode', mode: v })
    try { await useEngine.getState().api('/api/agent/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionMode: v }) }) } catch { /* 忽略 */ }
    void get().load()
  },

  /** 厂商配置变了：让所有订阅方重新拉一次（幂等，调用方不用管有没有页面在听）。 */
  bumpProviders: () => set((state) => ({ providerRevision: state.providerRevision + 1 })),

  setMaxToolRounds: async (n) => {
    set({ maxToolRounds: n })
    try { await useEngine.getState().api('/api/agent/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxToolRounds: n }) }) } catch { /* 忽略 */ }
  },
}))
