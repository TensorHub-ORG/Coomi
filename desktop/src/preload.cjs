/**
 * Coomi Desktop — preload bridge.
 *
 * Minimal surface today: runtime versions plus platform facts. The renderer
 * talks to the host over the same HTTP/WebSocket transport the browser shape
 * uses (the window loads the Coomi web server's loopback URL), so no RPC
 * bridge is required for the current shape.
 */

const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('coomiDesktop', {
  product: 'Coomi',
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  platform: process.platform,
})
