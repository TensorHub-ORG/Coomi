/**
 * Coomi Desktop — Electron main process.
 *
 * Shape: the Coomi host server runs as a child process (`coomi --profile web
 * --port <free>` on loopback). This process picks a free loopback port,
 * spawns the server with stdio detached (no pipes), and polls the URL until
 * the web UI answers before opening the BrowserWindow. On quit the child is
 * terminated; data lives under the app's userData home (`COOMI_HOME`),
 * isolated from any CLI installation.
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const { join } = require('node:path')
const { existsSync } = require('node:fs')

const APP_ID = 'com.coomi.desktop'
const PRODUCT = 'Coomi'
const STARTUP_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 500
const TITLE_BAR_HEIGHT = 38
const TITLE_BAR_CHANNEL = 'coomi-desktop:titlebar-theme'
const TITLE_BAR_DEFAULT = { color: '#FFFFFF', symbolColor: '#0F1115' }
const CSS_COLOR = /^(?:#[0-9a-f]{6}|rgba?\(\s*\d+(?:\.\d+)?(?:\s*,\s*|\s+)\d+(?:\.\d+)?(?:\s*,\s*|\s+)\d+(?:\.\d+)?(?:\s*(?:,|\/)\s*(?:\d+(?:\.\d+)?|\d+(?:\.\d+)?%))?\s*\))$/i

let mainWindow = null
let serverProcess = null
let serverPort = null
let quitting = false

/** Absolute path of the packaged/development server payload root. */
function serverRoot() {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'server')
  }
  // desktop/src/main.cjs -> repo root
  return join(__dirname, '..', '..')
}

/** Resolve the desktop window icon (ico on Windows, png elsewhere). */
function appIcon() {
  const base = app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'resources')
  const icon = process.platform === 'win32'
    ? join(base, 'resources', 'coomi.ico')
    : join(base, 'resources', 'coomi-agent.png')
  return existsSync(icon) ? icon : undefined
}

/** Ask the OS for a free loopback port. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

/** Poll the loopback URL until the web UI answers with a 200. */
async function waitForWeb(url, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (quitting) throw new Error('Shutdown requested while waiting for the web server.')
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for the Coomi web server at ${url}.`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/** Spawn the Coomi host server on a free port and resolve its loopback URL. */
async function startServer() {
  const root = serverRoot()
  const cliEntry = join(root, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(cliEntry)) {
    throw new Error(`Coomi server entry not found: ${cliEntry}. Build the repo first (pnpm run build).`)
  }
  const port = await findFreePort()
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1', // reuse Electron's bundled Node runtime
    COOMI_HOME: join(app.getPath('userData'), 'home'),
  }
  serverPort = port
  serverProcess = spawn(
    process.execPath,
    [cliEntry, '--profile', 'web', '--port', String(port), '--host', '127.0.0.1'],
    {
      cwd: root,
      env,
      stdio: ['ignore', logFd(), logFd()],
    },
  )
  serverProcess.on('error', (error) => {
    if (!quitting) throw error // surfaced by the await below in most paths
  })
  const url = `http://127.0.0.1:${port}`
  await waitForWeb(url)
  return url
}

/** Server stdout/stderr go to a rotating log under userData/logs. */
function logFd() {
  const { openSync, mkdirSync } = require('node:fs')
  const logsDir = join(app.getPath('userData'), 'logs')
  try { mkdirSync(logsDir, { recursive: true }) } catch { /* best effort */ }
  return openSync(join(logsDir, 'server.log'), 'a')
}

function stopServer() {
  if (!serverProcess) return
  quitting = true
  try { serverProcess.kill() } catch { /* already gone */ }
  // Force-kill fallback once the graceful window passes.
  setTimeout(() => {
    try { serverProcess.kill('SIGKILL') } catch { /* already gone */ }
  }, 5000)
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true,
    icon: appIcon(),
    title: PRODUCT,
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { ...TITLE_BAR_DEFAULT, height: TITLE_BAR_HEIGHT },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    const icon = appIcon()
    if (icon) mainWindow?.setIcon(icon)
    mainWindow?.show()
  })
  mainWindow.on('closed', () => { mainWindow = null })

  // Keep navigation inside the app; open external targets in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const origin = new URL(url).origin
    if (!origin.startsWith('http://127.0.0.1') && !origin.startsWith('http://localhost')) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.loadURL(url)
}

ipcMain.on(TITLE_BAR_CHANNEL, (event, theme) => {
  if (process.platform !== 'win32' || event.sender !== mainWindow?.webContents) return
  const color = theme?.color
  const symbolColor = theme?.symbolColor
  if (typeof color !== 'string' || typeof symbolColor !== 'string'
    || !CSS_COLOR.test(color) || !CSS_COLOR.test(symbolColor)) return
  mainWindow.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT })
})

/** Surface a fatal startup error in a native dialog. */
function dialogError(error) {
  try {
    dialog.showErrorBox(`${PRODUCT} failed to start`, String(error?.message ?? error))
  } catch { /* dialog unavailable; console already has the error */ }
}

// ---- app lifecycle -------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    Menu.setApplicationMenu(null)
    try {
      const url = await startServer()
      createWindow(url)
    } catch (error) {
      console.error('[coomi-desktop] failed to start:', error)
      dialogError(error)
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    stopServer()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    stopServer()
  })

  app.on('activate', () => {
    if (mainWindow === null) {
      // macOS dock reactivation after server teardown: restart the server.
      startServer().then(createWindow).catch(() => app.quit())
    }
  })
}
