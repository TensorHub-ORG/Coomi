import { execSync } from 'node:child_process'
const cmd = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'coomi.exe\'\\" | Where-Object { $_.CommandLine } | Select-Object -First 1).CommandLine"').toString()
const port = /--port (\d+)/.exec(cmd)[1]
const token = /--token (\S+)/.exec(cmd)[1]
const list = await (await fetch('http://127.0.0.1:' + port + '/api/sessions', { headers: { Authorization: 'Bearer ' + token, Origin: 'http://tauri.localhost' } })).json()
const session = list.sessions[0].id
const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws/session/' + session + '?token=' + token)
ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'y', payload: { command: 'send_message', text: '我刚才说我的项目叫什么？一句话回答。' } })))
ws.addEventListener('message', (e) => { const p = (JSON.parse(String(e.data)).payload) || {}; if (p.event_type === 'turn_end') { console.log('第二轮 turn_end'); process.exit(0) } })
setTimeout(() => process.exit(0), 45000)