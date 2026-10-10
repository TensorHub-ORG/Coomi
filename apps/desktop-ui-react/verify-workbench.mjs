import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { spawn } from 'node:child_process'

const DIST = new URL('./dist/', import.meta.url).pathname.replace(/^\//, '')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.map': 'application/json' }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    let p = join(DIST, decodeURIComponent(url.pathname))
    if (!existsSync(p) || url.pathname === '/') p = join(DIST, 'index.html')
    const body = await readFile(p)
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(body)
  } catch (e) { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => server.listen(5199, '127.0.0.1', r))
console.log('static server on 5199')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = new URL('./.cdp-profile2', import.meta.url).pathname.replace(/^\//, '')
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=9344', '--user-data-dir=' + profile, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore', detached: false })

let list = []
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:9344/json')).json(); if (list.some((t) => t.type === 'page')) break } catch {}
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
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 180))
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 260))
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable', {})
await send('Page.enable', {})
await send('Page.navigate', { url: 'http://127.0.0.1:5199/' })
await new Promise((r) => setTimeout(r, 10000))

const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0, 260)
  return r.result?.result?.value
}
const probe = await ev(`(() => {
  const q = (s) => document.querySelector(s)
  const cs = (el) => el ? getComputedStyle(el) : null
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const o = {}
  o.title = document.title
  o.rootBox = box(document.getElementById('root'))
  o.rail = box(q('.workbench-rail'))
  o.railBg = cs(q('.workbench-rail'))?.backgroundImage?.slice(0, 70) ?? null
  o.toolbar = box(q('.workbench-toolbar'))
  o.toolbarH = cs(q('.workbench-toolbar'))?.height ?? null
  o.listPane = box(q('[data-list-pane]'))
  o.composer = box(q('.workbench-composer'))
  o.composerShadow = (cs(q('.workbench-composer'))?.boxShadow ?? '').slice(0, 70)
  o.dockBar = box(q('[data-dock-bar]'))
  o.dockBarBg = cs(q('[data-dock-bar]'))?.backgroundImage?.slice(0, 70) ?? null
  const rootStyle = cs(document.documentElement)
  o.sp1 = rootStyle?.getPropertyValue('--sp-1')?.trim() ?? null
  o.zHeader = rootStyle?.getPropertyValue('--z-header')?.trim() ?? null
  o.workspaceLabelCount = Array.from(document.querySelectorAll('*')).filter((e) => !e.children.length && (e.textContent || '').trim() === '工作区').length
  o.emptyTagline = (q('.workbench-empty .empty-tagline')?.textContent ?? '').slice(0, 30)
  o.emptyMark = box(q('.workbench-empty-mark'))
  o.viewport = { w: innerWidth, h: innerHeight }
  o.hOverflow = document.documentElement.scrollWidth > innerWidth + 1
  o.paneCount = document.querySelectorAll('[data-view-pane]').length
  return o
})()`)
console.log('PROBE=' + JSON.stringify(probe, null, 2))
console.log('LOGS=' + JSON.stringify(logs.slice(0, 10), null, 2))
try { chrome.kill(); } catch {}
server.close()
process.exit(0)
