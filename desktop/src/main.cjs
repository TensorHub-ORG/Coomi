/**
 * Coomi Desktop starts an editable external source checkout and keeps product
 * data under the desktop Harness home. The shell owns setup, process lifetime,
 * source checkpoints, and recovery; Harness code never ships inside the app.
 */

const { spawn } = require('node:child_process')
const { closeSync, existsSync, mkdirSync, openSync } = require('node:fs')
const { once } = require('node:events')
const { delimiter, dirname, join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, shell,
} = require('electron')
const {
  OFFICIAL_BRANCH,
  OFFICIAL_REPOSITORY,
  captureBaseCommit,
  cloneOfficialSource,
  createDiffCheckpoint,
  inspectSourceRoot,
  prepareSource,
  readRuntimeConfig,
  readSourceStatus,
  runCommand,
  scrubEnvironment,
  writeRuntimeConfig,
} = require('./runtime-source.cjs')
const { ClientBootError, waitForClientBoot } = require('./client-boot.cjs')

const APP_ID = 'com.coomi.desktop'
const PRODUCT = 'Coomi'
const STARTUP_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 500
const TITLE_BAR_HEIGHT = 38
const TITLE_BAR_CHANNEL = 'coomi-desktop:titlebar-theme'
const TITLE_BAR_DEFAULT = { color: '#FFFFFF', symbolColor: '#0F1115' }
const CSS_COLOR = /^(?:#[0-9a-f]{6}|rgba?\(\s*\d+(?:\.\d+)?(?:\s*,\s*|\s+)\d+(?:\.\d+)?(?:\s*,\s*|\s+)\d+(?:\.\d+)?(?:\s*(?:,|\/)\s*(?:\d+(?:\.\d+)?|\d+(?:\.\d+)?%))?\s*\))$/i
const RUNTIME_CONFIG_FILENAME = 'desktop-runtime.json'
const SETUP_STATE_CHANNEL = 'coomi-desktop:setup-state'
const CLIENT_BOOT_RETRY_DELAYS_MS = [0, 1500, 3000]

let mainWindow = null
let tray = null
let serverProcess = null
let clientWatcherProcess = null
let serverPort = null
let runtimeConfig = null
let appQuitting = false
let shutdownStarted = false
let runtimeOperation = Promise.resolve()
let setupState = {
  busy: false,
  phase: 'select',
  sourceRoot: '',
  message: '选择已有源码，或把官方源码安装到自定义位置。',
  logs: [],
}

function runtimeConfigPath() {
  return join(app.getPath('userData'), RUNTIME_CONFIG_FILENAME)
}

function harnessHome() {
  return join(app.getPath('userData'), 'home')
}

function changesRoot() {
  return join(app.getPath('userData'), 'changes')
}

function defaultSourceParent() {
  return join(process.env.LOCALAPPDATA || app.getPath('userData'), PRODUCT)
}

function appIcon() {
  const base = join(__dirname, '..', 'resources')
  const icon = process.platform === 'win32'
    ? join(base, 'coomi.ico')
    : join(base, 'coomi-agent.png')
  return existsSync(icon) ? icon : undefined
}

function findFreePort() {
  const { createServer } = require('node:net')
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.once('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolvePort(port))
    })
  })
}

async function waitForWeb(url, process, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (appQuitting) throw new Error('应用退出时取消了源码运行时启动。')
    if (process.exitCode !== null) {
      throw new Error(`源码运行时在网页就绪前退出，退出码 ${String(process.exitCode)}。`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return
    } catch {
      // A connection refusal is expected while the source runtime starts.
    }
    if (Date.now() > deadline) throw new Error(`等待源码运行时超时：${url}`)
    await new Promise(resolveDelay => setTimeout(resolveDelay, POLL_INTERVAL_MS))
  }
}

function logPath() {
  const logsDirectory = join(app.getPath('userData'), 'logs')
  mkdirSync(logsDirectory, { recursive: true })
  return join(logsDirectory, 'server.log')
}

function spawnLogged(executable, args, options) {
  const output = openSync(logPath(), 'a')
  try {
    return spawn(executable, args, {
      ...options,
      windowsHide: true,
      stdio: ['ignore', output, output],
    })
  } finally {
    closeSync(output)
  }
}

