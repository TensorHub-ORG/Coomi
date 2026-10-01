const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r)); await send("Runtime.enable", {});
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  // 触发 Ctrl+N 新对话，进入空态
  await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "n", code: "KeyN", windowsVirtualKeyCode: 78 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "n", code: "KeyN", windowsVirtualKeyCode: 78 });
  await new Promise((r) => setTimeout(r, 2500));
  const out = await ev(`(function(){
    var h = document.querySelector("[data-empty-copy=on]");
    var cs = h ? getComputedStyle(h) : null;
    return { tagline: h ? h.textContent : null, fs: cs ? cs.fontSize : null, lh: cs ? cs.lineHeight : null, cls: h ? h.className.slice(0, 60) : null, unnamed: [].slice.call(document.querySelectorAll("[data-session-item]")).filter(function(r){return (r.innerText||"").indexOf("未命名对话")>=0}).length };
  })()`);
  console.log(JSON.stringify(out));
  ws.close();
})().catch((e) => console.log("FAIL " + e.message));