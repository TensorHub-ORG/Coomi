/** The shared `bash` settings section as the pwsh executor family resolves it. */

import { describe, expect, it } from 'vitest'
import { Context } from '@coomi/cordis'
import type { Fiber } from '@coomi/cordis'
import { SettingsProvider } from '@coomi/coomi-settings'
import type { SettingsNamespace } from '@coomi/coomi-settings'
import { SHELL_SETTINGS_NAMESPACE } from '@coomi/coomi-shell'
import LocalSubprocessRuntime from '@coomi/coomi-subprocess-local'
import { PwshLocalExecutor } from '@coomi/coomi-pwsh-local'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(config: ConstructorParameters<typeof PwshLocalExecutor>[1] = {}): Promise<{
  ctx: Context
  settingsFiber: Fiber
  executorFiber: Fiber
  pwsh: PwshLocalExecutor
}> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const executorFiber = ctx.plugin(PwshLocalExecutor, { timeoutMs: 60_000, ...config })
  await executorFiber.await()
  return { ctx, settingsFiber, executorFiber, pwsh: ctx.shell as PwshLocalExecutor }
}

describe('pwsh executor over the bash settings section', () => {
  it('resolves the user layer over the composition entry', async () => {
    const bench = await boot()
    expect(bench.pwsh.config.timeoutMs).toBe(60_000)

    await bench.ctx.settings.update(SHELL_SETTINGS_NAMESPACE, { timeoutMs: 5_000 })

    expect(bench.pwsh.config.timeoutMs).toBe(5_000)
    await bench.ctx.fiber.dispose()
  })

  it('refuses a stored value the constructor would have rejected', async () => {
    const bench = await boot()

    await expect(bench.ctx.settings.update(SHELL_SETTINGS_NAMESPACE, { timeoutMs: 0 }))
      .rejects.toThrow(/pwsh-local: timeoutMs must be a positive finite number/)

    expect(bench.pwsh.config.timeoutMs).toBe(60_000)
    await bench.ctx.fiber.dispose()
  })

  it('re-resolves the executable when the stored path changes', async () => {
    const bench = await boot({ pwshPath: '/opt/first/pwsh' })
    expect(bench.pwsh.pwshPath).toBe('/opt/first/pwsh')

    await bench.ctx.settings.update(SHELL_SETTINGS_NAMESPACE, { pwshPath: '/opt/second/pwsh' })

    expect(bench.pwsh.pwshPath).toBe('/opt/second/pwsh')
    await bench.ctx.fiber.dispose()
  })

  it('keeps the resolved executable when an unrelated field changes', async () => {
    const bench = await boot({ pwshPath: '/opt/first/pwsh' })
    const before = bench.pwsh.pwshPath

    await bench.ctx.settings.update(SHELL_SETTINGS_NAMESPACE, { timeoutMs: 5_000 })

    expect(bench.pwsh.pwshPath).toBe(before)
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot({ pwshPath: '/opt/first/pwsh' })
    await bench.ctx.settings.update(SHELL_SETTINGS_NAMESPACE, { timeoutMs: 5_000, pwshPath: '/opt/second/pwsh' })
    expect(bench.pwsh.config.timeoutMs).toBe(5_000)
    expect(bench.pwsh.pwshPath).toBe('/opt/second/pwsh')

    await bench.settingsFiber.dispose()

    expect(bench.pwsh.config.timeoutMs).toBe(60_000)
    expect(bench.pwsh.pwshPath).toBe('/opt/first/pwsh')
    await bench.ctx.fiber.dispose()
  })

  it('releases the namespace when the executor unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('shell')

    await bench.executorFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('shell')
    await bench.ctx.fiber.dispose()
  })
})
