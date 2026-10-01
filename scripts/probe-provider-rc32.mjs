const base = 'http://127.0.0.1:9599'
const token = 'probe'
async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: (await res.text()).slice(0, 200) }
}
const report = async (label, body) => {
  const r = await call('POST', '/api/providers', body)
  console.log(label + ' -> HTTP ' + r.status + '  ' + r.body)
}
// 向导 rc32 会发的形态：带 id（自动生成）
await report('① 带自动生成 id（英文名）  ', { id: 'my-provider', name: 'My Provider', type: 'openai_compatible', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], modelContextWindows: { m: 32000 }, activate: false })
// 引擎兜底：完全不带 id
await report('② 不带 id（英文名）        ', { name: 'Agnes Two', type: 'openai_compatible', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], activate: false })
await report('③ 不带 id（中文名）        ', { name: '我的厂商', type: 'openai_compatible', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], activate: false })
await report('④ 不带 id + 重名（避重）    ', { name: 'My Provider', type: 'openai_compatible', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], activate: false })
console.log('厂商列表=' + (await call('GET', '/api/providers')).body.slice(0, 260))