const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + String(r.result.exceptionDetails.exception?.description||'').slice(0,150); return r.result.result.value; };
const d = JSON.parse(await ev('JSON.stringify(window.__sessionDebug.read())'));
console.log('sid=' + d.sessionId + ' len=' + d.messagesLen);
for (const m of d.messagesTail) {
  console.log(JSON.stringify({ kind: m.kind, id: m.id, msgId: m.msgId, text: String(m.text || ''), tools: (m.tools || []).map(t => t.name + ':' + t.status), segs: (m.segments || []).map(s => s.kind) }));
}
ws.close();
