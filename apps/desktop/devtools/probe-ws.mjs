// 直连引擎 WS，绕开界面：看到底引擎回了什么事件
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
const cmd = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'coomi.exe\'\\" | Where-Object { $_.CommandLine } | Select-Object -First 1).CommandLine"').toString()
const port = /--port (\d+)/.exec(cmd)[1]
const token = /--token (\S+)/.exec(cmd)[1]
const session = process.argv[2]
console.log('port=' + port + ' session=' + session)
const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws/session/' + session + '?token=' + token)
let count = 0
ws.addEventListener('open', () => {
  console.log('[open] sending message')
  ws.send(JSON.stringify({ command: 'send_message', text: '你好，请回复两个字：收到' }))
})
ws.addEventListener('message', (e) => {
  count++
  const text = String(e.data)
  console.log('[' + count + '] ' + text.slice(0, 300))
})
ws.addEventListener('error', (e) => console.log('[error] ' + (e.message || 'ws error')))
ws.addEventListener('close', (e) => console.log('[close] code=' + e.code))
setTimeout(() => { console.log('--- total events: ' + count); process.exit(0) }, 25000)