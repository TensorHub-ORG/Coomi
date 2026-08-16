import { describe, expect, it, vi } from 'vitest'
import * as invariant from '@coomi/coomi-command-compact/invariant'

describe('command-compact invariant companion', () => {
  it('registers the package-owned no-op installer', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never
    const dispose = await invariant.apply(ctx)
    expect(invariant.name).toBe('command-compact-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@coomi/coomi-command-compact', expect.any(Function))
    expect(() => {
      const install = register.mock.calls[0]![1] as () => void
      install()
    }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
