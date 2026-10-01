const base = 'http://127.0.0.1:9599'
const token = 'probe'
async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: (await res.text()).slice(0, 250) }
}
const r1 = await call('POST', '/api/providers/discover-models-preview', { type: 'openai_compatible', baseUrl: 'http://127.0.0.1:9611/v1', apiKey: 'sk-test' })
console.log('① 新建厂商预览拉模型（假上游）-> HTTP ' + r1.status + '  ' + r1.body)
const r2 = await call('POST', '/api/providers/discover-models-preview', { type: 'openai_compatible', baseUrl: 'http://127.0.0.1:9699/v1' })
console.log('② 上游不可达          -> HTTP ' + r2.status + '  ' + r2.body)
const r3 = await call('POST', '/api/providers/discover-models-preview', { type: 'openai', baseUrl: 'http://127.0.0.1:9611/v1' })
console.log('③ 非法接口类型        -> HTTP ' + r3.status + '  ' + r3.body)
const r4 = await call('GET', '/api/providers')
console.log('④ 配置有没有被写脏    -> ' + r4.body.slice(0, 160))
// 顺带验证：预览端点不落盘
const created = await call('POST', '/api/providers', { name: 'Probe Two', type: 'openai_compatible', baseUrl: 'http://127.0.0.1:9611/v1', model: 'demo-small', models: ['demo-small'], activate: false })
console.log('⑤ 保存（引擎派生 id）  -> HTTP ' + created.status + '  ' + created.body)