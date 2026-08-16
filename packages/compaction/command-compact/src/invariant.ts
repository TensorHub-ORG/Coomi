/**
 * Package-owned invariant companion for `@coomi/coomi-command-compact`.
 * @module @coomi/coomi-command-compact/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-command-compact'

/** Cordis companion plugin name. */
export const name = 'command-compact-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this command adapter owns no state or event stream; the compaction seam owns
 * the balanced durable transaction and the command registry owns registration and dispatch lifecycle.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
