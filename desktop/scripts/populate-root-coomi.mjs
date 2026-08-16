// Populate payload/node_modules/@coomi/<pkg> with real copies of every
// workspace package, so any module can resolve @coomi/* from the payload
// root (hoisted installs do not hoist workspace packages).
// Usage: node populate-root-coomi.mjs <payload-root>
import { readdir, readFile, cp, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'

const payload = process.argv[2]
const seen = new Set()
let copied = 0
let skipped = 0

async function exists(p) {
  try { await access(p); return true } catch { return false }
}

async function visit(pkgDir) {
  const manifestPath = join(pkgDir, 'package.json')
  if (!(await exists(manifestPath))) return
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return
  }
  const name = manifest.name
  if (typeof name !== 'string' || !name.startsWith('@coomi/')) return
  if (seen.has(name)) return
  seen.add(name)
  const dest = join(payload, 'node_modules', name)
  if (await exists(dest)) { skipped++; return }
  await mkdir(join(payload, 'node_modules', '@coomi'), { recursive: true })
  await cp(pkgDir, dest, { recursive: true, dereference: true })
  copied++
}

for (const base of ['packages', 'vendor', 'apps', 'native', 'website']) {
  const root = join(payload, base)
  if (!(await exists(root))) continue
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const group = join(root, entry.name)
    if (base === 'vendor') {
      // Vendored packages live directly under vendor/<pkg>.
      await visit(group)
      continue
    }
    for (const sub of await readdir(group, { withFileTypes: true })) {
      if (sub.isDirectory()) await visit(join(group, sub.name))
    }
  }
}
console.log(`copied ${copied} workspace packages, skipped ${skipped} existing`)
