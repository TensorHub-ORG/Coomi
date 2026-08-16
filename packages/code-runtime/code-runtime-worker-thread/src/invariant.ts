/**
 * Package-owned invariant companion for `@coomi/coomi-code-runtime-worker-thread`.
 * @module @coomi/coomi-code-runtime-worker-thread/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-code-runtime-worker-thread'

/** Cordis companion plugin name. */
export const name = 'code-runtime-worker-thread-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this process-boundary implementation exposes no same-process event relation;
 * worker protocol and built-worker tests cover it.
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
