/**
 * Package-owned invariant companion for the default Agent model selection.
 *
 * The service owns no independent event relationship: settings registration
 * already validates every mutable value before `currentSelection()` can observe it.
 * The empty installer keeps that absence explicit in composed invariant sets.
 *
 * @module @coomi/coomi-agent-default-model/invariant
 */

import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-agent-default-model'

/** Cordis companion plugin name. */
export const name = 'agent-default-model-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: settings validation owns the only mutable-value relationship. */
const install: InvariantInstaller = () => {}

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
