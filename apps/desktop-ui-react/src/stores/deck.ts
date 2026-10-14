import { create } from 'zustand'
import { useEngine } from './engine'
import { useUi } from './ui'
import { useSession } from './session'

export interface DeckTerminal { id: string; number: number; profile: string; status: string; coomi_ready: boolean; full_access?: boolean }
export interface DeckTask { id: string; title: string; cwd: string; session_id: string; status: string; created_at: number; terminals: DeckTerminal[]; dispatches: Array<{ id: string; terminal_id: string; at: number; text: string; status: string }> }
interface DeckState {
  mode: 'work' | 'deck'; selected: string; tasks: DeckTask[]; error: string
  toggle: () => void; select: (id: string) => void; refresh: () => Promise<void>
  activate: (reconnect?: boolean) => Promise<void>
  create: (title: string, cwd: string) => Promise<void>
  action: <T>(task: string, body: Record<string, unknown>) => Promise<T>
}
function stored(key: string): string { try { return localStorage.getItem(key) || '' } catch { return '' } }
function remember(key: string, value: string): void { try { localStorage.setItem(key, value) } catch { /* private mode */ } }
let refreshRevision = 0
export const useDeck = create<DeckState>((set, get) => ({
  mode: stored('coomi.mode') === 'deck' ? 'deck' : 'work', selected: stored('coomi.deck.selected'), tasks: [], error: '',
  toggle: () => {
    const mode = get().mode === 'work' ? 'deck' : 'work'
    remember('coomi.mode', mode)
    set({ mode })
    useUi.getState().setView('chat')
  },
  activate: async (reconnect = false) => {
    if (get().mode !== 'deck' || !useEngine.getState().ready) return
    const task = get().tasks.find((one) => one.id === get().selected)
    if (!task) { useSession.getState().disconnect(); return }
    const session = useSession.getState()
    if (!reconnect && session.sessionSurface === 'deck' && session.sessionId === task.session_id) return
    await session.openSession(task.session_id, { surface: 'deck', cwd: task.cwd })
  },
  select: (id) => {
    remember('coomi.deck.selected', id); set({ selected: id })
    void get().activate().catch((error) => set({ error: String(error) }))
  },
  refresh: async () => {
    const revision = ++refreshRevision
    try {
      const result = await useEngine.getState().api<{ tasks: DeckTask[] }>('/api/deck/tasks')
      if (revision !== refreshRevision) return
      const selected = result.tasks.some((task) => task.id === get().selected) ? get().selected : result.tasks[0]?.id || ''
      if (JSON.stringify(result.tasks) !== JSON.stringify(get().tasks) || selected !== get().selected || get().error) set({ tasks: result.tasks, selected, error: '' })
      if (selected) remember('coomi.deck.selected', selected)
      await get().activate()
    } catch (error) { if (revision === refreshRevision) set({ error: error instanceof Error ? error.message : String(error) }) }
  },
  create: async (title, cwd) => {
    const task = await useEngine.getState().api<DeckTask>('/api/deck/tasks', { method: 'POST', body: JSON.stringify({ title, cwd }), headers: { 'Content-Type': 'application/json' } })
    refreshRevision += 1
    set({ tasks: [task, ...get().tasks.filter((item) => item.id !== task.id)] })
    get().select(task.id)
    await get().refresh()
  },
  action: async <T,>(task: string, body: Record<string, unknown>): Promise<T> => {
    const result = await useEngine.getState().api<T>('/api/deck/tasks/' + encodeURIComponent(task) + '/action', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
    if (body.action === 'control') {
      // Discard task snapshots requested before this change; otherwise a late
      // polling response can paint the old owner over the successful handover.
      refreshRevision += 1
      const ready = (result as { coomi_ready: boolean }).coomi_ready
      set({ tasks: get().tasks.map(item => item.id === task ? { ...item, terminals: item.terminals.map(terminal => terminal.id === body.terminal_id ? { ...terminal, coomi_ready: ready } : terminal) } : item) })
    }
    return result
  },
}))
