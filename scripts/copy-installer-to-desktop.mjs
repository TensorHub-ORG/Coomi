#!/usr/bin/env node
/**
 * 把最新构建出的 NSIS 安装包复制到桌面，便于直接取用。
 *
 *   · 目标是「桌面/CoomiPlus 安装包/」，文件名带版本号；
 *   · 只保留最近 KEEP 个，避免桌面越堆越多；
 *   · 原产物仍留在 target/release/bundle/nsis/，这里只做**复制**，不移动。
 *
 * 用法：node scripts/copy-installer-to-desktop.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KEEP = 3
const nsis = 'G:/DSH/coomi-full-project/apps/desktop/target/release/bundle/nsis'
if (!existsSync(nsis)) {
  console.error('没有找到构建产物目录：' + nsis)
  process.exit(1)
}

const setups = readdirSync(nsis)
  .filter((name) => name.endsWith('-setup.exe'))
  .map((name) => ({ name, path: join(nsis, name), mtime: statSync(join(nsis, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
if (!setups.length) {
  console.error('没有找到任何 *-setup.exe')
  process.exit(1)
}
const newest = setups[0]

const desktop = join(homedir(), 'Desktop')
if (!existsSync(desktop)) {
  console.error('找不到桌面目录：' + desktop)
  process.exit(1)
}
const targetDir = join(desktop, 'CoomiPlus 安装包')
mkdirSync(targetDir, { recursive: true })
const target = join(targetDir, newest.name)
copyFileSync(newest.path, target)
console.log('已复制到桌面：' + target)

/* 清理：桌面目录里按修改时间只留最近 KEEP 个。 */
const present = readdirSync(targetDir)
  .filter((name) => name.endsWith('-setup.exe'))
  .map((name) => ({ name, path: join(targetDir, name), mtime: statSync(join(targetDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
for (const stale of present.slice(KEEP)) {
  rmSync(stale.path, { force: true })
  console.log('已清理旧安装包：' + stale.name)
}
