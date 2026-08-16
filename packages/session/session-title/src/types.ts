/**
 * Pure types of the title domain: the ONE home of the `title` projection-key
 * declaration, free of this package's host-side value imports (cordis
 * service, schemastery, the llm seam). Two namespace projections serve it —
 * `./types` for host consumers, `./client/types` (the browser half-entry's
 * re-export) for client aggregates — with zero content duplication.
 *
 * @module @coomi/coomi-session-title/types
 */

// Marks this file a module so the declaration below AUGMENTS the projection
// table instead of declaring an ambient module.
export {}

declare module '@coomi/coomi-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current normalized title — the latest `session/title`
     * event's text (last-wins), or `null` before the first title lands. A
     * plain string: the shape the client list rows consume.
     */
    title: string | null
  }
}
