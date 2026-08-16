/**
 * Package-owned invariant companion for `@coomi/coomi-cordis-client-runner`.
 * @module @coomi/coomi-cordis-client-runner/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-cordis-client-runner'

/** Cordis companion plugin name. */
export const name = 'cordis-client-runner-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the owned relation (a live
 * Plugin's loader entry exists exactly while one Plugin Run ID is live) is
 * browser-only state reachable through the client half's service, which the
 * node-plane companion cannot observe. The relation is asserted by the
 * package's own load/teardown coverage instead.
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
