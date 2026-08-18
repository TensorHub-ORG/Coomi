const { spawn } = require('node:child_process')
const {
  mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile,
} = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, delimiter, dirname, join, resolve } = require('node:path')

const CONFIG_SCHEMA_VERSION = 1
const OFFICIAL_REPOSITORY = 'https://github.com/TensorHub-ORG/Coomi.git'
const OFFICIAL_BRANCH = 'coomi-desktop'
const SOURCE_MARKERS = [
  'package.json',
  'pnpm-lock.yaml',
  'apps/cli/src/bin.ts',
  'apps/web/package.json',
]
const PREPARED_MARKERS = [
  'node_modules/tsx/package.json',
  'apps/web/dist/index.html',
]
const SECRET_ENVIRONMENT_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD)/i

/** Return inherited process variables without credential-like names. */
function scrubEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name, value]) => (
      value !== undefined && !SECRET_ENVIRONMENT_NAME.test(name)
    )),
  )
}

/** Execute a child command and retain both output streams for diagnostics. */
function runCommand(command, args, options = {}) {
  const {
    cwd,
    env = scrubEnvironment(),
    onOutput = () => {},
    timeoutMs = 0,
  } = options
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timeout
    const append = (kind, chunk) => {
      const text = chunk.toString('utf8')
      if (kind === 'stdout') stdout += text
      else stderr += text
      onOutput(text, kind)
    }
    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))
    child.once('error', rejectCommand)
    child.once('exit', (code, signal) => {
      if (timeout) clearTimeout(timeout)
      if (code === 0) {
        resolveCommand({ stdout, stderr })
        return
      }
      const detail = stderr.trim() || stdout.trim() || `signal ${signal ?? 'unknown'}`
      rejectCommand(new Error(`${basename(command)} exited with code ${String(code)}: ${detail}`))
    })
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill()
        rejectCommand(new Error(`${basename(command)} timed out after ${String(timeoutMs)}ms`))
      }, timeoutMs)
    }
  })
}

/** Run Git against one source workspace without changing the caller's cwd. */
function runGit(root, args, options = {}) {
  return runCommand('git', ['-C', root, ...args], options)
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/** Validate the repository files and report whether dependencies are prepared. */
async function inspectSourceRoot(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: false, error: '请选择 Coomi 源码目录。' }
  }
  const root = resolve(candidate)
  const missing = []
  for (const marker of SOURCE_MARKERS) {
    if (!await isFile(join(root, ...marker.split('/')))) missing.push(marker)
  }
  if (missing.length > 0) {
    return {
      ok: false,
      root,
      error: `该目录不是完整的 Coomi 源码：缺少 ${missing.join('、')}`,
    }
  }
  try {
    const { stdout } = await runGit(root, ['rev-parse', '--show-toplevel'])
    if (resolve(stdout.trim()) !== root) {
      return { ok: false, root, error: '请选择 Coomi Git 工作区的根目录。' }
    }
  } catch (error) {
    return { ok: false, root, error: `无法读取源码 Git 基线：${error.message}` }
  }
  const missingPrepared = []
  for (const marker of PREPARED_MARKERS) {
    if (!await isFile(join(root, ...marker.split('/')))) missingPrepared.push(marker)
  }
  return { ok: true, root, prepared: missingPrepared.length === 0, missingPrepared }
}

