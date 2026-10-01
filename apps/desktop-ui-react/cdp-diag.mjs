const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r)); await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  const disable = await ev(`(async function(){
    try {
      const tauri = window.__TAURI__;
      const inv = tauri?.core?.invoke ?? tauri?.invoke;
      if (!inv) return "NO_INVOKE";
      const r = await inv("plugin_set_enabled", { id: "dsh-deep-whale", on: false });
      return "OK " + JSON.stringify(r);
    } catch (e) { return "ERR " + (e.message || String(e)); }
  })()`);
  const bg = await ev(`(function(){
    var b = document.querySelector(".theme-bg") || document.querySelector("[data-plugin-theme-bg]");
    if (!b) return { noBgLayer: true };
    var cs = getComputedStyle(b);
    var rootBg = getComputedStyle(document.body).backgroundColor;
    return { zIndex: cs.zIndex, position: cs.position, opacity: cs.opacity, display: cs.display, bodyBg: rootBg, hasImg: !!b.querySelector("img"), imgNw: b.querySelector("img") ? b.querySelector("img").naturalWidth : 0 };
  })()`);
  console.log(JSON.stringify({ disable, bg }));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));