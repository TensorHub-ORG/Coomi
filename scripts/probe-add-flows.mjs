const base = 'http://127.0.0.1:9599'
const token = 'probe'
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text.slice(0, 260) }
}
const report = async (label, method, path, body) => {
  const r = await call(method, path, body)
  console.log(label + ' -> HTTP ' + r.status + '  ' + r.body)
}
await report('① 厂商 type=openai（向导默认）  ', 'POST', '/api/providers', { id: 'probe-openai', name: '探测A', type: 'openai', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], activate: false })
await report('② 厂商 type=openai_compatible  ', 'POST', '/api/providers', { id: 'probe-compat', name: '探测B', type: 'openai_compatible', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], activate: false })
await report('③ 厂商 type=custom            ', 'POST', '/api/providers', { id: 'probe-custom', name: '探测C', type: 'custom', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], activate: false })
await report('④ 厂商 缺 id                 ', 'POST', '/api/providers', { name: '探测D', type: 'openai_compatible', baseUrl: 'https://example.com/v1' })
await report('⑤ 厂商 模型窗口 8192         ', 'POST', '/api/providers', { id: 'probe-ctx', name: '探测E', type: 'openai_compatible', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], modelContextWindows: { m: 8192 } })
await report('⑥ 厂商 activate=true（无 key）', 'POST', '/api/providers', { id: 'probe-act', name: '探测F', type: 'openai_compatible', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], activate: true })
await report('⑦ 镜像 空 body               ', 'POST', '/api/settings/mirrors', {})
await report('⑧ 子智能体 空 body            ', 'POST', '/api/settings/subagents', {})
await report('⑨ 安装未知内置条目            ', 'POST', '/api/catalog/mcp/install', { id: 'not-a-real-entry', values: {} })
await report('⑩ 安装需要参数的条目(空值)     ', 'POST', '/api/catalog/mcp/install', { id: 'filesystem', values: {} })
console.log('厂商列表=' + (await call('GET', '/api/providers')).body.slice(0, 200))