/** Read the persisted external-runtime selection, returning null before setup. */
async function readRuntimeConfig(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (
      parsed?.schemaVersion !== CONFIG_SCHEMA_VERSION
      || typeof parsed.sourceRoot !== 'string'
      || typeof parsed.baseCommit !== 'string'
    ) return null
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

/** Atomically persist the selected source root and immutable comparison base. */
async function writeRuntimeConfig(path, config) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    sourceRoot: resolve(config.sourceRoot),
    baseCommit: config.baseCommit,
    repository: config.repository ?? OFFICIAL_REPOSITORY,
    branch: config.branch ?? OFFICIAL_BRANCH,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

/** Capture the current Git commit as the base for later source-change exports. */
async function captureBaseCommit(root) {
  const { stdout } = await runGit(root, ['rev-parse', 'HEAD'])
  const commit = stdout.trim()
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('Git did not return a full source commit.')
  return commit
}

/** Clone the official editable source branch into an empty chosen directory. */
async function cloneOfficialSource(destination, options = {}) {
  const root = resolve(destination)
  await mkdir(root, { recursive: true })
  const entries = await readdir(root)
  if (entries.length > 0) throw new Error('安装源码的位置必须是空目录。')
  await runCommand('git', [
    'clone', '--branch', OFFICIAL_BRANCH, '--single-branch', OFFICIAL_REPOSITORY, '.',
  ], { ...options, cwd: root })
  return root
}

/** Install the locked workspace and build the initial browser and host artifacts. */
async function prepareSource(root, pnpmEntry, electronExecutable, options = {}) {
  const env = {
    ...scrubEnvironment(),
    PATH: `${dirname(electronExecutable)}${delimiter}${scrubEnvironment().PATH ?? ''}`,
  }
  await runCommand(electronExecutable, [
    pnpmEntry, 'install', '--frozen-lockfile',
  ], { ...options, cwd: root, env })
  await runCommand(electronExecutable, [
    pnpmEntry, 'run', 'build',
  ], { ...options, cwd: root, env })
}

/** Report the concise Git status used by the desktop management menu. */
async function readSourceStatus(root) {
  const { stdout } = await runGit(root, ['status', '--short', '--untracked-files=all'])
  const files = stdout.split(/\r?\n/).filter(Boolean)
  return { files, count: files.length }
}

/**
 * Record the whole worktree against its installation base without touching the
 * user's index. A private temporary index makes untracked files part of the
 * binary-capable patch while Git's ignore rules still exclude dependencies.
 */
async function createDiffCheckpoint(root, baseCommit, changesRoot, now = new Date()) {
  const privateDirectory = await mkdtemp(join(tmpdir(), 'coomi-diff-'))
  const privateIndex = join(privateDirectory, 'index')
  try {
    const env = { ...scrubEnvironment(), GIT_INDEX_FILE: privateIndex }
    await runGit(root, ['read-tree', baseCommit], { env })
    await runGit(root, ['add', '-A', '--', '.'], { env })
    const { stdout: patch } = await runGit(root, [
      'diff', '--cached', '--binary', '--full-index', baseCommit, '--', '.',
    ], { env })
    if (patch.length === 0) return null

    const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z')
    const checkpointDirectory = join(changesRoot, stamp)
    await mkdir(checkpointDirectory, { recursive: true })
    const patchPath = join(checkpointDirectory, 'changes.diff')
    await writeFile(patchPath, patch, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const { stdout: headOutput } = await runGit(root, ['rev-parse', 'HEAD'])
    const { stdout: statOutput } = await runGit(root, [
      'diff', '--cached', '--stat', baseCommit, '--', '.',
    ], { env })
    const manifestPath = join(checkpointDirectory, 'manifest.json')
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      createdAt: now.toISOString(),
      sourceRoot: resolve(root),
      baseCommit,
      headCommit: headOutput.trim(),
      patch: 'changes.diff',
      summary: statOutput.trim(),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return { directory: checkpointDirectory, patchPath, manifestPath, summary: statOutput.trim() }
  } finally {
    await rm(privateDirectory, { recursive: true, force: true })
  }
}

module.exports = {
  OFFICIAL_BRANCH,
  OFFICIAL_REPOSITORY,
  captureBaseCommit,
  cloneOfficialSource,
  createDiffCheckpoint,
  inspectSourceRoot,
  prepareSource,
  readRuntimeConfig,
  readSourceStatus,
  runCommand,
  scrubEnvironment,
  writeRuntimeConfig,
}
