import { writeFileSync } from 'node:fs'
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable', {});
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('G:/DSH/coomi-full-project/scripts/rc30-plugin-page.png', Buffer.from(shot.result.data, 'base64'));
console.log('screenshot bytes=' + shot.result.data.length);
// 顺便把主页面文本抓出来，确认没有断连横幅
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? 'EXC' : r.result.result.value; };
console.log('页面标题=' + await ev("document.title"));
ws.close();