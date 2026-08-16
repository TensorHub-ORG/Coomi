/**
 * electron-builder afterPack hook: stage the self-contained server payload
 * into the unpacked app directory BEFORE signing and NSIS packing, so the
 * installer carries the full runtime. (extraResources silently skipped the
 * payload's node_modules; a plain copy is deterministic.)
 * @param {import('electron-builder').AfterPackContext} context
 */
const { cpSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context
  if (electronPlatformName !== 'win32') return
  const payload = resolve(__dirname, '..', 'release-payload', 'server')
  if (!existsSync(join(payload, 'node_modules'))) {
    throw new Error(`server payload not found at ${payload}; run scripts/build-payload.mjs first`)
  }
  const dest = join(appOutDir, 'resources', 'server')
  cpSync(payload, dest, { recursive: true })
  console.log(`[after-pack] staged server payload (${payload}) -> ${dest}`)
}
