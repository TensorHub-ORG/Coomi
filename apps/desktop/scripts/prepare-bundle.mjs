#!/usr/bin/env node
/**
 * 打包前准备（beforeBuildCommand 的一环）。
 *
 * 为什么需要它：tauri.conf.json 的 bundle.resources 以前写的是本机绝对路径
 * （G:/DSH/... 与 C:/Users/...），换一台机器、换一个目录就构建不出可用的包 ——
 * 装到用户机器上表现为「找不到引擎二进制」。这里把两个产物拷进 apps/desktop/，
 * 之后 resources 只引用相对路径：coomi.exe 与 ui-dist。
 *
 * 缺失即失败（而不是静默产出一个装不起来的包）。
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const repoApps = resolve(desktopDir, '..')

const engineSrc = join(repoApps, 'coomi-rs', 'target', 'release', 'coomi.exe')
const uiSrc = join(repoApps, 'desktop-ui-react', 'dist')

const engineDst = join(desktopDir, 'coomi.exe')
const uiDst = join(desktopDir, 'ui-dist')

function fail(message) {
  console.error('[prepare-bundle] ' + message)
  process.exit(1)
}

if (!existsSync(engineSrc)) {
  fail('找不到引擎产物：' + engineSrc + '\n  先跑：cargo build --release -p coomi-ui（在 apps/coomi-rs 下）')
}
if (!existsSync(uiSrc)) {
  fail('找不到前端产物：' + uiSrc + '\n  先跑：npm run build（在 apps/desktop-ui-react 下）')
}

cpSync(engineSrc, engineDst)
if (existsSync(uiDst)) rmSync(uiDst, { recursive: true, force: true })
mkdirSync(uiDst, { recursive: true })
cpSync(uiSrc, uiDst, { recursive: true })

console.log(
  '[prepare-bundle] coomi.exe ' + statSync(engineDst).size + ' bytes; ui-dist 就绪',
)
