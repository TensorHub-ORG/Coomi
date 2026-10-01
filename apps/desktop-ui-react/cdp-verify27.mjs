const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails.text || ''); return r.result.result.value; } catch (e) { return 'ERR:' + e.message; } };
console.log('版本=' + await ev("(function(){ try { return window.__TAURI__.app.getVersion(); } catch(e) { return 'ERR'; } })()"));
console.log('注入=' + await ev("JSON.stringify(window.__COOMI_BOOT__ ? { port: window.__COOMI_BOOT__.port, v: window.__COOMI_BOOT__.version } : null)"));
console.log('传输=' + await ev("JSON.stringify(window.__transportDebug ? window.__transportDebug() : null)"));
const d = JSON.parse((await ev('JSON.stringify(window.__sessionDebug.read())')) || '{}');
console.log('会话=' + JSON.stringify({ sid: String(d.sessionId || '').slice(0, 8), messages: d.messagesLen, streaming: d.streaming, runState: d.runState, transport: d.transport, connected: d.connected, sessions: d.sessions, linkError: d.linkError }));
// 新逻辑是否真的进了包：远程 MCP / 技能中心的按条忙态
console.log('卡片忙态=' + await ev("(function(){ var t = document.body.innerText || ''; return { 未连接: /与引擎的连接已断开|正在准备一个新对话/.test(t) }; })()").then((v) => JSON.stringify(v)));
ws.close();