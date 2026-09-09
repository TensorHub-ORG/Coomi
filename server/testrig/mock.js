// 模拟 OpenAI 兼容模型服务：支持 stream=true 的 SSE 分块输出
const http = require('http')
const NL = String.fromCharCode(10)
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let wantStream = false
    try { wantStream = Boolean(JSON.parse(body).stream) } catch {}
    if (!wantStream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', created: Date.now() / 1000 | 0, model: 'mock-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '成员回复：分析完成。' } }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const chunks = ['成员回复：', '本阶段分析完成。', '@成员 2 请继续补充观点。']
    let index = 0
    const timer = setInterval(() => {
      if (index < chunks.length) {
        const payload = JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-model',
          choices: [{ index: 0, delta: { content: chunks[index] }, finish_reason: null }] })
        res.write('data: ' + payload + NL + NL)
        index += 1
      } else {
        const endPayload = JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        res.write('data: ' + endPayload + NL + NL)
        res.write('data: [DONE]' + NL + NL)
        res.end()
        clearInterval(timer)
      }
    }, 300)
  })
})
server.listen(9098, '127.0.0.1', () => console.log('mock sse on 9098'))
