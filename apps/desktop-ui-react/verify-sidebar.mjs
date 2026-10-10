import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { spawn } from 'node:child_process'

const DIST = new URL('./dist/', import.meta.url).pathname.replace(/^\//, '')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json' }
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    let p = join(DIST, decodeURIComponent(url.pathname))
    if (!existsSync(p) || url.pathname === '/') p = join(DIST, 'index.html')
    const body = await readFile(p)
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(body)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => server.listen(5202, '127.0.0.1', r))
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = new URL('./.cdp-profile4', import.meta.url).pathname.replace(/^\//, '')
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run','--remote-debugging-port=9366','--user-data-dir=' + profile,'--window-size=1600,1000','about:blank'], { stdio: 'ignore' })
let list = []
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:9366/json')).json(); if (list.some((t) => t.type === 'page')) break } catch {}
  await new Promise((r) => setTimeout(r, 500))
}
const page = list.find((t) => t.type === 'page')
if (!page) { console.log('NO_TARGET'); chrome.kill(); server.close(); process.exit(2) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const logs = []
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.consoleAPICalled' && ['error','warning'].includes(m.params.type)) logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0,150))
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + String(m.params.exceptionDetails?.exception?.description ?? '').slice(0,220))
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable', {})
await send('Page.enable', {})
await send('Page.navigate', { url: 'http://127.0.0.1:5202/' })
await new Promise((r) => setTimeout(r, 9000))
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0,200)
  return r.result?.result?.value
}

const readState = "(() => { const p = document.querySelector('[data-list-pane]'); const b = document.querySelector('[data-list-body]'); const t = document.querySelector('[data-list-toggle]'); return { paneW: p ? Math.round(p.getBoundingClientRect().width) : -1, bodyOpen: b ? b.getAttribute('data-open') : null, ariaExpanded: t ? t.getAttribute('aria-expanded') : null, bodyOpacity: b ? getComputedStyle(b).opacity : null } })()"

const out = {}
out.initial = await ev(readState)
out.afterCollapse = await ev("(async () => { const t = document.querySelector('[data-list-toggle]'); t.click(); await new Promise(r=>setTimeout(r,500)); return " + readState + " })()")
out.afterGoSkills = await ev("(async () => { document.querySelector('[data-nav-key=\"skills\"]').click(); await new Promise(r=>setTimeout(r,700)); return " + readState + " })()")
out.afterBackToChat = await ev("(async () => { document.querySelector('[data-nav-key=\"chat\"]').click(); await new Promise(r=>setTimeout(r,700)); return " + readState + " })()")
out.afterRoundTripTwice = await ev("(async () => { document.querySelector('[data-nav-key=\"settings\"]').click(); await new Promise(r=>setTimeout(r,600)); document.querySelector('[data-nav-key=\"chat\"]').click(); await new Promise(r=>setTimeout(r,600)); return " + readState + " })()")

const stable = out.afterCollapse.bodyOpen === out.afterBackToChat.bodyOpen && out.afterCollapse.bodyOpen === out.afterRoundTripTwice.bodyOpen
const collapsedHeld = out.afterBackToChat.bodyOpen === 'false' && out.afterRoundTripTwice.bodyOpen === 'false'
console.log('SIDEBAR=' + JSON.stringify(out, null, 2))
console.log('VERDICT collapsed_state_persists_across_pages=' + (stable && collapsedHeld))
console.log('LOGS=' + JSON.stringify(logs.slice(0, 8), null, 2))
try { chrome.kill() } catch {}
server.close()
process.exit(0)
