const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r)); await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  const prefs = await ev("localStorage.getItem('coomi.plugins.v1')");
  const list = await ev("(async function(){ try { var t = window.__TAURI__; var inv = (t.core ? t.core.invoke : null) || t.invoke; var r = await inv('plugin_list'); return JSON.stringify(r); } catch(e){ return 'ERR '+e.message; } })()");
  console.log(JSON.stringify({ prefs, list: (list||'').slice(0,500) }));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));