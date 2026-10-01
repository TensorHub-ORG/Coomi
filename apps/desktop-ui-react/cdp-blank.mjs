const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r)); await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  const out = await ev(`(function(){
    var styles = [].slice.call(document.querySelectorAll("[data-plugin-theme], [data-plugin-css]"));
    var invisible = [];
    [].slice.call(document.querySelectorAll("body *")).forEach(function(el){
      if (!el.children.length) return;
      var cs = getComputedStyle(el);
      if (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && (cs.opacity === "0" || cs.visibility === "hidden" || cs.color === "rgba(0, 0, 0, 0)")) {
        invisible.push({ tag: el.tagName, cls: (el.className||"").toString().slice(0,50), op: cs.opacity, vis: cs.visibility, col: cs.color, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) });
      }
    });
    var rootVars = getComputedStyle(document.documentElement);
    return { leftoverStyles: styles.map(function(s){return s.getAttribute("data-plugin-theme")||s.getAttribute("data-plugin-css")}), invisibleCount: invisible.length, sample: invisible.slice(0,8), inkVar: rootVars.getPropertyValue("--ink").trim(), ink2Var: rootVars.getPropertyValue("--ink-2").trim() };
  })()`);
  console.log(JSON.stringify(out));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));