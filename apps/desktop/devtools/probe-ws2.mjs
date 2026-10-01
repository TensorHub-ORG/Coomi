import { execSync } from 'node:child_process'
const cmd = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'coomi.exe\'\\" | Where-Object { $_.CommandLine } | Select-Object -First 1).CommandLine"').toString()
const port = /--port (\d+)/.exec(cmd)[1]
const token = /--token (\S+)/.exec(cmd)[1]
const session = process.argv[2]
const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws/session/' + session + '?token=' + token)
let text = ''
const events = {}
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ id: 'c1', payload: { command: 'send_message', text: '回复两个字：收到' } }))
})
ws.addEventListener('message', (e) => {
  const env = JSON.parse(String(e.data))
  const p = env.payload || {}
  events[env.type + ':' + (p.event_type || '')] = (events[env.type + ':' + (p.event_type || '')] || 0) + 1
  if (p.event_type === 'text_chunk') text += (p.delta || p.text || '')
  if (p.event_type === 'agent_error') console.log('[agent_error] ' + p.message)
  if (p.event_type === 'tool_start') console.log('[tool] ' + p.tool_name)
})
setTimeout(() => {
  console.log('--- 事件统计 ---')
  for (const [k, v] of Object.entries(events)) console.log('  ' + k + ' x' + v)
  console.log('--- 助手输出 ---')
  console.log(text.slice(0, 400) || '(空)')
  process.exit(0)
}, 40000)