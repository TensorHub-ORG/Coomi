/**
 * coomi-jobs' owned branded id, carried across the registry, the model-facing
 * control surface, and the client wire.
 *
 * It lives in its own leaf because the package root and `./types` both reach
 * `coomi-agent` through the owner and listener signatures, which a Client program
 * cannot resolve even as a type. A browser-safe consumer imports the id here;
 * `Branded<B>` itself comes from the zero-dependency `@coomi/coomi-brand`.
 *
 * @module @coomi/coomi-jobs/brand
 */

import type { Branded } from '@coomi/coomi-brand'

/**
 * Identifies a background job. The registry generates `<kind>-N`; predictable
 * ids rely on owner authorization rather than secrecy.
 */
export type JobId = Branded<'JobId'>

/**
 * Brand a string as a {@link JobId}.
 * @param id - the raw job-id string (the registry generates `<kind>-N`).
 * @returns the same string, branded; no validation is performed.
 */
export function JobId(id: string): JobId {
  return id as JobId
}
