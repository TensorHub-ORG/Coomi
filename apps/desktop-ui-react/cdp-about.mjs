const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r)); await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  await new Promise((r) => setTimeout(r, 1500));
  // 进设置页
  await ev("(function(){var b=[].slice.call(document.querySelectorAll('button,[role=button],a')).filter(function(x){return ((x.getAttribute('title')||'')+(x.textContent||'')).indexOf('设置')>=0})[0];if(b)b.click();return !!b})()");
  await new Promise((r) => setTimeout(r, 1800));
  // 点左侧「关于」分组
  await ev("(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').trim()==='关于'})[0];if(b)b.click();return !!b})()");
  await new Promise((r) => setTimeout(r, 1500));
  const txt = await ev("document.body.innerText");
  const m = txt.match(/Beta [0-9.]+ · build [0-9-]+/);
  console.log(JSON.stringify({ buildLine: m ? m[0] : null, hasProducer: txt.indexOf("星奈_Star") >= 0, hasOpensource: txt.indexOf("开源") >= 0 }));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));