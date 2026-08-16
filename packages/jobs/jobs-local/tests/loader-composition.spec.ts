import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@coomi/cordis'
import Include from '@coomi/cordis-plugin-include'
import Loader from '@coomi/cordis-plugin-loader'
import LocalJobRegistry from '@coomi/coomi-jobs-local'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('jobs-local through a real Loader composition', () => {
  it('applies the provider-owned admission config from a Cordis row', async () => {
    root = await mkdtemp(join(tmpdir(), 'coomi-jobs-local-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@coomi/coomi-jobs-local'",
      '  config:',
      '    maxConcurrentJobsPerOwner: 1',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@coomi/coomi-jobs-local') return LocalJobRegistry
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.jobs).toBeInstanceOf(LocalJobRegistry)
    context.jobs.attachController('loader-test')
    let settle!: (outcome: { status: 'killed' }) => void
    context.jobs.start({
      kind: 'bash',
      label: 'hold loader slot',
      run: () => ({
        cancel: () => { settle({ status: 'killed' }) },
        done: new Promise((resolve) => { settle = resolve }),
      }),
    })
    expect(() => context!.jobs.start({
      kind: 'bash',
      label: 'blocked loader job',
      run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }),
    })).toThrow('(limit: 1)')
  })
})
