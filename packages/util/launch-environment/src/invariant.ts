/**
 * Package-owned invariant companion for `@coomi/coomi-launch-environment`.
 * @module @coomi/coomi-launch-environment/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-launch-environment'

/** Cordis companion plugin name. */
export const name = 'launch-environment-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the snapshot is frozen before any fiber starts and this package owns no
 * event stream or mutable runtime data; its lookup and rejection rules are enforced by unit tests.
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
