import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@coomi/cordis'
import Loader from '@coomi/cordis-plugin-loader'
import Include from '@coomi/cordis-plugin-include'
import { CallId } from '@coomi/coomi-llm'
import { Session, SessionId } from '@coomi/coomi-session'
import AgentRegistry, { Inbox } from '@coomi/coomi-agent'
import type { Agent } from '@coomi/coomi-agent'
import SystemPrompt from '@coomi/coomi-system-prompt'
import ToolRuntime from '@coomi/coomi-tools'
import TerminalSessionService from '@coomi/coomi-terminal'
import SandboxProvider from '@coomi/coomi-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@coomi/coomi-sandbox'
import SandboxPolicyService from '@coomi/coomi-sandbox-policy'
import LocalSubprocessRuntime from '@coomi/coomi-subprocess-local'
import * as TerminalLocal from '@coomi/coomi-terminal-bash'
import * as ToolPty from '@coomi/coomi-tool-terminal'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class PassthroughSandbox extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('pty-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const suite = process.platform === 'linux' || process.platform === 'darwin' ? describe : describe.skip

suite('terminal real Loader composition through cordis.yml', () => {
  it('boots cordis.yml and preserves shell state across real tool calls', async () => {
    root = await mkdtemp(join(tmpdir(), 'coomi-pty-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@coomi/coomi-agent'",
      "- name: '@coomi/coomi-system-prompt'",
      "- name: '@coomi/coomi-tools'",
      "- name: '@coomi/coomi-terminal'",
      "- name: '@coomi/coomi-test-sandbox'",
      "- name: '@coomi/coomi-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "- name: '@coomi/coomi-subprocess-local'",
      "- name: '@coomi/coomi-terminal-bash'",
      '  config:',
      '    pollIntervalMs: 10',
      '    exactProbeAfterMs: 20',
      '    idleSilenceMs: 250',
      '    handoffGraceMs: 250',
      '    timeoutMs: 2000',
      '    disposeGraceMs: 500',
      "- name: '@coomi/coomi-tool-terminal'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@coomi/coomi-agent', AgentRegistry],
      ['@coomi/coomi-system-prompt', SystemPrompt],
      ['@coomi/coomi-tools', ToolRuntime],
      ['@coomi/coomi-terminal', TerminalSessionService],
      ['@coomi/coomi-test-sandbox', PassthroughSandbox],
      ['@coomi/coomi-sandbox-policy', SandboxPolicyService],
      ['@coomi/coomi-subprocess-local', LocalSubprocessRuntime],
      ['@coomi/coomi-terminal-bash', TerminalLocal],
      ['@coomi/coomi-tool-terminal', ToolPty],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = agent(context)
    const signal = new AbortController().signal
    const spawn = await context.tools.execute({
      signal, callId: CallId('spawn'), name: 'terminal_open', arguments: { type: 'shell', name: 'main', cwd: root }, agent: owner,
    })
    expect(resultText(spawn)).toContain('started terminal session pty-1 (main)')

    await context.tools.execute({
      signal, callId: CallId('state'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'export KEEP=loader; cd /' }, agent: owner,
    })
    const read = await context.tools.execute({
      signal, callId: CallId('read'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'printf "cwd=%s keep=%s\\n" "$PWD" "$KEEP"' }, agent: owner,
    })
    expect(resultText(read)).toContain('cwd=/ keep=loader')
    expect(context.terminals.list(owner)).toHaveLength(1)
  }, 15_000)
})
