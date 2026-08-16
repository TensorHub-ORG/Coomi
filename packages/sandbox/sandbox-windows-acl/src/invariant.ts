/**
 * Package-owned invariant companion for `@coomi/coomi-sandbox-windows-acl`.
 * @module @coomi/coomi-sandbox-windows-acl/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-sandbox-windows-acl'

/** Cordis companion plugin name. */
export const name = 'sandbox-windows-acl-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package exposes no independent event sequence or
 * mutable data relation beyond the fail-closed contracts it enforces at each
 * Win32 call boundary.
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
