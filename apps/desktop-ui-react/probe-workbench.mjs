import { writeFileSync } from 'node:fs'
const base = 'http://127.0.0.1:9333'
let list = []
for (let i = 0; i < 40; i++) {
  try { list = await (await fetch(base + '/json')).json(); if (list.length) break } catch {}
  await new Promise((r) => setTimeout(r, 500))
}
const page = list.find((t) => t.type === 'page') || list[0]
if (!page) { console.log('NO_TARGET'); process.exit(2) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const logs = []
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails?.text ?? '') + ' ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300))
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable', {})
await send('Page.enable', {})
await send('Page.navigate', { url: 'http://localhost:5199/' })
await new Promise((r) => setTimeout(r, 9000))
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0, 300)
  return r.result?.result?.value
}
const probe = await ev(`(() => {
  const q = (s) => document.querySelector(s)
  const cs = (el) => el ? getComputedStyle(el) : null
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const out = {}
  out.title = document.title
  out.root = box(document.getElementById('root'))
  out.hasRail = !!q('.workbench-rail')
  out.railBox = box(q('.workbench-rail'))
  out.railBg = cs(q('.workbench-rail'))?.backgroundImage?.slice(0, 80) ?? null
  out.toolbar = box(q('.workbench-toolbar'))
  out.toolbarH = cs(q('.workbench-toolbar'))?.height ?? null
  out.listPane = box(q('[data-list-pane]'))
  out.composer = box(q('.workbench-composer'))
  out.composerShadow = (cs(q('.workbench-composer'))?.boxShadow ?? '').slice(0, 90)
  out.dockBar = box(q('[data-dock-bar]'))
  out.dockBarBg = cs(q('[data-dock-bar]'))?.backgroundImage?.slice(0, 80) ?? null
  out.spToken = cs(document.documentElement)?.getPropertyValue('--sp-1')?.trim() ?? null
  out.zToken = cs(document.documentElement)?.getPropertyValue('--z-header')?.trim() ?? null
  out.workspaceLabels = Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0 && e.textContent?.trim() === '工作区').length
  out.viewport = { w: innerWidth, h: innerHeight }
  out.bodyOverflowX = document.documentElement.scrollWidth > innerWidth
  out.msgRows = document.querySelectorAll('.workbench-msg').length
  return out
})()`)
console.log('PROBE=' + JSON.stringify(probe, null, 2))
console.log('LOGS=' + JSON.stringify(logs.slice(0, 12), null, 2))
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (shot.result?.data) { writeFileSync('shot-verify.png', Buffer.from(shot.result.data, 'base64')); console.log('shot saved') }
ws.close()
process.exit(0)
