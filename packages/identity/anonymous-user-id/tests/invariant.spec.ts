import { describe, expect, it } from 'vitest'
import { Context } from '@coomi/cordis'
import InvariantRegistry from '@coomi/coomi-invariants'
import * as UserIdInvariant from '@coomi/coomi-anonymous-user-id/invariant'

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(UserIdInvariant).await()).resolves.toBeDefined()
  })
})
