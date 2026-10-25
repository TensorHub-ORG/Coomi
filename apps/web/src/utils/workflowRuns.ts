export interface WorkflowQuestion { id: string; question: string; options: Array<{ label: string; description?: string }> }
export interface WorkflowRun {
  id: string; started_at: number; finished_at?: number | null; status: string
  trigger: string; duration_ms?: number | null; error?: string | null; resumable?: boolean
  usage?: { input_tokens: number; output_tokens: number }
  steps: Array<{ id: string; name: string; state: string; error?: string | null; attempts?: number; duration_ms?: number | null; result?: unknown }>
  pending?: { id: string; kind: string; prompt: string; tool?: { name: string; arguments: unknown } | null; questions?: { questions: WorkflowQuestion[] } | null } | null
}
export function activeWorkflowStatus(status: string): boolean {
  return ['queued', 'running', 'pause_pending', 'paused', 'awaiting_approval', 'awaiting_input'].includes(status)
}
export function workflowStatusLabel(status: string): string {
  return ({
    pending: '待执行', queued: '排队中', running: '运行中', pause_pending: '等待安全暂停',
    paused: '已暂停', awaiting_approval: '待审批', awaiting_input: '待补充信息',
    completed: '已完成', succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '已中断',
  } as Record<string, string>)[status] ?? status
}

/** Poll until a run is terminal. Generation checks prevent stale responses after navigation. */
export function createWorkflowRunPoller(options: {
  load: (id: string) => Promise<WorkflowRun[]>
  receive: (runs: WorkflowRun[]) => void
  error: (error: unknown) => void
  schedule?: (callback: () => void) => unknown
  clear?: (timer: unknown) => void
}) {
  let generation = 0
  let timer: unknown
  const schedule = options.schedule ?? (callback => setTimeout(callback, 2000))
  const clear = options.clear ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  function stop() { generation++; if (timer != null) clear(timer); timer = undefined }
  async function refresh(id: string, ticket: number) {
    let again = true
    try {
      const runs = await options.load(id)
      if (ticket !== generation) return
      options.receive(runs)
      again = runs.some(run => activeWorkflowStatus(run.status))
    } catch (error) {
      if (ticket !== generation) return
      options.error(error)
    }
    if (ticket === generation && again) timer = schedule(() => { void refresh(id, ticket) })
  }
  function start(id: string) { stop(); void refresh(id, generation) }
  return { start, stop }
}
