import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_COOMI_HOME_DISPLAY,
  COOMI_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultCoomiHome,
  coomiHomeDisplay,
  coomiHomePath,
  expandHomePath,
  resolveCoomiHome,
} from '@coomi/coomi-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('coomi path helpers', () => {
  it('owns the shared default coomi home directory name', () => {
    expect(COOMI_HOME_DIR_NAME).toBe('.coomi')
    expect(DEFAULT_COOMI_HOME_DISPLAY).toBe('~/.coomi')
    expect(defaultCoomiHome()).toBe(join(homedir(), '.coomi'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.coomi')).toBe(join(homedir(), '.coomi'))
    expect(expandHomePath('~\\.coomi')).toBe(join(homedir(), '.coomi'))
    expect(expandHomePath('/tmp/.coomi')).toBe('/tmp/.coomi')
    expect(expandHomePath('~other/.coomi')).toBe('~other/.coomi')
  })

  it('resolves explicit path before COOMI_HOME and the default', () => {
    const envHome = join(homedir(), 'env-coomi')

    expect(resolveCoomiHome('/tmp/explicit-coomi', { COOMI_HOME: '~/env-coomi' })).toBe(resolve('/tmp/explicit-coomi'))
    expect(resolveCoomiHome(undefined, { COOMI_HOME: '~/env-coomi' })).toBe(envHome)
    expect(resolveCoomiHome(undefined, {})).toBe(defaultCoomiHome())
  })

  it('treats an empty or whitespace-only COOMI_HOME as unset', () => {
    expect(resolveCoomiHome(undefined, { COOMI_HOME: '' })).toBe(defaultCoomiHome())
    expect(resolveCoomiHome(undefined, { COOMI_HOME: '   ' })).toBe(defaultCoomiHome())
  })

  it('joins child segments onto the resolved COOMI_HOME', () => {
    vi.stubEnv('COOMI_HOME', '~/env-coomi')
    expect(coomiHomePath()).toBe(join(homedir(), 'env-coomi'))
    expect(coomiHomePath('storages', 'cache')).toBe(join(homedir(), 'env-coomi', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(coomiHomeDisplay(resolve(defaultCoomiHome()))).toBe('~/.coomi')
    expect(coomiHomeDisplay('/some/other/root')).toBe('$COOMI_HOME')
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coomi-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
