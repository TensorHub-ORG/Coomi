export const CATEGORY_META = [
  { key: 'system_tools', label: '系统工具', color: '#5793e8' },
  { key: 'messages', label: '消息', color: '#62b89e' },
  { key: 'skills', label: '技能', color: '#b799e5' },
  { key: 'mcp_tools', label: 'MCP 工具', color: '#dcad60' },
  { key: 'system_prompt', label: '系统提示', color: '#d58198' },
  { key: 'other', label: '其他', color: '#929aa9' },
] as const
export function nonnegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}
export function contextSegments(used: number, window: number, categories: Partial<Record<string, number>> = {}) {
  const capacity = nonnegative(window)
  const occupied = Math.min(capacity, nonnegative(used))
  const weights = CATEGORY_META.map(meta => nonnegative(categories[meta.key]))
  const total = weights.reduce((sum, n) => sum + n, 0)
  return CATEGORY_META.map((meta, i) => ({ ...meta,
    share: total > 0 ? weights[i] / total : meta.key === 'other' ? 1 : 0,
    ratio: capacity > 0 ? occupied / capacity * (total > 0 ? weights[i] / total : meta.key === 'other' ? 1 : 0) : 0,
  }))
}
export function formatDurationMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '--'
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
}
