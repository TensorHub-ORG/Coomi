import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { APP_IDENTITY, attributionHeaders, userAgent } from '@coomi/coomi-llm'
import type { AppIdentity } from '@coomi/coomi-llm'

const manifest = createRequire(import.meta.url)('../package.json') as { version: string }

/** A white-label identity exercising every override hook. */
const forkIdentity: AppIdentity = {
  product: 'fork-agent',
  version: '9.9.9',
  url: 'https://example.com/fork-agent',
}

describe('APP_IDENTITY', () => {
  it('sources the version from the package manifest, never a hand-copied constant', () => {
    expect(APP_IDENTITY.version).toBe(manifest.version)
  })

  it('carries only static public product facts', () => {
    expect(APP_IDENTITY).toEqual({
      product: 'coomi-desktop',
      version: manifest.version,
      url: 'https://github.com/coomi/coomi-desktop',
    })
  })
})

describe('userAgent', () => {
  it('renders product/version with the +url comment', () => {
    expect(userAgent()).toBe(
      `coomi-desktop/${manifest.version} (+https://github.com/coomi/coomi-desktop)`,
    )
  })

  it('renders a custom identity', () => {
    expect(userAgent(forkIdentity)).toBe('fork-agent/9.9.9 (+https://example.com/fork-agent)')
  })
})

describe('attributionHeaders', () => {
  it('defaults to the provider-neutral baseline: User-Agent and nothing else', () => {
    expect(attributionHeaders()).toEqual({ 'user-agent': userAgent() })
  })

  it('maps a custom identity onto the User-Agent header only', () => {
    expect(attributionHeaders(forkIdentity)).toEqual({
      'user-agent': 'fork-agent/9.9.9 (+https://example.com/fork-agent)',
    })
  })
})
