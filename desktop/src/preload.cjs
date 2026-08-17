/**
 * Coomi Desktop — preload bridge.
 *
 * Minimal surface today: runtime versions plus platform facts. The renderer
 * talks to the host over the same HTTP/WebSocket transport the browser shape
 * uses (the window loads the Coomi web server's loopback URL), so no RPC
 * bridge is required for the current shape.
 */

const { contextBridge, ipcRenderer } = require('electron')

const TITLE_BAR_HEIGHT = 38
const TITLE_BAR_CHANNEL = 'coomi-desktop:titlebar-theme'

function installTitleBar() {
  document.documentElement.classList.add('coomi-desktop')
  document.documentElement.style.setProperty('--coomi-desktop-title-bar-height', `${TITLE_BAR_HEIGHT}px`)
  const style = document.createElement('style')
  style.textContent = `
    body {
      box-sizing: border-box;
      padding-top: ${TITLE_BAR_HEIGHT}px;
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0 0 auto;
      z-index: 30;
      height: ${TITLE_BAR_HEIGHT}px;
      box-sizing: border-box;
      background: var(--coomi-alias-bg-base, #fff);
      border-bottom: 1px solid var(--coomi-alias-border-l1, rgba(15, 17, 21, 0.08));
      -webkit-app-region: drag;
    }
  `
  document.head.append(style)

  const syncTheme = () => {
    const computed = getComputedStyle(document.body)
    const dialog = document.querySelector('[aria-modal="true"]')
    const mask = dialog?.parentElement?.querySelector('[aria-hidden="true"]')
    ipcRenderer.send(TITLE_BAR_CHANNEL, {
      color: mask instanceof HTMLElement ? getComputedStyle(mask).backgroundColor : computed.backgroundColor,
      symbolColor: computed.color,
    })
  }
  const observer = new MutationObserver(syncTheme)
  observer.observe(document.head, { childList: true, subtree: true, attributes: true })
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-coomi-dark-theme'],
  })
  const dialogObserver = new MutationObserver(syncTheme)
  dialogObserver.observe(document.body, { childList: true, subtree: true })
  syncTheme()
}

window.addEventListener('DOMContentLoaded', installTitleBar, { once: true })

contextBridge.exposeInMainWorld('coomiDesktop', {
  product: 'Coomi',
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  platform: process.platform,
  titleBarHeight: TITLE_BAR_HEIGHT,
})
