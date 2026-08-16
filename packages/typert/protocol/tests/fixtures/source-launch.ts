import { Context } from '@coomi/cordis'
import {
  TypertRemoteService,
  Remote,
  RemoteScope,
  remoteMethods,
} from '@coomi/coomi-typert-protocol'

class Goals extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @Remote
  create(value: string): string {
    return value
  }

  @RemoteScope('agent')
  scoped(value: string): string {
    return value
  }
}

const methods = remoteMethods(new Goals(new Context()))
const actual = JSON.stringify(methods)
const expected = JSON.stringify([
  { method: 'create', invocation: { kind: 'direct' } },
  { method: 'scoped', invocation: { kind: 'context', context: 'agent' } },
])
if (actual !== expected) throw new Error(`unexpected Remote declarations: ${actual}`)
process.stdout.write(actual)
