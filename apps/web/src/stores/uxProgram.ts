import { defineStore } from 'pinia'
import { ref } from 'vue'
import { authedFetch } from '@/bridge/http'

export type UxConsent = 'undecided' | 'joined' | 'local_only'

export interface UxSubcategory { name: string; level: string; count?: number; example?: string }
export interface UxScene { category: string; weight?: number; subcategories?: UxSubcategory[] }
export interface UxTaskPreference { dimension: string; preference: string; evidence?: number }
export interface UxEnvironmentIssue { category: string; issue: string; frequency?: number; workaround?: string }
export interface UxProfile {
  generated_at?: string
  sample_quality?: string
  scene_preferences?: UxScene[]
  task_preferences?: UxTaskPreference[]
  environment_issues?: UxEnvironmentIssue[]
  sensitive_summary?: Array<{ category: string; count: number }>
  period?: { from?: string; to?: string; sessions_scanned?: number; user_messages_scanned?: number }
}

/**
 * 用户体验改进计划：脱敏凝练用户偏好档案。
 * 本地优先（凝练≠上传）；consent=joined 时档案才会上传。
 */
export const useUxProgramStore = defineStore('uxProgram', () => {
  const loaded = ref(false)
  const busy = ref(false)
  const consent = ref<UxConsent>('undecided')
  const autoUpdate = ref(true)
  /** 会话页邀请浮条「不要再出现」——引擎侧持久化（localStorage 按随机端口隔离，重启即丢） */
  const neverAsk = ref(false)
  const lastGeneratedAt = ref('')
  const lastError = ref('')
  const hasProfile = ref(false)
  const profile = ref<UxProfile | null>(null)
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  async function refresh() {
    try {
      const res = await authedFetch('/api/ux-program')
      if (!res.ok) return
      const data = await res.json()
      applySummary(data)
    } finally {
      loaded.value = true
    }
  }

  function applySummary(data: Record<string, unknown>) {
    busy.value = Boolean(data.busy)
    consent.value = (data.consent as UxConsent) ?? 'undecided'
    autoUpdate.value = data.auto_update !== false
    neverAsk.value = Boolean(data.never_ask)
    lastGeneratedAt.value = (data.last_generated_at as string) ?? ''
    lastError.value = (data.last_error as string) ?? ''
    hasProfile.value = Boolean(data.has_profile)
    profile.value = (data.profile as UxProfile) ?? null
    if (busy.value) ensurePolling()
  }

  /** 凝练是后台任务：busy 期间每 3 秒轮询直到完成。 */
  function ensurePolling() {
    if (pollTimer) return
    pollTimer = setTimeout(async () => {
      pollTimer = null
      await refresh()
    }, 3000)
  }

  async function generate(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await authedFetch('/api/ux-program/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (res.status === 409) {
        busy.value = true
        ensurePolling()
        return { ok: true }
      }
      if (!res.ok) {
        let message = `HTTP ${res.status}`
        try { message = (await res.json())?.message ?? message } catch { /* keep status */ }
        return { ok: false, error: message }
      }
      busy.value = true
      ensurePolling()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function setConsent(value: UxConsent, exitReason?: string) {
    const body: Record<string, unknown> = { consent: value }
    if (exitReason) body.exit_reason = exitReason
    const res = await authedFetch('/api/ux-program', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) await refresh()
  }

  async function setNeverAsk(value: boolean) {
    const res = await authedFetch('/api/ux-program', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ never_ask: value }),
    })
    if (res.ok) neverAsk.value = value
  }

  async function setAutoUpdate(value: boolean) {
    const res = await authedFetch('/api/ux-program', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_update: value }),
    })
    if (res.ok) autoUpdate.value = value
  }

  return { loaded, busy, consent, autoUpdate, neverAsk, lastGeneratedAt, lastError, hasProfile, profile, refresh, generate, setConsent, setNeverAsk, setAutoUpdate }
})
