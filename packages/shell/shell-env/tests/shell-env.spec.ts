/**
 * Registry tests for `@coomi/coomi-shell-env`: built-in facts, contributor
 * ownership and validation, collection ordering, effect-scoped disposal, and
 * the explicit disposer contract.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@coomi/cordis'
import { CallId } from '@coomi/coomi-llm'
import type { Agent } from '@coomi/coomi-agent'
import type { ToolExecution } from '@coomi/coomi-tools'
import { ShellEnvRegistry } from '@coomi/coomi-shell-env'
import * as BashEnvPlugin from '@coomi/coomi-shell-env'

const testToolSignal = new AbortController().signal

afterEach(() => vi.unstubAllEnvs())

function execution(sessionId?: string): ToolExecution {
  return {
    signal: testToolSignal,
    token: Symbol('bash-env-test') as ToolExecution['token'],
    callId: CallId('bash-env-call'),
    rootCallId: CallId('bash-env-call'),
    name: 'bash',
    arguments: { command: 'true' },
    ...(sessionId === undefined
      ? {}
      : { agent: { session: { header: { version: 0, id: sessionId, createdAt: 0 } } } as Agent }),
  }
}

describe('ShellEnvRegistry', () => {
  it('collects unconditional shell facts and the current agent session id', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { coomiHome: './test-coomi-home' })

    expect(registry.collect(execution())).toEqual({
      COOMI_HOME: resolve('./test-coomi-home'),
      COOMI_SHELL: '1',
    })
    expect(registry.collect(execution('session-a'))).toEqual({
      COOMI_HOME: resolve('./test-coomi-home'),
      COOMI_SESSION_ID: 'session-a',
      COOMI_SHELL: '1',
    })
  })

  it('resolves COOMI_HOME from the ambient override or the user-home default', () => {
    vi.stubEnv('COOMI_HOME', './ambient-coomi-home')
    const fromEnvironment = new ShellEnvRegistry(new Context())
    expect(fromEnvironment.collect(execution()).COOMI_HOME).toBe(resolve('./ambient-coomi-home'))

    vi.stubEnv('COOMI_HOME', undefined)
    const fromDefault = new ShellEnvRegistry(new Context())
    expect(fromDefault.collect(execution()).COOMI_HOME).toBe(join(homedir(), '.coomi'))
  })

  it('collects declared contributor variables and omits unavailable values', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { coomiHome: './test-coomi-home' })
    registry.register({
      name: 'optional-session-fact',
      variables: {
        COOMI_SESSION_OPTIONAL: { description: 'Optional session-scoped test fact.' },
      },
      resolve: exec => exec.agent === undefined ? {} : { COOMI_SESSION_OPTIONAL: exec.agent.session.header.id },
    })
    registry.register({
      name: 'always-available-fact',
      variables: {
        COOMI_ALWAYS_AVAILABLE: { description: 'Always-available test fact.' },
      },
      resolve: () => ({ COOMI_ALWAYS_AVAILABLE: 'yes' }),
    })

    expect(registry.collect(execution())).not.toHaveProperty('COOMI_SESSION_OPTIONAL')
    expect(registry.collect(execution()).COOMI_ALWAYS_AVAILABLE).toBe('yes')
    expect(registry.collect(execution('session-b')).COOMI_SESSION_OPTIONAL).toBe('session-b')
    expect(registry.list()).toEqual([
      {
        contributor: 'always-available-fact',
        description: 'Always-available test fact.',
        key: 'COOMI_ALWAYS_AVAILABLE',
      },
      {
        contributor: 'optional-session-fact',
        description: 'Optional session-scoped test fact.',
        key: 'COOMI_SESSION_OPTIONAL',
      },
    ])
  })

  it('rejects duplicate variable ownership at registration time', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { coomiHome: './test-coomi-home' })
    registry.register({
      name: 'first',
      variables: { COOMI_SHARED: { description: 'First owner.' } },
      resolve: () => ({ COOMI_SHARED: 'first' }),
    })

    expect(() => registry.register({
      name: 'second',
      variables: { COOMI_SHARED: { description: 'Second owner.' } },
      resolve: () => ({ COOMI_SHARED: 'second' }),
    })).toThrow(/COOMI_SHARED.*first.*second|COOMI_SHARED.*second.*first/)
  })

  it('rejects duplicate contributor names and malformed declarations', () => {
    const registry = new ShellEnvRegistry(new Context(), { coomiHome: './test-coomi-home' })
    registry.register({
      name: 'declared',
      variables: { COOMI_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({}),
    })

    expect(() => registry.register({
      name: 'declared',
      variables: { COOMI_ANOTHER: { description: 'Another fact.' } },
      resolve: () => ({}),
    })).toThrow(/already registered/)
    expect(() => registry.register({
      name: ' ',
      variables: { COOMI_BLANK_NAME: { description: 'Blank owner.' } },
      resolve: () => ({}),
    })).toThrow(/name must be non-empty/)
    expect(() => registry.register({
      name: 'invalid-key',
      variables: { coomi_invalid: { description: 'Invalid key.' } } as unknown as Record<'COOMI_INVALID', { description: string }>,
      resolve: () => ({}),
    })).toThrow(/invalid key/)
    expect(() => registry.register({
      name: 'reserved-key',
      variables: { COOMI_HOME: { description: 'Reserved key.' } },
      resolve: () => ({}),
    })).toThrow(/reserved key/)
    expect(() => registry.register({
      name: 'blank-description',
      variables: { COOMI_BLANK_DESCRIPTION: { description: ' ' } },
      resolve: () => ({}),
    })).toThrow(/must describe/)
  })

  it('rejects undeclared variables returned by a contributor', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { coomiHome: './test-coomi-home' })
    registry.register({
      name: 'drifted-provider',
      variables: { COOMI_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({ COOMI_UNDECLARED: 'bad' }),
    })

    expect(() => registry.collect(execution())).toThrow(/drifted-provider.*COOMI_UNDECLARED/)
  })

  it('rejects non-string values returned by a contributor', () => {
    const registry = new ShellEnvRegistry(new Context(), { coomiHome: './test-coomi-home' })
    registry.register({
      name: 'wrong-value-type',
      variables: { COOMI_STRING: { description: 'String fact.' } },
      resolve: () => ({ COOMI_STRING: 42 }) as unknown as Record<'COOMI_STRING', string>,
    })

    expect(() => registry.collect(execution())).toThrow(/wrong-value-type.*non-string.*COOMI_STRING/)
  })

  it('removes an effect-scoped contributor when its plugin is disposed', async () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { coomiHome: './test-coomi-home' })
    const fiber = await ctx.plugin({
      inject: ['shellEnv'],
      apply(inner: Context) {
        inner.shellEnv.register({
          name: 'temporary',
          variables: { COOMI_TEMPORARY: { description: 'Temporary fact.' } },
          resolve: () => ({ COOMI_TEMPORARY: 'present' }),
        })
      },
    })

    expect(registry.collect(execution()).COOMI_TEMPORARY).toBe('present')
    await fiber.dispose()
    expect(registry.collect(execution())).not.toHaveProperty('COOMI_TEMPORARY')
  })

  it('returns an explicit contributor disposer', () => {
    const registry = new ShellEnvRegistry(new Context(), { coomiHome: './test-coomi-home' })
    const dispose = registry.register({
      name: 'explicit-disposal',
      variables: { COOMI_EXPLICIT_DISPOSAL: { description: 'Explicitly disposed fact.' } },
      resolve: () => ({ COOMI_EXPLICIT_DISPOSAL: 'present' }),
    })

    expect(registry.collect(execution()).COOMI_EXPLICIT_DISPOSAL).toBe('present')
    dispose()
    expect(registry.collect(execution())).not.toHaveProperty('COOMI_EXPLICIT_DISPOSAL')
  })

  it('the plugin registers the service and the persistence contributor on load', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv).toBeInstanceOf(ShellEnvRegistry)
    expect(ctx.shellEnv.list()).toEqual([
      {
        contributor: 'session-persistence',
        description: 'Absolute target path of the current session JSONL when the active persistence backend provides one.',
        key: 'COOMI_SESSION_JSONL',
      },
    ])
  })

  it('the persistence contributor resolves COOMI_SESSION_JSONL only for a jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      locate: () => ({ kind: 'jsonl' as const, path: 'C:\\sessions\\s.jsonl' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p')).COOMI_SESSION_JSONL).toBe('C:\\sessions\\s.jsonl')
  })

  it('the persistence contributor omits the variable for a non-jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      locate: () => ({ kind: 'sqlite' as const, path: 'C:\\sessions\\s.db' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('COOMI_SESSION_JSONL')
  })

  it('the persistence contributor omits the variable without a persistence backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('COOMI_SESSION_JSONL')
  })
})
