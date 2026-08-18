/** Desktop-side readiness probe for the browser plugin boot. */

const CLIENT_BOOT_TIMEOUT_MS = 45_000
const CLIENT_BOOT_POLL_INTERVAL_MS = 100

const CLIENT_BOOT_PROBE = `(() => {
  const root = document.getElementById('root')
  return {
    hasContent: Boolean(root?.childElementCount),
    text: root?.innerText ?? '',
  }
})()`

class ClientBootError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ClientBootError'
  }
}

/** Classify the shell-owned loading surface without depending on hashed CSS classes. */
function classifyClientBoot({ hasContent, text }) {
  if (text.includes('Failed to load plugins')) return 'failed'
  if (!hasContent || text.includes('Loading plugins')) return 'loading'
  return 'ready'
}

/**
 * Wait until the plugin boot has replaced its loading surface with the real UI.
 * @param {Electron.WebContents} webContents - Loaded Coomi page.
 * @param {{ timeoutMs?: number, pollIntervalMs?: number }} [options] - Probe timing overrides.
 */
async function waitForClientBoot(webContents, options = {}) {
  const timeoutMs = options.timeoutMs ?? CLIENT_BOOT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? CLIENT_BOOT_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (webContents.isDestroyed()) throw new Error('Coomi 页面在插件启动完成前已关闭。')
    const probe = await webContents.executeJavaScript(CLIENT_BOOT_PROBE, true)
    const state = classifyClientBoot(probe)
    if (state === 'ready') return
    if (state === 'failed') {
      const detail = String(probe.text).replace(/\s+/g, ' ').trim().slice(0, 800)
      throw new ClientBootError(`Coomi 前端插件启动失败：${detail}`)
    }
    if (Date.now() >= deadline) throw new Error('等待 Coomi 前端插件启动超时。')
    await new Promise(resolveDelay => setTimeout(resolveDelay, pollIntervalMs))
  }
}

module.exports = { ClientBootError, classifyClientBoot, waitForClientBoot }
