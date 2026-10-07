import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createQuickCommandSet, normalizeQuickCommandConfig, resetQuickCommandConfig,
  loadQuickCommandConfig, saveQuickCommandConfig,
} from '../src/utils/quickCommands.ts'

test('quick command plans always contain four commands with valid icons', () => {
  const config = normalizeQuickCommandConfig({ activeSetId: 'missing', sets: [{ id: 'work', commands: [{ icon: 'unknown', name: '任务', content: '完成任务' }] }] })
  assert.equal(config.activeSetId, 'work')
  assert.equal(config.sets[0].commands.length, 4)
  assert.equal(config.sets[0].commands[0].icon, 'phone')
  assert.equal(config.sets[0].commands[0].content, '完成任务')
})

test('new plans clone the selected commands without changing the defaults', () => {
  const initial = resetQuickCommandConfig()
  const next = createQuickCommandSet(initial, '开发工作')
  assert.equal(next.sets.length, 2)
  assert.equal(next.activeSetId, next.sets[1].id)
  assert.notEqual(next.sets[1].commands[0].id, next.sets[0].commands[0].id)
  next.sets[1].commands[0].content = '写代码'
  assert.notEqual(next.sets[0].commands[0].content, '写代码')
  assert.notEqual(resetQuickCommandConfig().sets[0].commands[0].content, '写代码')
})

test('native persistence remains authoritative across WebView origins', () => {
  const globals = globalThis as unknown as Record<string, unknown>
  const oldWindow = globals.window
  const oldStorage = globals.localStorage
  let nativeConfig = ''
  let cachedConfig = ''
  globals.window = { CoomiAndroid: {
    getQuickCommands: () => nativeConfig,
    setQuickCommands: (value: string) => { nativeConfig = value; return true },
  }, dispatchEvent: () => true }
  globals.localStorage = {
    getItem: () => cachedConfig,
    setItem: (_key: string, value: string) => { cachedConfig = value },
  }
  try {
    const config = resetQuickCommandConfig()
    config.sets[0].commands[0].name = '跨端口配置'
    saveQuickCommandConfig(config)
    cachedConfig = ''
    assert.equal(loadQuickCommandConfig().sets[0].commands[0].name, '跨端口配置')
  } finally {
    if (oldWindow === undefined) delete globals.window
    else globals.window = oldWindow
    if (oldStorage === undefined) delete globals.localStorage
    else globals.localStorage = oldStorage
  }
})
