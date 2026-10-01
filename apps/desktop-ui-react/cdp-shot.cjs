const WS_URL = process.argv[2];
const fs = require('fs');
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable', {});
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const data = r.result && r.result.data;
  if (!data) { console.log('NO_SHOT'); process.exit(0); }
  fs.writeFileSync('G:/DSH/coomi-full-project/apps/shot.png', Buffer.from(data, 'base64'));
  console.log('SHOT_OK');
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
