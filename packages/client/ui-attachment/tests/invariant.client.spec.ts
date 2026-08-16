import { describe, expect, it } from 'vitest'
import { Context } from '@coomi/cordis'
import * as AttachmentInvariant from '@coomi/coomi-client-ui-attachment/invariant'
import InvariantRegistry from '@coomi/coomi-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(AttachmentInvariant).await()).resolves.toBeDefined()
  })
})
