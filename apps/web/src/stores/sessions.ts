import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { isDemoMode } from '@/bridge/demoMode'
import { authedFetch } from '@/bridge/http'
import type { Timelineitem } from './viewModel'

/**
 * 会话历史（纯本机）。
 *
 * bridge 没有「列出会话」接口，引擎侧 SessionManager 也只把会话放在内存里
 * （coomi/engine/session.py:110），所以历史列表只能由前端自己维护：
 *   - 元数据存 localStorage，抽屉据此分组渲染；
 *   - 时间线也存一份，重开旧会话时先把本机记录铺回来；
 *   - 重连用同一个 sessionId，引擎进程没重启的话上下文是真的接上了，
 *     重启过就只剩本机这份记录 —— 这一点由 ChatView 明确提示用户。
 */

const META_KEY = 'coomi.sessions.v1'
const TRANSCRIPT_PREFIX = 'coomi.transcript.'
/** 只给最近的若干会话留时间线，避免把 localStorage 撑爆。 */
const KEEP_TRANSCRIPTS = 12
const MAX_ITEMS_PER_TRANSCRIPT = 400

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  turns: number
  pinned: boolean
  /** 创建该会话时的工作目录；用于把不同项目的会话隔离开。 */
  cwd?: string
  /** 引擎侧一句话摘要（/api/sessions 的 summary），用于检索与展示。 */
  summary?: string
  /** 引擎侧首条消息预览。 */
  preview?: string
  /** 引擎侧模型名。 */
  model?: string
  /** 用户手动重命名过：true 时引擎推导的标题不再覆盖。 */
  renamed?: boolean
}

export interface SessionGroup {
  label: string
  items: SessionMeta[]
}

function readMetas(): SessionMeta[] {
  try {
    const raw = localStorage.getItem(META_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? (parsed as SessionMeta[]).filter(meta => meta.turns > 0 || meta.title !== '新对话')
      : []
  } catch {
    return []
  }
}

function dayStart(offsetDays = 0): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime() - offsetDays * 86400000
}

