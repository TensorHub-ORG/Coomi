/**
 * Package-owned invariant companion for `@coomi/coomi-mcp-client`.
 * @module @coomi/coomi-mcp-client/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@coomi/cordis'
import type { InvariantInstaller } from '@coomi/coomi-invariants'

const PACKAGE_NAME = '@coomi/coomi-mcp-client'

/** Cordis companion plugin name. */
export const name = 'mcp-client-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: MCP generations contribute through the tool registry, but the bridge
 * exposes no independent server-to-tool snapshot after an asynchronous resync.
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
