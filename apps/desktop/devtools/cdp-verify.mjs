const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL);
  let id = 0; const errors = [];
  const pending = new Map();
  const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') { const e = m.params.exceptionDetails.exception; errors.push(String((e && e.description) || m.params.exceptionDetails.text || '').slice(0, 140)); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable', {});
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
  await new Promise((r) => setTimeout(r, 4000));
  const steps = [];
  steps.push({ step: 'boot', bodyLen: await ev('document.body.innerText.length'), crashed: await ev('document.body.innerText.indexOf("界面出错") >= 0') });
  for (const label of ['技能', '产物', '设置', '对话', '技能', '对话']) {
    await ev('(() => { const b = [...document.querySelectorAll("button,[role=button],a")].find((x) => ((x.getAttribute("title") || "") + x.textContent).includes(' + JSON.stringify(label) + ')); if (b) b.click(); return !!b; })()');
    await new Promise((r) => setTimeout(r, 1300));
  }
  steps.push({ step: 'after-nav-cycle', bodyLen: await ev('document.body.innerText.length'), crashed: await ev('document.body.innerText.indexOf("界面出错") >= 0') });
  // 切会话：点击左侧列表前 3 条
  const switched = await ev('(() => { const items = [...document.querySelectorAll("[data-session-item] a, [data-session-item]")]; if (items.length < 2) return 0; items[1].click(); return items.length; })()');
  await new Promise((r) => setTimeout(r, 2500));
  steps.push({ step: 'switch-session', items: switched, bodyLen: await ev('document.body.innerText.length'), crashed: await ev('document.body.innerText.indexOf("界面出错") >= 0'), frozenText: await ev('document.body.innerText.slice(0,60)') });
  console.log(JSON.stringify({ steps, errors: errors.slice(0, 5), errorCount: errors.length }));
  ws.close();
})().catch((e) => { console.log('FAIL ' + e.message); });