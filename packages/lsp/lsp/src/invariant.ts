/**
 * Package-owned invariant companion for `@coomi/coomi-lsp`.
 * @module @coomi/coomi-lsp/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-lsp'

/** Cordis companion plugin name. */
export const name = 'lsp-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: provider ids and extension routes are private, atomically updated state;
 * the seam exposes neither an enumerable snapshot nor lifecycle events to compare independently.
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
