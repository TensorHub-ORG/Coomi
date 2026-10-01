// 本地 OpenAI 兼容桩服务：只用来验证「自动获取模型列表」这条链路。
import { createServer } from 'node:http'
const models = ['coomi-test-small', 'coomi-test-large', 'coomi-test-reasoning']
const server = createServer((req, res) => {
  const url = req.url || ''
  if (url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'stub' })) }))
    return
  }
  if (url.includes('/chat/completions')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'stub', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'stub ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end('{}')
})
server.listen(18099, '127.0.0.1', () => console.log('stub listening on 18099'))
