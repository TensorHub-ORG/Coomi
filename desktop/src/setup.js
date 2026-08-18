const statusRoot = document.querySelector('.runtime-status')
const statusMessage = document.getElementById('statusMessage')
const sourcePath = document.getElementById('sourcePath')
const selectButton = document.getElementById('selectButton')
const installButton = document.getElementById('installButton')
const retryButton = document.getElementById('retryButton')
const progressPanel = document.getElementById('progressPanel')
const progressLabel = document.getElementById('progressLabel')
const progressLog = document.getElementById('progressLog')

function render(state) {
  statusRoot.dataset.phase = state.phase
  statusRoot.dataset.busy = String(state.busy)
  statusMessage.textContent = state.message
  sourcePath.textContent = state.sourceRoot || ''
  selectButton.disabled = state.busy
  installButton.disabled = state.busy
  retryButton.disabled = state.busy
  retryButton.hidden = state.phase !== 'error' || !state.sourceRoot
  progressPanel.hidden = !state.busy && state.logs.length === 0
  progressLabel.textContent = state.phase === 'clone' ? '正在下载源码' : '正在准备源码'
  progressLog.textContent = state.logs.join('\n')
  progressLog.scrollTop = progressLog.scrollHeight
}

selectButton.addEventListener('click', () => window.coomiDesktop.setup.selectExisting())
installButton.addEventListener('click', () => window.coomiDesktop.setup.installOfficial())
retryButton.addEventListener('click', () => window.coomiDesktop.setup.retry())

window.coomiDesktop.setup.onState(render)
window.coomiDesktop.setup.getState().then(render)
