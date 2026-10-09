/** One native OS drop subscription, delivered only to the visible active composer. */
type Payload = { paths?: string[] }
type Listener = (event: { payload?: Payload }) => void
interface Target { active: () => boolean; hover: (value: boolean) => void; drop: (paths: string[]) => void }
const targets = new Set<Target>()
let offs: Array<() => void> = []
let generation = 0
let attached = false
function dispatch(kind: 'hover' | 'drop' | 'leave', payload?: Payload): void {
  const active = [...targets].reverse().find(target => target.active())
  for (const target of targets) target.hover(target === active && kind === 'hover')
  if (kind === 'drop' && active) active.drop([...new Set(payload?.paths ?? [])])
}
export function subscribeNativeFileDrop(target: Target): () => void {
  targets.add(target)
  if (!attached) {
    const api = (window as unknown as { __TAURI__?: { event?: { listen?: (name: string, cb: Listener) => Promise<() => void> } } }).__TAURI__?.event?.listen
    if (api) {
      attached = true
      const epoch = ++generation
      for (const [name, kind] of [['tauri://drag-enter','hover'], ['tauri://drag-over','hover'], ['tauri://drag-leave','leave'], ['tauri://drag-drop','drop']] as const) {
        void api(name, event => { if (epoch === generation) dispatch(kind, event.payload) }).then(off => {
          if (epoch !== generation) off(); else offs.push(off)
        }).catch(error => { console.warn('[file-drop] native subscription failed', error) })
      }
    }
  }
  return () => {
    targets.delete(target)
    if (targets.size) return
    generation += 1
    attached = false
    for (const off of offs.splice(0)) off()
  }
}
