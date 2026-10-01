const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL);
  let id = 0; const errors = [];
  const pending = new Map();
  const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') { const e = m.params.exceptionDetails.exception; errors.push(String((e && e.description) || m.params.exceptionDetails.text || '').slice(0, 160)); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') { errors.push('console.error: ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 160)); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable', {});
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
  await new Promise((r) => setTimeout(r, 3000));
  const bodyLen0 = await ev('document.body.innerText.length');
  for (const label of ['技能', '产物', '设置', '对话']) {
    await ev('(() => { const b = [...document.querySelectorAll("button,[role=button],a")].find((x) => ((x.getAttribute("title") || "") + x.textContent).includes(' + JSON.stringify(label) + ')); if (b) b.click(); return !!b; })()');
    await new Promise((r) => setTimeout(r, 1500));
  }
  await new Promise((r) => setTimeout(r, 2500));
  const crashed = await ev('document.body.innerText.indexOf("界面出错") >= 0');
  const tabs = await ev('document.querySelectorAll("[data-shell-part]").length');
  console.log(JSON.stringify({ title: await ev('document.title'), bodyLen0, bodyLen1: await ev('document.body.innerText.length'), crashed, shellParts: tabs, errors: errors.slice(0, 5), errorCount: errors.length }));
  ws.close();
})().catch((e) => { console.log('FAIL ' + e.message); });