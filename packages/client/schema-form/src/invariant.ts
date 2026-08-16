/**
 * Package-owned invariant companion for `@coomi/coomi-client-schema-form`.
 * @module @coomi/coomi-client-schema-form/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-client-schema-form'

/** Cordis companion plugin name. */
export const name = 'client-schema-form-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a pure schema/draft helper library — it emits no
 * cordis events and owns no cross-plugin mutable relation; draft
 * immutability, schema rehydration, and path-edit round trips are asserted
 * directly by this package's model specs.
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
