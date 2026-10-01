const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r)); await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  await ev("location.reload()");
  await new Promise((r) => setTimeout(r, 7000));
  const out = await ev("(function(){ var logo = document.querySelector('[data-shell-part=rail] img'); var b = document.querySelector('.theme-bg'); return { themeActive: !!document.querySelector('[data-plugin-theme]'), logoNw: logo ? logo.naturalWidth : 0, logoVisible: logo ? getComputedStyle(logo).visibility : 'n/a', bgNw: b && b.querySelector('img') ? b.querySelector('img').naturalWidth : 0 }; })()");
  console.log(JSON.stringify(out));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));