function sourceLaunchArgs(root, extraArgs = []) {
  const tsxHook = pathToFileURL(join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href
  return [
    '--import', tsxHook,
    join(root, 'apps', 'cli', 'src', 'bin.ts'),
    '--profile', 'web',
    ...extraArgs,
  ]
}

function runtimeEnvironment() {
  return {
    ...scrubEnvironment(),
    PATH: `${dirname(nodeExecutable())}${delimiter}${scrubEnvironment().PATH ?? ''}`,
    COOMI_HOME: harnessHome(),
    COOMI_DESKTOP_SOURCE_ROOT: runtimeConfig.sourceRoot,
  }
}

async function startClientWatcher() {
  if (clientWatcherProcess || !runtimeConfig) return
  const root = runtimeConfig.sourceRoot
  const tsxHook = pathToFileURL(join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href
  clientWatcherProcess = spawnLogged(nodeExecutable(), [
    '--import', tsxHook,
    join(root, 'scripts', 'dev-web.ts'),
    '--poll',
  ], { cwd: root, env: runtimeEnvironment() })
  const owned = clientWatcherProcess
  owned.once('exit', () => {
    if (clientWatcherProcess === owned) clientWatcherProcess = null
  })
}

async function startServer() {
  if (!runtimeConfig) throw new Error('尚未选择 Coomi 源码目录。')
  const inspection = await inspectSourceRoot(runtimeConfig.sourceRoot)
  if (!inspection.ok) throw new Error(inspection.error)
  if (!inspection.prepared) {
    throw new Error(`源码尚未准备完成：缺少 ${inspection.missingPrepared.join('、')}`)
  }
  const port = await findFreePort()
  serverPort = port
  const root = inspection.root
  const child = spawnLogged(nodeExecutable(), sourceLaunchArgs(root, [
    '--port', String(port), '--host', '127.0.0.1',
  ]), { cwd: root, env: runtimeEnvironment() })
  serverProcess = child
  child.once('error', error => {
    if (!appQuitting) showNotification('源码运行时错误', error.message)
  })
  child.once('exit', (code) => {
    if (serverProcess === child) serverProcess = null
    if (!appQuitting && code !== 0) {
      showNotification('源码运行时已停止', `退出码 ${String(code)}，可从托盘重新启动。`)
    }
  })
  const url = `http://127.0.0.1:${port}`
  try {
    await waitForWeb(url, child)
  } catch (error) {
    await stopChildProcess(child)
    throw error
  }
  return url
}

async function loadRuntimeUrl(url) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  for (let attempt = 0; attempt < CLIENT_BOOT_RETRY_DELAYS_MS.length; attempt += 1) {
    const retryDelay = CLIENT_BOOT_RETRY_DELAYS_MS[attempt]
    if (retryDelay > 0) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, retryDelay))
    }
    const target = new URL(url)
    if (attempt > 0) target.searchParams.set('coomi-desktop-retry', String(attempt))
    await mainWindow.loadURL(target.href)
    try {
      await waitForClientBoot(mainWindow.webContents)
      break
    } catch (error) {
      const finalAttempt = attempt === CLIENT_BOOT_RETRY_DELAYS_MS.length - 1
      if (!(error instanceof ClientBootError) || finalAttempt) throw error
    }
  }
  await startClientWatcher()
  mainWindow.show()
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise(resolveTimeout => setTimeout(() => resolveTimeout(false), 5000)),
  ])
  if (exited) return
  if (process.platform === 'win32' && child.pid) {
    try {
      await runCommand('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    } catch {
      // The process may exit between the timeout and taskkill.
    }
    if (child.exitCode === null) await once(child, 'exit').catch(() => {})
    return
  }
  child.kill('SIGKILL')
  if (child.exitCode === null) await once(child, 'exit').catch(() => {})
}

async function stopRuntime({ includeWatcher = false } = {}) {
  const ownedServer = serverProcess
  serverProcess = null
  serverPort = null
  await stopChildProcess(ownedServer)
  if (includeWatcher) {
    const ownedWatcher = clientWatcherProcess
    clientWatcherProcess = null
    await stopChildProcess(ownedWatcher)
  }
}

function queueRuntimeOperation(operation) {
  runtimeOperation = runtimeOperation.then(operation, operation)
  return runtimeOperation
}

async function restartRuntime() {
  return queueRuntimeOperation(async () => {
    if (!runtimeConfig) return showSetup('请选择 Coomi 源码目录。')
    await stopRuntime()
    try {
      const url = await startServer()
      await loadRuntimeUrl(url)
      showNotification('源码运行时已重启', runtimeConfig.sourceRoot)
    } catch (error) {
      showSetup(error.message)
    }
  })
}

function createWindow(options = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  mainWindow = new BrowserWindow({
    width: options.width ?? 1280,
    height: options.height ?? 820,
    minWidth: options.minWidth ?? 760,
    minHeight: options.minHeight ?? 560,
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
  })
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const origin = new URL(url).origin
    if (!origin.startsWith('http://127.0.0.1') && !origin.startsWith('http://localhost')) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  return mainWindow
}

function publishSetupState(update = {}) {
  setupState = { ...setupState, ...update }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(SETUP_STATE_CHANNEL, setupState)
  }
}

