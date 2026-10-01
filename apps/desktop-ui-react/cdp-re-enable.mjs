const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r)); await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  const on = await ev(`(async function(){ try { const t = window.__TAURI__; const inv = t.core.invoke ?? t.invoke; return await inv("plugin_set_enabled", { id: "dsh-deep-whale", on: true }); } catch(e){ return "ERR "+(e.message||String(e)); } })()`);
  await ev("location.reload()");
  await new Promise((r) => setTimeout(r, 6500));
  const out = await ev(`(function(){
    var b = document.querySelector(".theme-bg");
    var surf = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
    return { enabledResult: "" + on + "", themeActive: !!document.querySelector("[data-plugin-theme]"), surfaceVar: surf, bgImgNw: b && b.querySelector("img") ? b.querySelector("img").naturalWidth : 0 };
  })()`);
  console.log(JSON.stringify(out));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));