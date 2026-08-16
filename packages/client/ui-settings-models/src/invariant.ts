/**
 * Package-owned invariant companion for `@coomi/coomi-client-ui-settings-models`.
 * @module @coomi/coomi-client-ui-settings-models/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-client-ui-settings-models'

/** Cordis companion plugin name. */
export const name = 'client-ui-settings-models-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a nav-entry-only section plugin rendering a fixed
 * empty content column — it emits no cordis events and owns no cross-plugin
 * mutable relation.
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
