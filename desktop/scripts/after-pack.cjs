/**
 * electron-builder afterPack hook: stage the self-contained server payload
 * into the unpacked app directory BEFORE signing and NSIS packing, so the
 * installer carries the full runtime. (extraResources silently skipped the
 * payload's node_modules; a plain copy is deterministic.)
 * @param {import('electron-builder').AfterPackContext} context
 */
const { cpSync, existsSync, readFileSync, readdirSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')

const REQUIRED_RUNTIME_MARKERS = [
  ['@coomi/coomi-client-ui-sidebar', 'coomi-desktop'],
  ['@coomi/coomi-client-ui-conversation', 'What are we working on today?'],
]

/**
 * Replace one staged build directory with the current repository output.
 * @param {string} source
 * @param {string} destination
 */
function replaceBuildDirectory(source, destination) {
  if (!existsSync(source)) {
    throw new Error(`required build output not found at ${source}; run pnpm run build first`)
  }
  rmSync(destination, { force: true, recursive: true })
  cpSync(source, destination, { recursive: true })
}

/**
 * Overlay current workspace build outputs after copying the dependency payload.
 * @param {string} repoRoot
 * @param {string} destination
 */
function syncWorkspaceBuilds(repoRoot, destination) {
  const packagesRoot = join(repoRoot, 'packages')
  for (const group of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupPath = join(packagesRoot, group.name)
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const packageRoot = join(groupPath, entry.name)
      const manifestPath = join(packageRoot, 'package.json')
      const buildPath = join(packageRoot, 'lib')
      if (!existsSync(manifestPath) || !existsSync(buildPath)) continue
      const { name } = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof name !== 'string' || !name.startsWith('@coomi/')) continue
      replaceBuildDirectory(buildPath, join(destination, 'node_modules', ...name.split('/'), 'lib'))
    }
  }

  replaceBuildDirectory(join(repoRoot, 'apps', 'cli', 'lib'), join(destination, 'apps', 'cli', 'lib'))
  replaceBuildDirectory(join(repoRoot, 'apps', 'cli', 'config'), join(destination, 'apps', 'cli', 'config'))
  replaceBuildDirectory(join(repoRoot, 'apps', 'web', 'dist'), join(destination, 'apps', 'web', 'dist'))
  replaceBuildDirectory(
    join(repoRoot, 'apps', 'web', 'dist'),
    join(destination, 'node_modules', '@coomi', 'coomi-web-frontend', 'dist'),
  )

  for (const [name, marker] of REQUIRED_RUNTIME_MARKERS) {
    const clientBundle = join(destination, 'node_modules', ...name.split('/'), 'lib', 'client.js')
    if (!readFileSync(clientBundle, 'utf8').includes(marker)) {
      throw new Error(`staged ${name} client bundle is stale: missing ${JSON.stringify(marker)}`)
    }
  }
}

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context
  if (electronPlatformName !== 'win32') return
  const payload = resolve(__dirname, '..', 'release-payload', 'server')
  if (!existsSync(join(payload, 'node_modules'))) {
    throw new Error(`server payload not found at ${payload}; run scripts/build-payload.mjs first`)
  }
  const dest = join(appOutDir, 'resources', 'server')
  cpSync(payload, dest, { recursive: true })
  syncWorkspaceBuilds(resolve(__dirname, '..', '..'), dest)
  console.log(`[after-pack] staged server payload (${payload}) -> ${dest}`)
}