export function formatSessionTime(ts: number): string {
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (ts >= dayStart()) return hm
  if (ts >= dayStart(1)) return `昨天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export const useSessionsStore = defineStore('sessions', () => {
  const metas = ref<SessionMeta[]>(readMetas())
  const query = ref('')
  /** 引擎当前工作目录（来自 /api/runtime/health），用于会话按项目隔离。 */
  const currentCwd = ref('')
  /** 引擎侧正在后台执行的会话 id 集合（/api/sessions 的 running 字段）。 */
  const runningIds = ref<Set<string>>(new Set())

  /** 从引擎刷新各会话的 running 状态 + 合并「最后执行时间」（列表排序依据）；引擎不可用时保持原状。 */
  async function refreshRunning() {
    try {
      const res = await authedFetch('/api/sessions')
      if (!res.ok) return
      const data = (await res.json()) as {
        sessions: Array<{ id: string; running: boolean; updated_at: string }>
      }
      runningIds.value = new Set(
        (data.sessions ?? []).filter(s => s.running).map(s => s.id),
      )
      // 引擎 updated_at = 最后一轮 agent 执行时间（完成/取消/中断都落盘）。
      // 只向前合并：比本地新的才覆盖，避免旧数据把新会话时间拉回去。
      let changed = false
      for (const s of data.sessions ?? []) {
        const meta = find(s.id)
        if (!meta) continue
        const engineTime = Date.parse(s.updated_at)
        if (Number.isFinite(engineTime) && engineTime > meta.updatedAt) {
          meta.updatedAt = engineTime
          changed = true
        }
      }
      if (changed) persistMeta()
    } catch {
      /* 引擎未就绪：静默保持上次状态 */
    }
  }

  function isRunning(id: string): boolean {
    return runningIds.value.has(id)
  }

  function setCurrentCwd(cwd: string) {
    currentCwd.value = cwd
  }

  const sorted = computed(() =>
    [...metas.value].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
  )

  const filtered = computed(() => {
    const q = query.value.trim().toLowerCase()
    if (!q) return sorted.value
    // 与 Rust 侧 ranked_sessions 一致：title×5 / summary×3 / preview×1 / model×1 加权打分排序。
    // 注意：必须 Unicode 感知分词（\p{L}\p{N} 含中文 + 技术符号 +.#），与 Rust 的
    // is_alphanumeric 谓词对齐；不能用 ASCII 正则 [a-z0-9]，否则中文查询词会被整体拆掉。
    const terms = q.match(/[\p{L}\p{N}_+.#-]{2,}/gu) ?? []
    if (terms.length === 0) return sorted.value
    return sorted.value
      .map(m => ({ m, score: scoreSession(m, terms) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(x => x.m)
  })

  /** 置顶 / 今天 / 昨天 / 7 天内 / 更早 / 其它目录 —— 空组不出现。 */
  const groups = computed<SessionGroup[]>(() => {
    const buckets: SessionGroup[] = [
      { label: '置顶', items: [] },
      { label: '今天', items: [] },
      { label: '昨天', items: [] },
      { label: '7 天内', items: [] },
      { label: '更早', items: [] },
      { label: '其它目录', items: [] },
    ]
    const today = dayStart()
    const yesterday = dayStart(1)
    const week = dayStart(7)
    const current = currentCwd.value
    for (const m of filtered.value) {
      if (m.pinned) buckets[0].items.push(m)
      // 会话属于其它工作目录时归入「其它目录」，避免把别的项目的会话混进当前项目。
      // cwd 为空的是旧数据，按当前项目对待。
      else if (current && m.cwd && m.cwd !== current) buckets[5].items.push(m)
      else if (m.updatedAt >= today) buckets[1].items.push(m)
      else if (m.updatedAt >= yesterday) buckets[2].items.push(m)
      else if (m.updatedAt >= week) buckets[3].items.push(m)
      else buckets[4].items.push(m)
    }
    return buckets.filter(b => b.items.length > 0)
  })

  function persist() {
    try {
      localStorage.setItem(META_KEY, JSON.stringify(metas.value))
    } catch {
      /* 配额满就放弃写入，不影响会话本身 */
    }
  }

  function find(id: string): SessionMeta | undefined {
    return metas.value.find(m => m.id === id)
  }

  /**
   * 演示模式下建/动会话只留在内存里：预览不该往真实历史里塞条目。
   * 用户主动的重命名 / 置顶 / 删除仍然照常落盘。
   */
  function persistMeta() {
    if (!isDemoMode()) persist()
  }

  /** 第一条用户消息就是标题，截断到一行能放下的长度。 */
  function deriveTitle(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim()
    return t.length > 42 ? t.slice(0, 42) + '…' : t || '新对话'
  }

  /** 会话检索打分：拆词后按 title/summary/preview/model 加权求和（与 Rust 侧一致）。
   *  命中次数加权：同一词出现多次分数更高；紧凑版仅在精确未命中时兜底（权重减半）。 */
  function scoreSession(m: SessionMeta, terms: string[]): number {
    const hay = (s?: string) => (s ?? '').toLowerCase()
    const title = hay(m.title)
    const summary = hay(m.summary)
    const preview = hay(m.preview)
    const model = hay(m.model)
    const id = hay(m.id)
    // 紧凑版（去空白）兜底：弥补「B+ 树」与「B+树」这类空白差异，权重减半。
    const compactTitle = title.replace(/\s+/g, '')
    const compactSummary = summary.replace(/\s+/g, '')
    const compactPreview = preview.replace(/\s+/g, '')
    const count = (s: string, t: string) => s.split(t).length - 1
    return terms.reduce((acc, t) => {
      let s = 0
      const th = count(title, t)
      const sh = count(summary, t)
      const ph = count(preview, t)
      if (th > 0) s += th * 5
      else s += count(compactTitle, t) * 2
      if (sh > 0) s += sh * 3
      else s += count(compactSummary, t)
      if (ph > 0) s += ph
      else s += count(compactPreview, t)
      if (model.includes(t)) s += 1
      // uuid 片段匹配要求 ≥6 字符，避免「ab」这类 2 字符词随机命中 uuid 造成误报。
      if (t.length >= 6 && id.includes(t)) s += 1
      return acc + s
    }, 0)
  }

  function ensure(id: string, title = '新对话'): SessionMeta {
    let m = find(id)
    if (!m) {
      m = { id, title, createdAt: Date.now(), updatedAt: Date.now(), turns: 0, pinned: false, cwd: currentCwd.value || undefined }
      metas.value.unshift(m)
      persistMeta()
    }
    return m
  }

  /**
   * 会话元数据更新（标题 / 轮数）。【不再刷新 updatedAt】：
   * 排序时间 = 最后一轮 agent 的执行时间，由引擎在任务完成/中断时
   * 落盘到会话 updated_at，前端轮询合并——点击/打开会话不应改变排序。
   */
  function touch(id: string, patch: Partial<Pick<SessionMeta, 'title' | 'turns'>> = {}) {
    const m = ensure(id)
    if (patch.title) m.title = patch.title
    if (patch.turns != null) m.turns = patch.turns
    persistMeta()
  }

  function rename(id: string, title: string) {
    const m = find(id)
    if (!m) return
    m.title = title.trim() || m.title
    m.renamed = true
    persist()
  }

  function togglePin(id: string) {
    const m = find(id)
    if (!m) return
    m.pinned = !m.pinned
    persist()
  }

  function remove(id: string) {
    metas.value = metas.value.filter(m => m.id !== id)
    try {
      localStorage.removeItem(TRANSCRIPT_PREFIX + id)
    } catch {
      /* ignore */
    }
    persist()
    // 同步删除引擎磁盘上的会话记录（权威源），否则下次 syncFromEngine 时“复活”。
    authedFetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  /** Migrate pre-Rust session ids while preserving the local transcript and metadata. */
  function migrateId(oldId: string, newId: string): string {
    const meta = find(oldId)
    if (!meta) return newId
    meta.id = newId
    try {
      const transcript = localStorage.getItem(TRANSCRIPT_PREFIX + oldId)
      if (transcript) localStorage.setItem(TRANSCRIPT_PREFIX + newId, transcript)
      localStorage.removeItem(TRANSCRIPT_PREFIX + oldId)
    } catch {
      /* Keep the migrated metadata even if WebView storage is temporarily unavailable. */
    }
    persist()
    return newId
  }

  /** 只留最近 KEEP_TRANSCRIPTS 份时间线，老的元数据保留、正文丢弃。 */
  function pruneTranscripts() {
    const keep = new Set(sorted.value.slice(0, KEEP_TRANSCRIPTS).map(m => m.id))
    for (const m of metas.value) {
      if (keep.has(m.id)) continue
      try {
        localStorage.removeItem(TRANSCRIPT_PREFIX + m.id)
      } catch {
        /* ignore */
      }
    }
  }

  function saveTranscript(id: string, items: Timelineitem[]) {
    if (items.length === 0) return
    const tail = items.slice(-MAX_ITEMS_PER_TRANSCRIPT)
    try {
      localStorage.setItem(TRANSCRIPT_PREFIX + id, JSON.stringify(tail))
      pruneTranscripts()
    } catch {
      // 配额满：清掉最旧的正文再试一次，仍失败就算了
      pruneTranscripts()
      try {
        localStorage.setItem(TRANSCRIPT_PREFIX + id, JSON.stringify(tail))
      } catch {
        /* ignore */
      }
    }
  }

  function loadTranscript(id: string): Timelineitem[] {
    try {
      const raw = localStorage.getItem(TRANSCRIPT_PREFIX + id)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as Timelineitem[]) : []
    } catch {
      return []
    }
  }

  function clearAll() {
    for (const m of metas.value) {
      try {
        localStorage.removeItem(TRANSCRIPT_PREFIX + m.id)
      } catch {
        /* ignore */
      }
      // 同步删除引擎磁盘记录，避免清空后从引擎列表“复活”。
      authedFetch(`/api/sessions/${m.id}`, { method: 'DELETE' }).catch(() => {})
    }
    metas.value = []
    persist()
  }

  /**
   * 从引擎磁盘拉取会话列表（权威源）并与本地元数据合并。
   * 修复“会话记录消失”：引擎重启/回放后，会话以磁盘为准重新出现；
   * 空会话（turns=0）也保留，不再被过滤。
   */
  async function syncFromEngine(): Promise<boolean> {
    try {
      const res = await authedFetch('/api/sessions')
      if (!res.ok) return false
      const data = await res.json()
      const remote = (data.sessions ?? []) as Array<{
        id: string
        provider_id: string
        model: string
        cwd: string
        updated_at: string
        preview: string
        title: string
        summary: string
        created_at: string
      }>
      const localById = new Map(metas.value.map(m => [m.id, m]))
      const merged: SessionMeta[] = remote.map(r => {
        const local = localById.get(r.id)
        const updatedAt = Date.parse(r.updated_at) || Date.now()
        const createdAt = local?.createdAt ?? (Date.parse(r.created_at) || updatedAt)
        return {
          id: r.id,
          // 用户重命名过（renamed）则保留用户标题；否则引擎 title 优先，本地推导兜底。
          title: local?.renamed ? local.title : (r.title || local?.title || (r.preview ? deriveTitle(r.preview) : '新对话')),
          createdAt,
          updatedAt,
          turns: local?.turns ?? 0,
          pinned: local?.pinned ?? false,
          cwd: r.cwd || local?.cwd,
          summary: r.summary || local?.summary,
          preview: r.preview || local?.preview,
          model: r.model || local?.model,
          renamed: local?.renamed,
        }
      })
      // 本地有而引擎暂无的（旧迁移 ID 等）保留，避免吞掉用户数据
      const remoteIds = new Set(merged.map(m => m.id))
      for (const m of metas.value) {
        if (!remoteIds.has(m.id)) merged.push(m)
      }
      metas.value = merged
      persist()
      return true
    } catch {
      return false
    }
  }

  return {
    metas, query, sorted, filtered, groups, currentCwd, setCurrentCwd,
    syncFromEngine,
    ensure, touch, rename, togglePin, remove, find, deriveTitle,
    saveTranscript, loadTranscript, migrateId, clearAll,
    refreshRunning, isRunning,
  }
})
