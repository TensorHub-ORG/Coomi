const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const frame = list.find((t) => t.type === 'iframe');
if (!frame) { console.log('没有 iframe 目标'); process.exit(0) }
const ws = new WebSocket(frame.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? 'EXC ' + r.result.exceptionDetails.text : r.result.result.value; };
console.log('插件页正文=' + JSON.stringify(await ev('document.body.innerText')));
console.log('桥接结果=' + JSON.stringify(await ev("document.getElementById('out') ? document.getElementById('out').textContent.slice(0, 260) : '(no out)'")));
ws.close();