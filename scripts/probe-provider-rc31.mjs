const base = 'http://127.0.0.1:9599'
const token = 'probe'
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: (await res.text()).slice(0, 200) }
}
const report = async (label, body) => {
  const r = await call('POST', '/api/providers', body)
  console.log(label + ' -> HTTP ' + r.status + '  ' + r.body)
}
// 向导改完后会发的四种接口类型（全部应当 200）
for (const type of ['openai_compatible', 'openai_responses', 'anthropic_messages', 'gemini_native']) {
  await report('① type=' + type.padEnd(19), { id: 'probe-' + type, name: '探测-' + type, type, baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], modelContextWindows: { m: 32000 }, activate: false })
}
// ② 本机地址 + 没有 Key + activate=true（rc31 起应当放行）
await report('② 本机地址无 Key 直接激活    ', { id: 'probe-local', name: '探测-本地', type: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'm', models: ['m'], activate: true })
// ③ 云端地址 + 没有 Key + activate=true（应当仍然拒绝，但消息已说明本机地址除外）
await report('③ 云端地址无 Key 直接激活    ', { id: 'probe-cloud', name: '探测-云端', type: 'openai_compatible', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], activate: true })
// ④ 越界上下文窗口（前端已夹紧；这里直接打引擎确认它仍会拒绝——这是设计如此）
await report('④ 窗口 8192（前端会夹紧）     ', { id: 'probe-ctx', name: '探测-窗口', type: 'openai_compatible', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], modelContextWindows: { m: 8192 }, activate: false })
console.log('厂商列表=' + (await call('GET', '/api/providers')).body.slice(0, 160))