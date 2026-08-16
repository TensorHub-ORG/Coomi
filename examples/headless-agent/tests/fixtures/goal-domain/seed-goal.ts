/** Test-only Loader plugin that creates a goal at the first real step edge. */

import type { Context } from '@coomi/cordis'
import type {} from '@coomi/coomi-goal'

export const name = 'seed-goal'
export const inject = ['goals']

export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', ({ agent }, next) => {
    if (ctx.goals.get(agent) === undefined) {
      ctx.goals.create(agent, {
        objective: 'Prove the composed goal survives in the session log',
        maxGoalRounds: 7,
      })
    }
    return next()
  })
}
