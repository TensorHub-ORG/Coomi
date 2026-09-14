export const DISPLAY_SCALE_MIN = 0.75
export const DISPLAY_SCALE_MAX = 1.1

export function normalizeDisplayScale(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 1
  return Math.round(Math.max(DISPLAY_SCALE_MIN, Math.min(DISPLAY_SCALE_MAX, parsed)) * 100) / 100
}
