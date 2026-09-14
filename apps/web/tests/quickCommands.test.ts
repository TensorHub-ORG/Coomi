import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_QUICK_COMMAND_CONFIG,
  createQuickCommandSet,
  normalizeQuickCommandConfig,
  resetQuickCommandConfig,
} from '../src/utils/quickCommands.ts'

test('quick command configuration always exposes one active set with exactly four commands', () => {
  const config = normalizeQuickCommandConfig({
    activeSetId: 'broken',
    sets: [{ id: 'work', name: ' 工作 ', commands: [
      { id: 'one', icon: 'terminal', name: ' 一 ', content: ' run one ' },
      { id: 'two', icon: 'folder', name: '二', content: 'run two' },
    ] }],
  })
  assert.equal(config.activeSetId, 'work')
  assert.equal(config.sets[0].name, '工作')
  assert.equal(config.sets[0].commands.length, 4)
  assert.equal(config.sets[0].commands[0].content, 'run one')
  assert.ok(config.sets[0].commands.every(command => command.icon && command.name && command.content))
})

test('users can create multiple four-command sets and reset all sets to defaults', () => {
  const created = createQuickCommandSet(DEFAULT_QUICK_COMMAND_CONFIG, '开发工作')
  assert.equal(created.sets.length, 2)
  assert.equal(created.sets.at(-1)?.name, '开发工作')
  assert.equal(created.sets.at(-1)?.commands.length, 4)
  assert.notEqual(created.sets[0].commands[0].id, created.sets[1].commands[0].id)
  assert.deepEqual(resetQuickCommandConfig(), DEFAULT_QUICK_COMMAND_CONFIG)
})

test('idle screen and native start-home settings expose quick command management', () => {
  const empty = readFileSync(new URL('../src/components/EmptyState.vue', import.meta.url), 'utf8')
  const router = readFileSync(new URL('../src/router/index.ts', import.meta.url), 'utf8')
  const home = readFileSync(new URL('../../coomi-app/app/src/main/java/app/coomi/CoomiHomeSettingActivity.java', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../../coomi-app/app/src/main/java/com/termux/app/CoomiActivity.java', import.meta.url), 'utf8')
  assert.match(empty, /loadQuickCommandConfig/)
  assert.match(empty, /QUICK_COMMAND_CHANGED_EVENT/)
  assert.match(router, /quick-commands/)
  assert.match(home, /#\/quick-commands/)
  assert.match(home, /EXTRA_RETURN_TO_HOME_SETTINGS/)
  assert.match(host, /closeQuickCommandsEditor/)
  assert.match(host, /mSession\.navigateToRoot\(\)/)
})

test('native storage is authoritative so shortcut sets survive changing engine ports', () => {
  const utility = readFileSync(new URL('../src/utils/quickCommands.ts', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../../coomi-app/app/src/main/java/com/termux/app/CoomiChatSession.java', import.meta.url), 'utf8')
  assert.match(utility, /CoomiAndroid\?\.getQuickCommands/)
  assert.match(utility, /if \(!saved\) throw new Error/)
  assert.match(bridge, /public String getQuickCommands\(\)/)
  assert.match(bridge, /public boolean setQuickCommands\(String json\)/)
})
