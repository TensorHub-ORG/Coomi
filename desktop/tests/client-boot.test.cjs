const assert = require('node:assert/strict')
const test = require('node:test')

const { ClientBootError, classifyClientBoot, waitForClientBoot } = require('../src/client-boot.cjs')

test('classifyClientBoot distinguishes the loading, failed, and ready surfaces', () => {
  assert.equal(classifyClientBoot({ hasContent: false, text: '' }), 'loading')
  assert.equal(classifyClientBoot({ hasContent: true, text: 'HARNESS\nLoading plugins…' }), 'loading')
  assert.equal(classifyClientBoot({ hasContent: true, text: 'Failed to load plugins' }), 'failed')
  assert.equal(classifyClientBoot({ hasContent: true, text: 'Coomi\n今天有什么工作？' }), 'ready')
})

test('waitForClientBoot waits for the real UI before resolving', async () => {
  const probes = [
    { hasContent: true, text: 'HARNESS\nLoading plugins…' },
    { hasContent: true, text: 'Coomi\n今天有什么工作？' },
  ]
  const webContents = {
    isDestroyed: () => false,
    executeJavaScript: async () => probes.shift(),
  }

  await waitForClientBoot(webContents, { timeoutMs: 100, pollIntervalMs: 0 })
  assert.equal(probes.length, 0)
})

test('waitForClientBoot reports a failed plugin graph without starting later work', async () => {
  const webContents = {
    isDestroyed: () => false,
    executeJavaScript: async () => ({
      hasContent: true,
      text: 'HARNESS\nFailed to load plugins\nweb boot: one entry did not activate',
    }),
  }

  await assert.rejects(
    waitForClientBoot(webContents, { timeoutMs: 100, pollIntervalMs: 0 }),
    (error) => error instanceof ClientBootError
      && /Coomi 前端插件启动失败.*one entry did not activate/.test(error.message),
  )
})
