#!/usr/bin/env node
/** Test driver: one delegation turn through a headless Loader composition. */

import { boot, resolveConfigPath } from '@coomi/coomi-app-boot'
import { runFixtureTurn } from '@coomi/coomi-loader-smoke'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('sdk-subagent cwd driver requires a config path')

const ctx = await boot('sdk-subagent-cwd-e2e', resolveConfigPath(configPath, undefined))
try {
  await runFixtureTurn(ctx, { task: 'delegate' })
} finally {
  await ctx.fiber.dispose()
}
