import { create } from 'zustand'
import { normPath, pathTail } from '../lib/format'
import type { SessionSummary } from './session'

export interface SessionMeta { pinned?: boolean; title?: string; hidden?: boolean; projectName?: string }
interface WorkspaceState {
  meta: Record<string, SessionMeta>
  collapsed: Record<string, boolean>
  patch: (id: string, p: Partial<SessionMeta>) => void
  renameProject: (path: string, name: string) => void
  toggleCollapse: (key: string) => void
}

const META_KEY = 'coomi.sessionMeta.v2'
const COLLAPSE_KEY = 'coomi.collapse.v2'

function readJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T } catch { return fallback }
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  meta: readJson<Record<string, SessionMeta>>(META_KEY, {}),
  collapsed: readJson<Record<string, boolean>>(COLLAPSE_KEY, {}),
  patch: (id, p) => {
    const meta = { ...get().meta, [id]: { ...(get().meta[id] ?? {}), ...p } }
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)) } catch { /* 忽略 */ }
    set({ meta })
  },
  renameProject: (path, name) => {
    const key = 'proj:' + normPath(path)
    const meta = { ...get().meta, [key]: { ...(get().meta[key] ?? {}), projectName: name } }
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)) } catch { /* 忽略 */ }
    set({ meta })
  },
  toggleCollapse: (key) => {
    const collapsed = { ...get().collapsed, [key]: !get().collapsed[key] }
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)) } catch { /* 忽略 */ }
    set({ collapsed })
  },
}))

export function sessionTitle(s: SessionSummary, meta: Record<string, SessionMeta>): string {
  return meta[s.id]?.title || s.title || s.preview || '未命名会话'
}

function sortSessions(list: SessionSummary[], meta: Record<string, SessionMeta>): SessionSummary[] {
  return [...list].sort((a, b) => {
    const pa = meta[a.id]?.pinned ? 1 : 0
    const pb = meta[b.id]?.pinned ? 1 : 0
    if (pa !== pb) return pb - pa
    const ta = a.updatedAt ?? a.createdAt ?? 0
    const tb = b.updatedAt ?? b.createdAt ?? 0
    return tb - ta
  })
}

export interface SessionGroup { key: string; label: string; path: string; sessions: SessionSummary[]; kind: 'default' | 'project' }

/** 会话按实际工作路径归档；同一路径的大小写/分隔符变体合并。只有无路径记录进入「会话」。 */
export function groupSessions(
  sessions: SessionSummary[],
  defaultCwd: string,
  meta: Record<string, SessionMeta>,
): SessionGroup[] {
  const visible = sessions.filter((s) => !meta[s.id]?.hidden)
  const inDefault: SessionSummary[] = []
  const byPath = new Map<string, SessionSummary[]>()
  for (const s of visible) {
    const cwd = (s.cwd ?? '').trim()
    if (!cwd) { inDefault.push(s); continue }
    const key = normPath(cwd)
    const list = byPath.get(key) ?? []
    list.push(s)
    byPath.set(key, list)
  }
  const out: SessionGroup[] = []
  if (inDefault.length) {
    out.push({ key: 'default', label: '会话', path: defaultCwd, sessions: sortSessions(inDefault, meta), kind: 'default' })
  }
  const projects = [...byPath.entries()]
    .map(([key, list]) => ({
      key: 'proj:' + key,
      label: meta['proj:' + key]?.projectName || meta['proj:' + list[0].cwd]?.projectName || pathTail(list[0].cwd || key, 1),
      path: list[0].cwd || key,
      sessions: sortSessions(list, meta),
      kind: 'project' as const,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return [...out, ...projects]
}
