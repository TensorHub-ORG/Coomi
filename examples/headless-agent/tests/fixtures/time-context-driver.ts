#!/usr/bin/env node
/** Test driver that sends two turns through one Headless Loader composition. */

import { boot, resolveConfigPath } from '@coomi/coomi-app-boot'
import { runFixtureTurn } from '@coomi/coomi-loader-smoke'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('time-context driver requires a config path')

const ctx = await boot('time-context-e2e', resolveConfigPath(configPath, undefined))
try {
  await runFixtureTurn(ctx, { task: 'first' })
  await runFixtureTurn(ctx, { task: 'second' })
} finally {
  await ctx.fiber.dispose()
}
