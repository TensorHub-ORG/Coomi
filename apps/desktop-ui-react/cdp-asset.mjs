const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r)); await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  await new Promise((r) => setTimeout(r, 2500));
  const out = await ev(`(function(){
    var res = performance.getEntriesByType("resource").filter(function(e){return e.name.indexOf("asset")>=0 || e.name.indexOf("theme")>=0});
    var imgs = [].slice.call(document.querySelectorAll("[data-theme-mascot], .theme-bg img, [data-theme-composer-mascot] img"));
    var info = imgs.map(function(im){ return { src: (im.src||"").slice(0,120), complete: im.complete, nw: im.naturalWidth, tag: im.tagName }; });
    return { count: res.length, failed: res.filter(function(e){return e.transferSize===0}).map(function(e){return e.name.slice(0,120)}), imgs: info, themeCss: !!document.querySelector("[data-plugin-theme]") };
  })()`);
  console.log(JSON.stringify(out));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));