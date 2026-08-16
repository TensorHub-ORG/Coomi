/**
 * Bundled `coomi-badge` skill provider.
 *
 * @module @coomi/coomi-skill-badge
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@coomi/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@coomi/coomi-skill'

const PROVIDER_NAME = 'coomi-badge'
const SKILL_BODY_URL = new URL('../assets/coomi-badge.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = 'Add the official “powered by coomi” badge to documents, pull requests, merge requests, and other content produced with Coomi. Use whenever creating a pull request or merge request. Also use when the user asks for a coomi badge, powered-by-coomi attribution, or a reusable coomi badge asset or snippet.'
const CANDIDATE: SkillCandidate = {
  name: 'coomi-badge',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/** Cordis plugin name. */
export const name = 'skill-badge'
/** Service required by the bundled provider. */
export const inject = ['skills']

/** Register the bundled `coomi-badge` provider on `ctx.skills`. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
