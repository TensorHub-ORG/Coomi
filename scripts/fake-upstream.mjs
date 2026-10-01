import { createServer } from 'node:http'
const server = createServer((req, res) => {
  if (req.url && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'demo-small' }, { id: 'demo-large' }] }))
    return
  }
  res.writeHead(404); res.end('{}')
})
server.listen(9611, '127.0.0.1', () => console.log('fake upstream on 9611'))