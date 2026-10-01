const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r)); await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  const out = await ev(`(function(){
    var big = null;
    [].slice.call(document.querySelectorAll("body *")).forEach(function(el){
      var r = el.getBoundingClientRect();
      if (r.width > 400 && r.height > 60 && getComputedStyle(el).opacity === "0" && !el.children.length) { big = el; }
    });
    if (!big) return { none: true };
    var chain = []; var node = big;
    while (node && node !== document.body) { chain.push((node.tagName||"?").toLowerCase() + (node.className ? "." + node.className.toString().slice(0,40) : "")); node = node.parentElement; }
    return { text: big.textContent.slice(0,80), html: big.outerHTML.slice(0,300), chain: chain.slice(0,8), w: Math.round(big.getBoundingClientRect().width), h: Math.round(big.getBoundingClientRect().height) };
  })()`);
  console.log(JSON.stringify(out));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));