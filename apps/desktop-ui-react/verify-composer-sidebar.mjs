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
await new Promise((r) => server.listen(5203, '127.0.0.1', r))
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = new URL('./.cdp-p5', import.meta.url).pathname.replace(/^\//, '')
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run','--remote-debugging-port=9377','--user-data-dir=' + profile,'--window-size=1600,1000','about:blank'], { stdio: 'ignore' })
let list = []
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:9377/json')).json(); if (list.some((t) => t.type === 'page')) break } catch {}
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
await send('Page.navigate', { url: 'http://127.0.0.1:5203/' })
await new Promise((r) => setTimeout(r, 9000))
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0,200)
  return r.result?.result?.value
}

// 1. Composer stability: tag the node, switch pages, verify the SAME node survives and draft is kept.
await ev("(() => { const c = document.querySelector('.workbench-composer'); if (c) c.setAttribute('data-probe-id','composer-1'); const ta = document.querySelector('[data-chat-col] textarea'); if (ta) { ta.focus(); } return true })()")

const before = await ev("(() => { const c=document.querySelector('.workbench-composer'); const ta=document.querySelector('[data-chat-col] textarea'); return { composerExists: !!c, probe: c?c.getAttribute('data-probe-id'):null, taExists: !!ta, taH: ta?Math.round(ta.getBoundingClientRect().height):-1, composerRect: c?Math.round(c.getBoundingClientRect().height):-1 } })()")

const afterTrips = await ev("(async () => { for (const k of ['skills','artifacts','settings']) { document.querySelector('[data-nav-key=\"'+k+'\"]').click(); await new Promise(r=>setTimeout(r,450)) } document.querySelector('[data-nav-key=\"chat\"]').click(); await new Promise(r=>setTimeout(r,700)); const c=document.querySelector('.workbench-composer'); const ta=document.querySelector('[data-chat-col] textarea'); return { composerExists: !!c, probe: c?c.getAttribute('data-probe-id'):null, taExists: !!ta, taH: ta?Math.round(ta.getBoundingClientRect().height):-1, composerRect: c?Math.round(c.getBoundingClientRect().height):-1, activePanes: document.querySelectorAll('[data-view-pane][data-view-state=\"active\"]').length } })()")

// 2. Sidebar expand/collapse smoothness: measure long tasks and frame gaps during the toggle window.
await ev("window.__lt2=[]; try { new PerformanceObserver((l)=>{for(const e of l.getEntries()) window.__lt2.push(Math.round(e.duration))}).observe({entryTypes:['longtask']}) } catch {}")
const collapsePerf = await ev("(async () => { const t=document.querySelector('[data-list-toggle]'); const frames=[]; let last=performance.now(); let stop=false; const tick=()=>{ const n=performance.now(); frames.push(Math.round((n-last)*10)/10); last=n; if(!stop) requestAnimationFrame(tick) }; requestAnimationFrame(tick); window.__lt2=[]; t.click(); await new Promise(r=>setTimeout(r,700)); stop=true; const body=document.querySelector('[data-list-body]'); const pane=document.querySelector('[data-list-pane]'); return { longTasks: window.__lt2.slice(), maxLongTask: window.__lt2.length?Math.max.apply(null,window.__lt2):0, frames: frames.length, maxFrameGap: frames.length?Math.max.apply(null,frames):0, p95FrameGap: frames.slice().sort((a,b)=>a-b)[Math.floor(frames.length*0.95)]||0, bodyOpen: body?body.getAttribute('data-open'):null, paneW: pane?Math.round(pane.getBoundingClientRect().width):-1 } })()")
const expandPerf = await ev("(async () => { const t=document.querySelector('[data-list-toggle]'); const frames=[]; let last=performance.now(); let stop=false; const tick=()=>{ const n=performance.now(); frames.push(Math.round((n-last)*10)/10); last=n; if(!stop) requestAnimationFrame(tick) }; requestAnimationFrame(tick); window.__lt2=[]; t.click(); await new Promise(r=>setTimeout(r,700)); stop=true; const body=document.querySelector('[data-list-body]'); const pane=document.querySelector('[data-list-pane]'); return { longTasks: window.__lt2.slice(), maxLongTask: window.__lt2.length?Math.max.apply(null,window.__lt2):0, frames: frames.length, maxFrameGap: frames.length?Math.max.apply(null,frames):0, p95FrameGap: frames.slice().sort((a,b)=>a-b)[Math.floor(frames.length*0.95)]||0, bodyOpen: body?body.getAttribute('data-open'):null, paneW: pane?Math.round(pane.getBoundingClientRect().width):-1 } })()")

console.log('COMPOSER_BEFORE=' + JSON.stringify(before))
console.log('COMPOSER_AFTER_TRIPS=' + JSON.stringify(afterTrips))
console.log('COLLAPSE=' + JSON.stringify(collapsePerf))
console.log('EXPAND=' + JSON.stringify(expandPerf))
const same = before.probe === afterTrips.probe && afterTrips.composerExists === true
console.log('VERDICT composer_node_survives_page_switches=' + same)
console.log('LOGS=' + JSON.stringify(logs.slice(0, 8), null, 2))
try { chrome.kill() } catch {}
server.close()
process.exit(0)
