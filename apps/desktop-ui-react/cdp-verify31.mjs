const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC ' + (r.result.exceptionDetails.text || ''); return r.result.result.value; } catch (e) { return 'ERR ' + e.message; } };
// ① 生产包里的接口类型是否是引擎规范名
console.log('① 包里含规范名 = ' + await ev("(async () => { const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.endsWith('.js')); let hit = []; for (const u of urls.slice(0, 40)) { const t = await (await fetch(u)).text().catch(() => ''); for (const k of ['openai_compatible', 'openai_responses', 'anthropic_messages', 'gemini_native', 'OpenAI Responses']) if (t.includes(k)) hit.push(k); } return JSON.stringify([...new Set(hit)]); })()"));
// ② frontend_note 通道
console.log('② 记录一条现场 = ' + await ev("(async () => { try { await window.__TAURI__.core.invoke('frontend_note', { scope: 'rc31 自检', message: '{\"type\":\"openai_compatible\",\"hasKey\":false} | 自检' }); return 'ok'; } catch (e) { return 'ERR ' + String(e); } })()"));
ws.close();