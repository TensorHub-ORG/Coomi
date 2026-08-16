// Materialize every directory junction in the payload as a real directory
// copy (dereference), making the payload self-contained and portable.
// Dangling links are dropped; cycles are broken via a visited set.
// Usage: node materialize-payload.mjs <payload-root>
import { readdir, realpath, lstat, stat, mkdir, copyFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'

const root = process.argv[2]
let materialized = 0
let skipped = 0

async function copyDeref(src, dst, ancestorTargets) {
  const st = await lstat(src).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink()) {
    const target = await realpath(src).catch(() => null)
    if (!target) { skipped++; return } // dangling link: drop
    const tst = await stat(target).catch(() => null)
    if (!tst) { skipped++; return }
    if (tst.isDirectory()) {
      // A link pointing at one of its own ancestors is a real cycle; other
      // repeated targets (many dependents of one package) are legitimate.
      const tKey = target.toLowerCase()
      if (ancestorTargets.has(tKey)) { skipped++; return }
      ancestorTargets.add(tKey)
      await mkdir(dst, { recursive: true })
      for (const e of await readdir(target, { withFileTypes: true })) {
        await copyDeref(join(target, e.name), join(dst, e.name), ancestorTargets)
      }
      ancestorTargets.delete(tKey)
    } else {
      await copyFile(target, dst)
    }
    materialized++
    return
  }
  if (st.isDirectory()) {
    await mkdir(dst, { recursive: true })
    for (const e of await readdir(src, { withFileTypes: true })) {
      await copyDeref(join(src, e.name), join(dst, e.name), ancestorTargets)
    }
    return
  }
  await copyFile(src, dst)
}

async function walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await realpath(full).catch(() => null)
      if (!target) { skipped++; continue }
      const tst = await stat(target).catch(() => null)
      if (!tst) { skipped++; continue }
      if (tst.isDirectory()) {
        const tKey = target.toLowerCase()
        const ancestors = new Set([dir.toLowerCase()])
        // Walk up the tree to guard against ancestor cycles.
        let up = dir
        while (true) {
          const parent = dirname(up)
          if (parent === up) break
          up = parent
          ancestors.add(up.toLowerCase())
        }
        if (ancestors.has(tKey)) { skipped++; continue }
        await rm(full, { recursive: true, force: true })
        await mkdir(full, { recursive: true })
        const inner = new Set(ancestors)
        inner.add(tKey)
        for (const e of await readdir(target, { withFileTypes: true })) {
          await copyDeref(join(target, e.name), join(full, e.name), inner)
        }
        materialized++
        await walk(full)
      } else {
        await rm(full, { force: true })
        await copyFile(target, full)
        materialized++
      }
    } else if (entry.isDirectory()) {
      await walk(full)
    }
  }
}

await walk(root)
console.log(`materialized ${materialized} links, skipped ${skipped} dangling/cyclic under ${root}`)
