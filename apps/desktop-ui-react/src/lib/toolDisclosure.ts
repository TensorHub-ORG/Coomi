import type { ToolCall } from './chat'

/** Visual disclosure only. Approval requests remain in the independent approval dialog. */
export function toolDisclosure(tools: ToolCall[], streaming: boolean, minimal: boolean, manual: boolean | null) {
  const active = tools.some((tool) => tool.status === 'running' || tool.status === 'queued')
  const failed = tools.filter((tool) => tool.status === 'error' || tool.status === 'denied').length
  const forced = !minimal && (streaming || active)
  return {
    active,
    failed,
    canFold: minimal || (!forced && tools.length > 3),
    showHeader: minimal || tools.length > 3,
    open: forced || (!minimal && tools.length <= 3) || (manual ?? failed > 0),
  }
}
