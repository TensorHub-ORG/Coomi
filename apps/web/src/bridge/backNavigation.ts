export type BackTarget = 'dashboard' | 'exit' | string

const parents: Array<[RegExp, string]> = [
  [/^\/providers\/[^/]+$/, '/providers'],
  [/^\/studio\/.+$/, '/studio'],
  [/^\/collab\/.+$/, '/collab'],
  [/^\/im\/.+$/, '/im'],
  [/^\/life\/.+$/, '/life'],
  [/^\/(appearance|persona)$/, '/settings'],
]

export function resolveBackTarget(fullPath: string, source?: BackTarget, fallback: BackTarget = 'dashboard'): BackTarget {
  const [path, query] = fullPath.split('?')
  if (path === '/quick-commands' && new URLSearchParams(query).get('native') === '1') return 'exit'
  for (const [pattern, parent] of parents) {
    if (pattern.test(path)) return parent
  }
  if (source && source !== fullPath) return source
  if (path === '/settings' || path === '/studio' || path === '/collab' || path === '/im') return '/'
  return fallback
}

export class BackNavigation {
  private sources = new Map<string, BackTarget>()
  private returningTo: string | null = null

  enter(fullPath: string, from?: string): void {
    if (this.returningTo === fullPath) {
      this.returningTo = null
      return
    }
    this.returningTo = null
    if (from && from !== fullPath) this.sources.set(fullPath, from)
  }

  target(fullPath: string, fallback?: BackTarget): BackTarget {
    return resolveBackTarget(fullPath, this.sources.get(fullPath), fallback)
  }

  prepareReturn(fullPath: string): void {
    this.returningTo = fullPath
  }

  openNative(fullPath: string): void {
    this.sources.clear()
    this.sources.set(fullPath, 'dashboard')
    this.returningTo = fullPath
  }
}
