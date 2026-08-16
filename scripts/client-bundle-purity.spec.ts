/**
 * Pins shared client-bundle preset rules: the module-edge purity gate and
 * the physical watch dependencies hidden behind virtual CSS Modules.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { CLIENT_EXTERNALS, clientBundle } from '../packages/client/tsdown.client.ts'

type ResolveId = (source: string) => null | { id: string; external: boolean }

interface CssModulePlugin {
  name: string
  resolveId?: (source: string, importer: string | undefined) => null | string
  load?: (this: { addWatchFile: (id: string) => void }, id: string) => Promise<unknown>
}

function clientConfigs(id = '@coomi/coomi-client-test') {
  return clientBundle(id, ['lib/types/index.js', 'lib/types/invariant.js'])(
    { env: { COOMI_BUILD_FACE: 'client' } },
  ).filter(config => config.platform === 'browser')
}

describe('client bundle build faces', () => {
  it('watches source in development and consumes emitted JavaScript in the Client build', () => {
    const bundle = clientBundle('@coomi/coomi-client-test', ['lib/types/index.js'])
    const development = bundle({ env: {} }).find(config => config.platform === 'browser')
    const artifact = bundle({ env: { COOMI_BUILD_FACE: 'client' } })
      .find(config => config.platform === 'browser')

    expect(development?.entry).toEqual({ client: 'src/client/index.ts' })
    expect(artifact?.entry).toEqual({ client: 'lib/types/client/index.js' })
  })
})

function clientSourceMapPath(packagePath: string): string {
  return fileURLToPath(new URL(`../packages/${packagePath}/lib/client.js.map`, import.meta.url))
}

function purityResolveId(): ResolveId {
  // libEntry is spelled at every call site (no default) so the
  // package-invariants text check can see the invariant entry per package.
  const configs = clientConfigs()
  const plugins = (configs[0] as { plugins: { name: string; resolveId?: unknown }[] }).plugins
  const gate = plugins.find(p => p.name === 'coomi-client-bundle-purity')
  if (gate?.resolveId === undefined) throw new Error('purity plugin missing from client config')
  return gate.resolveId as ResolveId
}

function cssModulePlugin(): CssModulePlugin {
  const configs = clientConfigs()
  const plugins = (configs[0] as { plugins: CssModulePlugin[] }).plugins
  const plugin = plugins.find(candidate => candidate.name === 'coomi-css-modules-inline')
  if (plugin?.resolveId === undefined || plugin.load === undefined) {
    throw new Error('CSS Modules plugin missing from client config')
  }
  return plugin
}

describe('client bundle purity gate', () => {
  const resolveId = purityResolveId()

  it('leaves platform table entries and non-scoped specifiers alone', () => {
    expect(resolveId('@coomi/coomi-client-ui-slots')).toBeNull()
    expect(resolveId('@coomi/coomi-client-web-react')).toBeNull()
    expect(resolveId('@coomi/coomi-client-ui-primitives')).toBeNull()
    expect(resolveId('react')).toBeNull()
    expect(resolveId('zod')).toBeNull()
  })

  it('rejects retired table entries (web-react/store left the 8-entry seed)', () => {
    expect(() => resolveId('@coomi/coomi-client-web-react/store')).toThrow(/purity/)
  })

  it('lets inline-safe wire layers inline', () => {
    expect(resolveId('@coomi/coomi-host-apiproxy/api')).toBeNull()
    expect(resolveId('@coomi/coomi-session/surface')).toBeNull()
    expect(resolveId('@coomi/coomi-brand')).toBeNull()
  })

  it('lets exact generated Remote contributions inline without admitting their package implementation', () => {
    expect(resolveId('@coomi/coomi-goal/remote')).toBeNull()
    expect(() => resolveId('@coomi/coomi-goal')).toThrow(/purity/)
    expect(() => resolveId('@coomi/coomi-goal/client')).toThrow(/purity/)
    expect(() => resolveId('@coomi/coomi-goal/remote/nested')).toThrow(/purity/)
  })

  it('throws on any other @coomi leak', () => {
    expect(() => resolveId('@coomi/coomi-agent')).toThrow(/purity/)
    expect(() => resolveId('@coomi/coomi-client-web')).toThrow(/purity/)
  })

  it('throws on cross-plugin value imports — bare plugin names and /client subpaths alike (the rewrite arm is gone)', () => {
    expect(() => resolveId('@coomi/coomi-client-connection')).toThrow(/purity/)
    expect(() => resolveId('@coomi/coomi-client-runtime')).toThrow(/purity/)
    expect(() => resolveId('@coomi/coomi-client-ui-layout/client')).toThrow(/purity/)
  })

  it('carries exactly one documented temporary exemption: runtime/client (store engine pending rehoming)', () => {
    expect(resolveId('@coomi/coomi-client-runtime/client')).toBeNull()
    const clientChannels = CLIENT_EXTERNALS.filter(
      entry => entry.startsWith('@coomi/') && entry.endsWith('/client'))
    expect(clientChannels).toEqual(['@coomi/coomi-client-runtime/client'])
  })
})

describe('client bundle debug artifacts', () => {
  it('emits source maps for plugin TS and TSX outside the Vite module graph', () => {
    const configs = clientConfigs()
    expect(configs[0]?.sourcemap).toBe(true)
  })

  it('maps first-party sources to their repository package paths', () => {
    const configs = clientConfigs('@coomi/coomi-client-ui-goal')
    const outputOptions = configs[0]?.outputOptions
    if (typeof outputOptions !== 'object' || outputOptions === null) throw new Error('client output options missing')
    const transform = outputOptions.sourcemapPathTransform
    if (transform === undefined) throw new Error('client sourcemap path transform missing')

    const source = transform('../src/client/GoalBar.tsx', clientSourceMapPath('client/ui-goal'))
    expect(source).toBe('../../../packages/client/ui-goal/src/client/GoalBar.tsx')
    const resolved = new URL(source, 'https://coomi.test/plugins/@coomi/coomi-client-ui-goal/client.js.map')
    expect(resolved.pathname).toBe('/packages/client/ui-goal/src/client/GoalBar.tsx')
  })

  it('maps dual-face host sources to the host package group', () => {
    const configs = clientConfigs('@coomi/coomi-host-directory-picker-native')
    const outputOptions = configs[0]?.outputOptions
    if (typeof outputOptions !== 'object' || outputOptions === null) throw new Error('client output options missing')
    const transform = outputOptions.sourcemapPathTransform
    if (transform === undefined) throw new Error('client sourcemap path transform missing')

    const source = transform('../src/client/index.ts', clientSourceMapPath('host/directory-picker-native'))
    expect(source).toBe('../../../packages/host/directory-picker-native/src/client/index.ts')
  })

  it('maps inlined workspace sources to packages and leaves dependencies outside it unchanged', () => {
    const configs = clientConfigs('@coomi/coomi-client-connection')
    const outputOptions = configs[0]?.outputOptions
    if (typeof outputOptions !== 'object' || outputOptions === null) throw new Error('client output options missing')
    const transform = outputOptions.sourcemapPathTransform
    if (transform === undefined) throw new Error('client sourcemap path transform missing')

    const sourceMapPath = clientSourceMapPath('client/connection')
    const workspaceSource = transform('../../../host/apiproxy/src/api/rpc.ts', sourceMapPath)
    expect(workspaceSource).toBe('../../../packages/host/apiproxy/src/api/rpc.ts')
    const resolved = new URL(workspaceSource, 'https://coomi.test/plugins/@coomi/coomi-client-connection/client.js.map')
    expect(resolved.pathname).toBe('/packages/host/apiproxy/src/api/rpc.ts')

    const dependencySource = '../../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/index.js'
    expect(transform(dependencySource, sourceMapPath)).toBe(dependencySource)
  })
})

describe('client bundle CSS Modules watch graph', () => {
  it('registers the physical stylesheet read behind a virtual module', async () => {
    const plugin = cssModulePlugin()
    const importer = fileURLToPath(new URL(
      '../packages/client/ui-conversation/src/client/queue/QueueDock.tsx',
      import.meta.url,
    ))
    const stylesheet = fileURLToPath(new URL(
      '../packages/client/ui-conversation/src/client/queue/QueueDock.module.css',
      import.meta.url,
    ))
    const virtualId = plugin.resolveId?.('./QueueDock.module.css', importer)
    if (virtualId === null || virtualId === undefined) throw new Error('CSS Modules import was not resolved')
    const addWatchFile = vi.fn()

    await plugin.load?.call({ addWatchFile }, virtualId)

    expect(addWatchFile).toHaveBeenCalledExactlyOnceWith(stylesheet)
  })
})
