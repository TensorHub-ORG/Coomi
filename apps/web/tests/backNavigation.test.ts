import test from 'node:test'
import assert from 'node:assert/strict'
import { BackNavigation, resolveBackTarget } from '../src/bridge/backNavigation.ts'

test('nested pages return to their parent even without browser history', () => {
  for (const [page, parent] of [
    ['/providers/new', '/providers'], ['/providers/deepseek', '/providers'],
    ['/studio/new', '/studio'], ['/studio/example/chat', '/studio'],
    ['/collab/new', '/collab'], ['/collab/example', '/collab'],
    ['/im/example', '/im'], ['/life/memory', '/life'],
    ['/appearance', '/settings'], ['/persona', '/settings'],
  ]) assert.equal(resolveBackTarget(page, 'dashboard'), parent)
})

test('session tools return to the entry source rather than the console', () => {
  const navigation = new BackNavigation()
  for (const page of ['/settings', '/studio', '/collab', '/files', '/tasks', '/browser', '/im']) {
    navigation.enter(page, '/')
    assert.equal(navigation.target(page), '/')
  }
})

test('studio editor returns to the same room for toolbar and system back', () => {
  const navigation = new BackNavigation()
  navigation.enter('/studio', '/')
  navigation.enter('/studio/example/chat', '/studio')
  navigation.enter('/studio/example/edit', '/studio/example/chat')
  assert.equal(navigation.target('/studio/example/edit'), '/studio/example/chat')
  navigation.prepareReturn('/studio/example/chat')
  navigation.enter('/studio/example/chat', '/studio/example/edit')
  assert.equal(navigation.target('/studio/example/chat'), '/studio')
  assert.equal(resolveBackTarget('/studio/example/edit'), '/studio/example/chat')
  assert.equal(resolveBackTarget('/studio/example/edit', '/studio'), '/studio')
})

test('returning through a child does not replace the parent entry source', () => {
  const navigation = new BackNavigation()
  navigation.enter('/settings', '/')
  navigation.enter('/git', '/settings')
  assert.equal(navigation.target('/git'), '/settings')
  navigation.prepareReturn('/settings')
  navigation.enter('/settings', '/git')
  assert.equal(navigation.target('/settings'), '/')
})

test('native console entry resets stale session origins', () => {
  const navigation = new BackNavigation()
  navigation.enter('/providers', '/')
  navigation.openNative('/providers')
  navigation.enter('/providers', '/settings')
  assert.equal(navigation.target('/providers'), 'dashboard')
  navigation.enter('/providers/new', '/providers')
  navigation.prepareReturn('/providers')
  navigation.enter('/providers', '/providers/new')
  assert.equal(navigation.target('/providers'), 'dashboard')
})

test('native quick command editor returns to the native home settings', () => {
  assert.equal(resolveBackTarget('/quick-commands?native=1', '/'), 'exit')
  assert.equal(resolveBackTarget('/quick-commands', '/settings'), '/settings')
})
