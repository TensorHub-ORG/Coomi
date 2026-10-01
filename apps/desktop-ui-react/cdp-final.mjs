const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r)); await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  const out = await ev(`(function(){
    var b = document.querySelector(".theme-bg");
    var surf = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
    var bg = b ? getComputedStyle(b).opacity : "n/a";
    var toggles = [].slice.call(document.querySelectorAll("[data-testid=plugins-panel] .switch, [data-testid=plugins-panel] button[role=switch]"));
    return { themeActive: !!document.querySelector("[data-plugin-theme]"), surfaceVar: surf, bgOpacity: bg, toggleCount: toggles.length, bgImgNw: b && b.querySelector("img") ? b.querySelector("img").naturalWidth : 0 };
  })()`);
  console.log(JSON.stringify(out));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));