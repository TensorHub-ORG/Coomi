const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  const dlg = await ev("(function(){var d=document.querySelector('[role=dialog]');return d?d.innerText.slice(0,400):null})()");
  const btns = await ev("(function(){var d=document.querySelector('[role=dialog]');if(!d)return null;return [].slice.call(d.querySelectorAll('button')).map(function(b){return b.textContent.trim().slice(0,20)+(b.disabled?'[disabled]':'')})})()");
  console.log(JSON.stringify({ dialog: dlg, buttons: btns }));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));