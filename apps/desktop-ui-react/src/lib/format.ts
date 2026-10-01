export function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

export function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + units[i]
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return Math.round(ms) + 'ms'
  return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + 's'
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hhmm = d.toTimeString().slice(0, 5)
  if (sameDay) return hhmm
  return d.getMonth() + 1 + '/' + d.getDate() + ' ' + hhmm
}

/** 去掉 Windows canonicalize 带来的扩展前缀，只用于展示。 */
export function prettyPath(p: string | undefined | null): string {
  if (!p) return ''
  return p.replace(/^\\\\\?\\/, '')
}

/** 路径比较用归一化：忽略扩展前缀、分隔符与大小写。 */
export function normPath(p: string | undefined | null): string {
  if (!p) return ''
  return p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function samePath(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = normPath(a)
  return !!x && x === normPath(b)
}

/** 路径末两段，用于标题栏/列表的紧凑展示。 */
export function pathTail(p: string, segments = 2): string {
  const parts = prettyPath(p).split(/[\\/]/).filter(Boolean)
  return parts.slice(-segments).join('/')
}

export function shortPath(p: string, max = 46): string {
  const s = prettyPath(p)
  return s.length > max ? '…' + s.slice(-(max - 1)) : s
}