function appendSetupOutput(text) {
  const additions = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (additions.length === 0) return
  publishSetupState({ logs: [...setupState.logs, ...additions].slice(-80) })
}

async function showSetup(message = setupState.message) {
  const window = createWindow({ width: 820, height: 680, minWidth: 720, minHeight: 560 })
  publishSetupState({ busy: false, phase: 'select', message })
  await window.loadFile(join(__dirname, 'setup.html'))
  window.show()
}

async function selectDirectory(title, defaultPath) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : result.filePaths[0] ?? null
}

function pnpmEntry() {
  return packagedDependencyPath('pnpm', 'bin', 'pnpm.cjs')
}

function nodeExecutable() {
  return packagedDependencyPath('node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
}

function packagedDependencyPath(...segments) {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', ...segments)
    : join(__dirname, '..', 'node_modules', ...segments)
}

async function configureSource(root, { prepare = true } = {}) {
  const inspection = await inspectSourceRoot(root)
  if (!inspection.ok) throw new Error(inspection.error)
  const reusingBase = runtimeConfig
    && resolve(runtimeConfig.sourceRoot) === resolve(inspection.root)
  const baseCommit = reusingBase
    ? runtimeConfig.baseCommit
    : await captureBaseCommit(inspection.root)
  const nextConfig = {
    sourceRoot: inspection.root,
    baseCommit,
    repository: reusingBase ? runtimeConfig.repository : OFFICIAL_REPOSITORY,
    branch: reusingBase ? runtimeConfig.branch : OFFICIAL_BRANCH,
  }
  await writeRuntimeConfig(runtimeConfigPath(), nextConfig)
  if (prepare && !inspection.prepared) {
    publishSetupState({
      busy: true,
      phase: 'prepare',
      sourceRoot: inspection.root,
      message: '正在安装依赖并构建源码…',
      logs: [],
    })
    await prepareSource(inspection.root, pnpmEntry(), nodeExecutable(), {
      onOutput: appendSetupOutput,
    })
  }
  const ready = await inspectSourceRoot(inspection.root)
  if (!ready.ok || !ready.prepared) throw new Error(ready.error || '源码准备没有生成所需产物。')
  const previousRoot = runtimeConfig?.sourceRoot
  await stopRuntime({
    includeWatcher: Boolean(previousRoot)
      && resolve(previousRoot) !== resolve(nextConfig.sourceRoot),
  })
  runtimeConfig = nextConfig
  try {
    const url = await startServer()
    await loadRuntimeUrl(url)
  } catch (error) {
    await stopRuntime()
    throw error
  }
  publishSetupState({ busy: false, phase: 'ready', message: '源码运行时已启动。' })
  rebuildTrayMenu()
}

async function chooseExistingSource() {
  if (setupState.busy) return
  const selected = await selectDirectory('选择 Coomi 源码目录', runtimeConfig?.sourceRoot || defaultSourceParent())
  if (!selected) return
  publishSetupState({ busy: true, sourceRoot: selected, message: '正在检查源码…', logs: [] })
  try {
    await configureSource(selected)
  } catch (error) {
    publishSetupState({ busy: false, phase: 'error', message: error.message })
  }
}

async function installOfficialSource() {
  if (setupState.busy) return
  const destination = await selectDirectory('选择官方源码安装位置', defaultSourceParent())
  if (!destination) return
  publishSetupState({
    busy: true,
    phase: 'clone',
    sourceRoot: destination,
    message: '正在下载官方源码…',
    logs: [],
  })
  try {
    const root = await cloneOfficialSource(destination, { onOutput: appendSetupOutput })
    await configureSource(root)
  } catch (error) {
    publishSetupState({ busy: false, phase: 'error', message: error.message })
  }
}

async function resumeConfiguredSource() {
  const sourceRoot = setupState.sourceRoot || runtimeConfig?.sourceRoot
  if (!sourceRoot) return showSetup()
  publishSetupState({ busy: true, sourceRoot, message: '正在检查源码…' })
  try {
    await configureSource(sourceRoot)
  } catch (error) {
    publishSetupState({ busy: false, phase: 'error', message: error.message })
    await showSetup(error.message)
  }
}

async function changeSourceFromTray() {
  const selected = await selectDirectory('切换 Coomi 源码目录', runtimeConfig?.sourceRoot || defaultSourceParent())
  if (!selected || resolve(selected) === resolve(runtimeConfig?.sourceRoot || '')) return
  try {
    await configureSource(selected)
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '无法切换源码',
      message: error.message,
    })
  }
}

