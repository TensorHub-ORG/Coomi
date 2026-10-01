const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r)); await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  const out = await ev(`(function(){
    var nav = document.querySelectorAll("[data-shell-part=rail] svg");
    var logo = document.querySelector("[data-shell-part=rail] img");
    var ns = [].slice.call(nav).slice(0,3).map(function(s){ var c=getComputedStyle(s); return { fill: c.fill, color: c.color, w: s.getBBox ? s.getBBox().width : 0, cls: (s.className.baseVal||s.className||"").slice(0,40) }; });
    var lc = logo ? { src: (logo.src||"").slice(0,90), nw: logo.naturalWidth, visible: logo.getBoundingClientRect().width > 0 && getComputedStyle(logo).visibility !== "hidden" } : null;
    return { navIcons: ns, logo: lc };
  })()`);
  console.log(JSON.stringify(out));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));