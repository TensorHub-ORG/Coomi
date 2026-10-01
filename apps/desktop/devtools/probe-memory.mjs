import { execSync } from 'node:child_process'
const cmd = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'coomi.exe\'\\" | Where-Object { $_.CommandLine } | Select-Object -First 1).CommandLine"').toString()
const port = /--port (\d+)/.exec(cmd)[1]
const token = /--token (\S+)/.exec(cmd)[1]
const list = await (await fetch('http://127.0.0.1:' + port + '/api/sessions', { headers: { Authorization: 'Bearer ' + token, Origin: 'http://tauri.localhost' } })).json()
const session = list.sessions[0].id
const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws/session/' + session + '?token=' + token)
ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'x', payload: { command: 'send_message', text: '记住一件事：我的项目叫 Coomi，主要用 Rust 和 Vue/React。回复两个字就行。' } })))
let done = false
ws.addEventListener('message', (e) => { const p = (JSON.parse(String(e.data)).payload) || {}; if (p.event_type === 'turn_end') { done = true; console.log('turn_end 收到'); process.exit(0) } })
setTimeout(() => { console.log(done ? 'done' : 'timeout（仍在生成，记忆写入发生在下一轮开始）'); process.exit(0) }, 45000)