async function saveSourceCheckpoint() {
  if (!runtimeConfig) return
  try {
    const checkpoint = await createDiffCheckpoint(
      runtimeConfig.sourceRoot,
      runtimeConfig.baseCommit,
      changesRoot(),
    )
    if (!checkpoint) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '源码修改记录',
        message: '源码与基础版本一致，没有需要记录的修改。',
      })
      return
    }
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '源码修改已记录',
      message: checkpoint.summary || '已生成完整 diff。',
      detail: checkpoint.directory,
      buttons: ['确定', '打开目录'],
      defaultId: 0,
    }).then(result => {
      if (result.response === 1) void shell.openPath(checkpoint.directory)
    })
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error', title: '无法记录源码修改', message: error.message,
    })
  }
}

function showNotification(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: appIcon() }).show()
}

function rebuildTrayMenu() {
  if (!tray) return
  const sourceSelected = Boolean(runtimeConfig)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Coomi', click: () => mainWindow?.show() },
    { type: 'separator' },
    {
      label: '打开源码目录',
      enabled: sourceSelected,
      click: () => { if (runtimeConfig) void shell.openPath(runtimeConfig.sourceRoot) },
    },
    {
      label: '保存源码修改记录',
      enabled: sourceSelected,
      click: () => { void saveSourceCheckpoint() },
    },
    {
      label: '重启源码运行时',
      enabled: sourceSelected,
      click: () => { void restartRuntime() },
    },
    {
      label: '切换源码目录',
      click: () => { void changeSourceFromTray() },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  void updateTrayTooltip()
}

async function updateTrayTooltip() {
  if (!tray) return
  if (!runtimeConfig) return tray.setToolTip(`${PRODUCT} · 未选择源码`)
  try {
    const status = await readSourceStatus(runtimeConfig.sourceRoot)
    tray.setToolTip(`${PRODUCT} · ${String(status.count)} 个源码修改`)
  } catch {
    tray.setToolTip(`${PRODUCT} · 源码状态不可用`)
  }
}

function createTray() {
  const icon = appIcon()
  if (!icon) return
  tray = new Tray(icon)
  tray.on('double-click', () => mainWindow?.show())
  rebuildTrayMenu()
}

function registerIpc() {
  ipcMain.on(TITLE_BAR_CHANNEL, (event, theme) => {
    if (process.platform !== 'win32' || event.sender !== mainWindow?.webContents) return
    const color = theme?.color
    const symbolColor = theme?.symbolColor
    if (
      typeof color !== 'string' || typeof symbolColor !== 'string'
      || !CSS_COLOR.test(color) || !CSS_COLOR.test(symbolColor)
    ) return
    mainWindow.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT })
  })
  ipcMain.handle('coomi-desktop:setup-get-state', () => setupState)
  ipcMain.handle('coomi-desktop:setup-select-existing', chooseExistingSource)
  ipcMain.handle('coomi-desktop:setup-install-official', installOfficialSource)
  ipcMain.handle('coomi-desktop:setup-retry', resumeConfiguredSource)
  ipcMain.handle('coomi-desktop:source-open', () => (
    runtimeConfig ? shell.openPath(runtimeConfig.sourceRoot) : undefined
  ))
  ipcMain.handle('coomi-desktop:source-checkpoint', saveSourceCheckpoint)
  ipcMain.handle('coomi-desktop:source-restart', restartRuntime)
}

async function boot() {
  const configured = await readRuntimeConfig(runtimeConfigPath())
  if (process.env.COOMI_SOURCE_ROOT) {
    const sourceRoot = resolve(process.env.COOMI_SOURCE_ROOT)
    runtimeConfig = {
      sourceRoot,
      baseCommit: await captureBaseCommit(sourceRoot),
      repository: OFFICIAL_REPOSITORY,
      branch: OFFICIAL_BRANCH,
    }
  } else {
    runtimeConfig = configured
  }
  if (!runtimeConfig) return showSetup()
  setupState.sourceRoot = runtimeConfig.sourceRoot
  try {
    const inspection = await inspectSourceRoot(runtimeConfig.sourceRoot)
    if (!inspection.ok || !inspection.prepared) return showSetup(inspection.error || '源码需要准备后才能启动。')
    const url = await startServer()
    createWindow()
    await loadRuntimeUrl(url)
  } catch (error) {
    await stopRuntime()
    await showSetup(error.message)
  }
}

async function shutdown() {
  if (shutdownStarted) return
  shutdownStarted = true
  appQuitting = true
  tray?.destroy()
  tray = null
  await stopRuntime({ includeWatcher: true })
  app.exit(0)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    Menu.setApplicationMenu(null)
    registerIpc()
    createTray()
    try {
      await boot()
      rebuildTrayMenu()
    } catch (error) {
      await showSetup(error.message)
    }
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', event => {
    if (shutdownStarted) return
    event.preventDefault()
    void shutdown()
  })
  app.on('activate', () => {
    if (!mainWindow) void boot()
  })
}
