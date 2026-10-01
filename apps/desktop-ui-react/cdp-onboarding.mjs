const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL);
  let id = 0; const pending = new Map(); const errors = [];
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params.exceptionDetails.text || "").slice(0, 100)); });
  await new Promise((r) => ws.addEventListener("open", r));
  await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  await new Promise((r) => setTimeout(r, 3500));
  const txt = await ev("document.body.innerText");
  const enterExpr = "(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return x.textContent.indexOf('进入')>=0});return b.length? b[b.length-1].disabled : null;})()";
  const toggleExpr = "!!document.querySelector('input[type=checkbox]') || !!document.querySelector('[role=checkbox]')";
  const out = {
    hasPrivacy: txt.indexOf("隐私") >= 0,
    hasGuide: txt.indexOf("使用说明") >= 0 || txt.indexOf("开始使用") >= 0,
    bodyLen: txt.length,
    head: txt.slice(0, 150).replace(/\n/g, " | "),
    hasToggle: await ev(toggleExpr),
    enterDisabled: await ev(enterExpr),
    errors: errors.slice(0, 4),
    errCount: errors.length,
  };
  console.log(JSON.stringify(out));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));