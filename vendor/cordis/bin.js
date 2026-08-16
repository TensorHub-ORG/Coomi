#!/usr/bin/env node

import { Context } from '@coomi/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@coomi/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@coomi/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
