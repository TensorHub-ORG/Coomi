const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable', {});
await send('Runtime.enable', {});
const tree = await send('Page.getFrameTree', {});
const children = (tree.result.frameTree.childFrames ?? []).map((f) => ({ id: f.frame.id, url: f.frame.url }));
console.log('子框架=' + JSON.stringify(children));
for (const child of children) {
  const world = await send('Page.createIsolatedWorld', { frameId: child.id, worldName: 'probe', grantUniveralAccess: true });
  const ctx = world.result.executionContextId;
  const out = await send('Runtime.evaluate', { contextId: ctx, expression: 'document.body ? document.body.innerText.slice(0, 400) : "(no body)"', returnByValue: true });
  console.log('框架内容[' + child.url.slice(0, 60) + ']=' + JSON.stringify(out.result?.result?.value));
}
ws.close();