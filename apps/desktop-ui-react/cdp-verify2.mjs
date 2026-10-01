const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL);
  let id = 0; const pending = new Map(); const errors = [];
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params.exceptionDetails.text || "").slice(0, 90)); });
  await new Promise((r) => ws.addEventListener("open", r));
  await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  await new Promise((r) => setTimeout(r, 4000));
  const probe = await ev(`(function(){
    var rows = [].slice.call(document.querySelectorAll("[data-session-item], a"));
    var unnamed = rows.filter(function(r){ return (r.innerText||"").indexOf("未命名对话")>=0 }).length;
    var h = document.querySelector("[data-empty-copy=on]") || document.querySelector("[data-empty-copy]");
    var cs = h ? getComputedStyle(h) : null;
    return {
      unnamedRows: unnamed,
      tagline: h ? h.textContent : null,
      fontSize: cs ? cs.fontSize : null,
      transition: cs ? cs.transitionProperty + " " + cs.transitionDuration : null,
      leavingSupport: !!document.querySelector("[data-empty-copy=leaving]")
    };
  })()`);
  console.log(JSON.stringify({ probe, errors: errors.slice(0, 3), errCount: errors.length }));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));