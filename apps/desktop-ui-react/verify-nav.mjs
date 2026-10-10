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
await new Promise((r) => server.listen(5201, '127.0.0.1', r))

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = new URL('./.cdp-profile3', import.meta.url).pathname.replace(/^\//, '')
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run','--remote-debugging-port=9355','--user-data-dir=' + profile,'--window-size=1600,1000','about:blank'], { stdio: 'ignore' })

let list = []
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:9355/json')).json(); if (list.some((t) => t.type === 'page')) break } catch {}
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
  if (m.method === 'Runtime.consoleAPICalled' && ['error','warning'].includes(m.params.type)) logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0,160))
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + String(m.params.exceptionDetails?.exception?.description ?? '').slice(0,240))
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable', {})
await send('Page.enable', {})
await send('Page.navigate', { url: 'http://127.0.0.1:5201/' })
await new Promise((r) => setTimeout(r, 9000))

const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0,220)
  return r.result?.result?.value
}

await ev("window.__lt=[]; try { new PerformanceObserver((l)=>{for(const e of l.getEntries()) window.__lt.push(Math.round(e.duration))}).observe({entryTypes:['longtask']}) } catch {} true")

const probeSrc = [
  'const btn = document.querySelector(\'[data-nav-key="\' + KEY + \'"]\')',
  'if (!btn) return { missing: true }',
  'window.__lt = []',
  'const t0 = performance.now()',
  'btn.click()',
  'await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
  'const t1 = performance.now()',
  'await new Promise((r) => setTimeout(r, 1000))',
  'const t2 = performance.now()',
  'return {',
  '  clickToPaintMs: Math.round((t1 - t0) * 10) / 10,',
  '  settledMs: Math.round((t2 - t0) * 10) / 10,',
  '  activePanes: document.querySelectorAll(\'[data-view-pane][data-view-state="active"]\').length,',
  '  mountedPanes: document.querySelectorAll(\'[data-view-pane]\').length,',
  '  longTasks: window.__lt.slice(),',
  '  longestTask: window.__lt.length ? Math.max.apply(null, window.__lt) : 0,',
  '  text: (document.body.innerText || \'\').replace(/\\s+/g, \' \').slice(0, 60),',
  '}',
].join('\n')

const keys = ['skills','artifacts','settings','chat']
const results = []
for (const k of keys) {
  const body = 'const KEY = ' + JSON.stringify(k) + ';\n' + 'return (async () => {' + probeSrc + '})()'
  const t = await ev('(async () => {' + body + '})()')
  t.key = k
  results.push(t)
}
console.log('NAV=' + JSON.stringify(results, null, 2))
console.log('LOGS=' + JSON.stringify(logs.slice(0, 10), null, 2))
try { chrome.kill() } catch {}
server.close()
process.exit(0)
