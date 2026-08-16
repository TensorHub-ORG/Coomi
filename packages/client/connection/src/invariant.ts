/**
 * Package-owned invariant companion for `@coomi/coomi-client-connection`.
 * @module @coomi/coomi-client-connection/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-client-connection'

/** Cordis companion plugin name. */
export const name = 'client-connection-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the wire layer emits no cordis events and owns no
 * mutable cross-plugin relation — stream/reconnect sequencing is exercised
 * directly by its behavior specs, rpcId round-trip discipline is owned by the
 * apiproxy contract layer, and the node half's single route registration's
 * register/dispose symmetry is audited by the webserver package's invariant.
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
