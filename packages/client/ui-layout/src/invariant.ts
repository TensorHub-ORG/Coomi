/**
 * Package-owned invariant companion for `@coomi/coomi-client-ui-layout`.
 * @module @coomi/coomi-client-ui-layout/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-client-ui-layout'

/** Cordis companion plugin name. */
export const name = 'client-ui-layout-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the shell viewing-state store behind ctx.layout emits
 * no cordis events; clamp/prune/concession-chain
 * sequencing is asserted directly by this package's columns and service specs.
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
