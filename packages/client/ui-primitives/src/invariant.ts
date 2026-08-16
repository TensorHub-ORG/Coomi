/**
 * Package-owned invariant companion for `@coomi/coomi-client-ui-primitives`.
 * @module @coomi/coomi-client-ui-primitives/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-client-ui-primitives'

/** Cordis companion plugin name. */
export const name = 'client-ui-primitives-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: pure props-in React atoms with no Cordis API —
 * no events, no services, no mutable cross-plugin state; rendering contracts
 * are asserted directly by this package's component specs.
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
