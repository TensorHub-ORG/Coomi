const assert = require('node:assert/strict')
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { afterEach, test } = require('node:test')
const {
  captureBaseCommit,
  createDiffCheckpoint,
  inspectSourceRoot,
  readRuntimeConfig,
  runCommand,
  scrubEnvironment,
  writeRuntimeConfig,
} = require('../src/runtime-source.cjs')

const temporaryDirectories = []

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function createSourceRepository() {
  const root = await temporaryDirectory('coomi-source-test-')
  for (const marker of [
    'apps/cli/src/bin.ts',
    'apps/web/package.json',
    'apps/web/dist/index.html',
    'node_modules/tsx/package.json',
  ]) {
    const path = join(root, ...marker.split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `${marker}\n`)
  }
  await writeFile(join(root, 'package.json'), '{"private":true}\n')
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await runCommand('git', ['init'], { cwd: root })
  await runCommand('git', ['config', 'user.email', 'desktop-test@coomi.invalid'], { cwd: root })
  await runCommand('git', ['config', 'user.name', 'Coomi Desktop Test'], { cwd: root })
  await runCommand('git', ['add', '.'], { cwd: root })
  await runCommand('git', ['commit', '-m', 'base'], { cwd: root })
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

test('scrubEnvironment excludes credential-like variable names', () => {
  assert.deepEqual(scrubEnvironment({
    PATH: 'bin',
    DEEPSEEK_API_KEY: 'secret',
    SESSION_TOKEN: 'secret',
    Ordinary: 'value',
    Missing: undefined,
  }), { PATH: 'bin', Ordinary: 'value' })
})

test('inspectSourceRoot accepts a prepared Git checkout and rejects an incomplete directory', async () => {
  const root = await createSourceRepository()
  assert.deepEqual(await inspectSourceRoot(root), {
    ok: true,
    root,
    prepared: true,
    missingPrepared: [],
  })
  const incomplete = await temporaryDirectory('coomi-source-incomplete-')
  const result = await inspectSourceRoot(incomplete)
  assert.equal(result.ok, false)
  assert.match(result.error, /缺少/)
})

test('runtime config preserves the selected source and comparison commit', async () => {
  const root = await createSourceRepository()
  const configPath = join(await temporaryDirectory('coomi-config-test-'), 'desktop-runtime.json')
  const baseCommit = await captureBaseCommit(root)
  await writeRuntimeConfig(configPath, { sourceRoot: root, baseCommit })
  const config = await readRuntimeConfig(configPath)
  assert.equal(config.sourceRoot, root)
  assert.equal(config.baseCommit, baseCommit)
  assert.equal(config.schemaVersion, 1)
})

test('diff checkpoint includes tracked edits and untracked files without changing the Git index', async () => {
  const root = await createSourceRepository()
  const baseCommit = await captureBaseCommit(root)
  await writeFile(join(root, 'package.json'), '{"private":true,"changed":true}\n')
  await writeFile(join(root, 'new-plugin.ts'), 'export const name = "new-plugin"\n')
  const before = await runCommand('git', ['-C', root, 'diff', '--cached', '--name-only'])
  assert.equal(before.stdout, '')

  const changesRoot = await temporaryDirectory('coomi-changes-test-')
  const checkpoint = await createDiffCheckpoint(
    root,
    baseCommit,
    changesRoot,
    new Date('2026-08-18T12:00:00.000Z'),
  )
  assert.ok(checkpoint)
  const patch = await readFile(checkpoint.patchPath, 'utf8')
  assert.match(patch, /diff --git a\/package\.json b\/package\.json/)
  assert.match(patch, /diff --git a\/new-plugin\.ts b\/new-plugin\.ts/)
  const manifest = JSON.parse(await readFile(checkpoint.manifestPath, 'utf8'))
  assert.equal(manifest.baseCommit, baseCommit)
  assert.match(manifest.summary, /2 files changed/)

  const after = await runCommand('git', ['-C', root, 'diff', '--cached', '--name-only'])
  assert.equal(after.stdout, '')
})
