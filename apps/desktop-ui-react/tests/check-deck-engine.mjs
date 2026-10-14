/** Real engine/ConPTY integration with a local model fixture; no user data or remote API. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createListener } from 'node:net'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const root = await mkdtemp(join(repo, '.tmp', 'deck-smoke-'))
const home = join(root, 'home')
const cwd = join(root, 'project')
await mkdir(join(home, 'config'), { recursive: true })
await mkdir(cwd)
await writeFile(join(cwd, 'context.txt'), 'Work tools are available in Deck')
// An isolated npm adapter exercises installation and launch through real PTYs.
// It writes fixture packages only; user CLI installations and model APIs are untouched.
const bin = join(root, 'node-bin')
await mkdir(join(bin, 'node_modules/npm/bin'), { recursive: true })
await copyFile(process.execPath, join(bin, process.platform === 'win32' ? 'node.exe' : 'node'))
await writeFile(join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm'), '')
await writeFile(join(bin, 'node_modules/npm/bin/npm-cli.js'), `
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2); const prefix=args[args.indexOf('--prefix')+1];
const profile=args.at(-1)==='@openai/codex@latest'?'codex':'zcode';
const script=path.join(prefix,'node_modules',profile==='codex'?'@openai/codex/bin/codex.js':'zcode-app-cli/bin/zcode.js');
fs.mkdirSync(path.dirname(script),{recursive:true});
fs.writeFileSync(script,\`const fs=require('fs'),path=require('path');
const profile=\${JSON.stringify(profile)};
const config=profile==='codex'?path.join(process.env.CODEX_HOME,'config.toml'):process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
const raw=fs.readFileSync(config,'utf8');
if(!raw.includes('deck-fixture')||!raw.includes('fixture')) throw Error('CLI configuration was not applied');
fs.writeFileSync(path.join(process.cwd(),profile+'-started.txt'),'configured');
fs.writeFileSync(path.join(process.cwd(),profile+'-argv.json'),JSON.stringify(process.argv.slice(2)));
process.stdout.write('CLI configured and ready\\\\r\\\\n');
process.stdin.resume();process.stdin.on('data',data=>{fs.appendFileSync(path.join(process.cwd(),profile+'-input.txt'),data);process.stdout.write(data)});\`);
console.log('fixture package installed: '+profile);
`)
const token = 'isolated-deck-fixture'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error('Timed out: ' + label)
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
let terminalId = ''
let fixtureError
const requests = []
let phase = 'work'
const command = "[IO.File]::AppendAllText('coordinator.txt','dispatched'); Write-Output '调度链路成功'"
const mock = createServer(async (req, res) => {
  try {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'deck-fixture' }] }))
      return
    }
    const tools = body.tools?.map(tool => tool.function.name) || []
    const toolMessages = (body.messages || []).filter(message => message.role === 'tool')
    if (tools.length) {
      for (const name of ['deck_control', 'deck_wait', 'deck_cli', 'deck_dispatch', 'deck_respond', 'deck_status', 'read_file', 'ask_user', 'local_shell', 'update_plan', 'spawn_agent']) assert.ok(tools.includes(name), 'missing shared tool: '+name)
      assert.ok(body.messages.some(message => message.role === 'system' && String(message.content).includes('upper-level coordinator')))
      assert.ok(body.messages.some(message => message.role === 'system' && String(message.content).includes('Built-in Deck CLI Skill')))
      assert.ok(body.messages.some(message => message.role === 'system' && String(message.content).includes('appends exactly one Enter')))
      requests.push({ tools, toolMessages })
    }
    let call
    const workChain = [
      ['fixture-read','read_file',{path:'context.txt'}],
      ['fixture-ask','ask_user',{question:'选择验收方式',options:['运行测试','人工检查']}],
      ['fixture-status','deck_status',{}],
      ['fixture-cli-deny','deck_cli',{operation:'configure',profile:'zcode',provider_id:'fixture',model:'denied-model',effort:''}],
      ['fixture-cli','deck_cli',{operation:'configure',profile:'zcode',provider_id:'fixture',effort:''}],
      ['fixture-acquire','deck_control',{terminal_id:terminalId}],
      ['fixture-acquire-again','deck_control',{terminal_id:terminalId}],
      ['fixture-owned-status','deck_status',{}],
      ['fixture-dispatch','deck_dispatch',{terminal_id:terminalId,prompt:command}],
      ['fixture-wait','deck_wait',{terminal_id:terminalId,after:0,control_revision:1,timeout_ms:5000}],
      ['fixture-dispatch-repeat','deck_dispatch',{terminal_id:terminalId,prompt:command}],
      ['fixture-dispatch-again','deck_dispatch',{terminal_id:terminalId,prompt:"[IO.File]::WriteAllText('coordinator-again.txt','dispatched again')"}],
    ];
    const launchedResult=toolMessages.findLast(message=>message.tool_call_id==='launch-'+phase)
    const ownedTerminal=launchedResult?JSON.parse(launchedResult.content.replace(/^success:\s*/, '')).terminal.id:''
    const chain = phase === 'work' ? workChain : [
      ['launch-'+phase,'deck_cli',{operation:'start',profile:phase==='full'?'zcode':'codex'}],
      ['owned-'+phase,'deck_status',{}],
      ['respond-'+phase,'deck_respond',{terminal_id:ownedTerminal,text:'accepted-'+phase,key:'enter',response_type:'interaction'}],
    ];
    const currentTools = toolMessages.slice((toolMessages.findLastIndex(message=>String(message.tool_call_id).startsWith('fixture-dispatch-again')))+1)
    const step = phase === 'work' ? toolMessages.length : currentTools.filter(message=>String(message.tool_call_id).endsWith('-'+phase)).length
    if (tools.length && chain[step]) {
      const [id,name,sourceArgs]=chain[step];
      const args = {...sourceArgs};
      if (id === 'fixture-wait') {
        const baseline=JSON.parse(toolMessages.find(message=>message.tool_call_id==='fixture-owned-status').content.replace(/^success:\s*/,''));
        args.after=baseline.panel_info[0].output_cursor;
        args.control_revision=baseline.panel_info[0].control_revision;
      }
      call={id,type:'function',function:{name,arguments:JSON.stringify(args)}};
    }
    const message = call ? { role: 'assistant', content: null, tool_calls: [call] } : { role: 'assistant', content: '已派发指令，等待 CLI 的验证结果。' }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] } : message
      res.write('data: ' + JSON.stringify({ id: 'fixture-completion', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\n')
      res.end('data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }))
    }
  } catch (error) { fixtureError = error; res.writeHead(500); res.end(String(error)) }
})
const mockPort = await listen(mock)
await writeFile(join(home, 'config', 'providers.json'), JSON.stringify({ active: 'fixture', providers: {
  fixture: { type: 'openai_compatible', display: 'Local fixture', api_key: 'fixture', base_url: `http://127.0.0.1:${mockPort}/v1`, model: 'deck-fixture', context_window: 262144, supports_native_tools: true },
  responses: { type: 'generic', tool_protocol: 'openai_responses', api_key: 'fixture', base_url: `http://127.0.0.1:${mockPort}/v1`, model: 'deck-fixture' },
} }))
for (const profile of ['codex', 'zcode']) {
  const directory = join(home, 'deck/cli/config', profile)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, profile === 'codex' ? 'config.toml' : 'provider_config.json'), profile === 'codex' ? '[projects.demo]\ntrust_level="trusted"\n' : JSON.stringify({schemaVersion:1,config:{providerConfigRules:{providerRules:[]},modelConfigRules:{providerModelRules:[],manualProviderModelRules:[]}}}))
}
const portProbe = createListener()
const port = await listen(portProbe)
await new Promise(resolve => portProbe.close(resolve))
const base = `http://127.0.0.1:${port}`
const api = async (path, body) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) })
  const value = await response.json()
  if (!response.ok) throw new Error(response.status + ': ' + JSON.stringify(value))
  return value
}
const enginePath = process.env.COOMI_DECK_ENGINE || resolve(repo, 'apps/coomi-rs/target/release/coomi.exe')
const log = createWriteStream(join(root, 'engine.log'))
let child
let socket
let task
let holdQuestion = true
let holdApproval = true
try {
  child = spawn(enginePath, ['serve', '--port', String(port), '--token', token, '--home', home, '--cwd', cwd, '--static-dir', join(repo, 'apps/desktop-ui-react/dist')], { windowsHide: true, env: {...process.env, PATH:bin+(process.platform==='win32'?';':':')+process.env.PATH} })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  let spawnError
  child.on('error', error => { spawnError = error })
  await until(async () => { if (spawnError) throw spawnError; try { return !!await api('/api/runtime/health') } catch { return false } }, 'engine startup')
  assert.equal((await fetch(base + '/api/deck/tasks')).status, 401, 'Deck inherits token authentication')
  task = await api('/api/deck/tasks', { title: 'Deck 集成验证', cwd })
  const action = body => api(`/api/deck/tasks/${task.id}/action`, body)
  const answered = new Set()
  const readCli = async terminal_id => {
    const result = await action({action:'read',terminal_id,after:0})
    // Windows ConPTY queries the initial cursor even for a Node/npm process.
    if (!result.exited && result.text.includes('\x1b[6n') && !answered.has(terminal_id)) {
      answered.add(terminal_id)
      await action({action:'reply',terminal_id,text:'\x1b[1;1R'})
    }
    return result
  }
  const session = await api('/api/sessions/' + task.session_id)
  assert.equal(session.title, task.title)
  assert.equal(session.cwd.toLowerCase(), cwd.toLowerCase())
  const work = await api('/api/sessions')
  assert.ok(!(work.sessions || []).some(item => item.id === task.session_id), 'Work excludes Deck sessions')
  for (const profile of ['codex', 'zcode']) {
    const provider_id = profile === 'codex' ? 'responses' : 'fixture'
    await action({action:'cli',operation:'configure',profile,provider_id,effort:'high'})
    assert.equal((await action({action:'cli',operation:'inspect',profile})).configuration.has_api_key,true)
    await action({action:'cli',operation:'configure',profile,provider_id,effort:''})
    const info=await action({action:'cli',operation:'inspect',profile})
    assert.equal(info.configuration.effort,null, 'default clears explicit effort')
    assert.equal(info.configuration.model,'deck-fixture')
    assert.ok(!JSON.stringify(info).includes('"api_key"'), 'inspect never returns credentials')
    const installation=await action({action:'cli',operation:'install',profile})
    await assert.rejects(action({action:'control',terminal_id:installation.terminal.id,ready:true}), /安装终端/)
    await until(async()=>{
      const output=await readCli(installation.terminal.id)
      return output.exited && output.text.includes('fixture package installed')
    },profile+' installation through ConPTY')
    assert.equal((await action({action:'cli',operation:'inspect',profile})).managed_install,true)
    await action({action:'close',terminal_id:installation.terminal.id})
    const started=await action({action:'cli',operation:'start',profile})
    await until(async()=>{await readCli(started.terminal.id);try{return await readFile(join(cwd,profile+'-started.txt'),'utf8')==='configured'}catch{return false}},profile+' reads its managed config')
    await action({action:'stop',terminal_id:started.terminal.id})
    assert.ok((await api('/api/deck/tasks')).tasks.find(item=>item.id===task.id).terminals.some(terminal=>terminal.id===started.terminal.id&&terminal.status==='closed'),'stop retains panel')
    await action({action:'close',terminal_id:started.terminal.id})
    assert.ok(!(await api('/api/deck/tasks')).tasks.find(item=>item.id===task.id).terminals.some(terminal=>terminal.id===started.terminal.id),'close releases panel')
  }
  // Close a live process and check persisted dismissal, separately from stopping.
  const live=await action({action:'cli',operation:'start',profile:'codex'})
  await action({action:'close',terminal_id:live.terminal.id})
  const stored=JSON.parse(await readFile(join(home,'deck/tasks.json'),'utf8'))
  assert.equal(stored[task.id].terminals.find(terminal=>terminal.id===live.terminal.id).dismissed,true)
  const terminal = await action({ action: 'start', profile: 'powershell' })
  terminalId = terminal.id
  let after = 0
  let output = ''
  const drain = async () => {
    const result = await action({ action: 'read', terminal_id: terminalId, after })
    after = result.next
    const text = Buffer.from(result.data, 'base64').toString('utf8')
    output += text
    if (text.includes('\x1b[6n')) await action({ action: 'reply', terminal_id: terminalId, text: '\x1b[1;1R' })
    return result
  }
  await until(async () => { await drain(); return output.includes('PS ') }, 'PowerShell prompt')
  await action({ action: 'resize', terminal_id: terminalId, rows: 25, cols: 110 })
  await action({ action: 'input', terminal_id: terminalId, text: "[IO.File]::WriteAllText('human.txt','human'); Write-Output '人工链路成功'\r" })
  await until(async () => { await drain(); try { return await readFile(join(cwd, 'human.txt'), 'utf8') === 'human' } catch { return false } }, 'human input')
  // Let the prompt finish redrawing before granting the fixture its input slot.
  await delay(300); await drain()
  // The agent must acquire this user-owned terminal through Work approval.
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws/session/${task.session_id}?token=${token}`)
  const events = []
  const onMessage = ({ data }) => {
    const frame = JSON.parse(data); const event=frame.payload || frame;events.push(event);
    if(event.event_type==='tool_approval_request'&&(!holdApproval||event.call_id!=='fixture-cli-deny')) send({command:'approve_tool',call_id:event.call_id,decision:event.call_id==='fixture-cli-deny'?'':'allow'});
    if(event.event_type==='user_question_request'&&!holdQuestion) send({command:'answer_question',call_id:event.call_id,answers:{[event.questions[0].id]:event.questions[0].options[0].value||event.questions[0].options[0].label||'运行测试'}});
  }
  socket.addEventListener('message', onMessage)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const send = payload => socket.send(JSON.stringify({ id: crypto.randomUUID(), payload }))
  send({ command: 'set_permission_mode', mode: 'ask' })
  send({ command: 'send_message', text: '读取任务状态，把本地验证目标派发给就绪 CLI，等待验收。', interject: false })
  const reopen = async () => {
    const closed=socket;closed.close();await new Promise(resolve=>closed.addEventListener('close',resolve,{once:true}));
    socket=new WebSocket(`ws://127.0.0.1:${port}/ws/session/${task.session_id}?token=${token}`);
    socket.addEventListener('message',onMessage);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})});
    send({command:'set_permission_mode',mode:'ask'});
  }
  await until(()=>events.some(event=>event.event_type==='user_question_request'),'Work question')
  const question=events.find(event=>event.event_type==='user_question_request')
  send({command:'ack',seq:question.event_seq});await delay(150)
  await reopen()
  await until(()=>events.filter(event=>event.event_type==='user_question_request').length>=2,'acknowledged question restores on reopen')
  holdQuestion=false
  send({command:'answer_question',call_id:question.call_id,answers:{[question.questions[0].id]:'运行测试'}})
  await until(()=>events.some(event=>event.event_type==='tool_approval_request'&&event.call_id==='fixture-cli-deny'),'Work approval')
  const approval=events.find(event=>event.event_type==='tool_approval_request'&&event.call_id==='fixture-cli-deny')
  send({command:'ack',seq:approval.event_seq});await delay(150)
  await reopen()
  await until(()=>events.filter(event=>event.event_type==='tool_approval_request'&&event.call_id==='fixture-cli-deny').length>=2,'acknowledged approval restores on reopen')
  holdApproval=false
  send({command:'approve_tool',call_id:approval.call_id,decision:''})
  await until(async () => { await drain(); if (fixtureError) throw fixtureError; const error = events.find(event => event.event_type === 'agent_error' || event.type === 'error'); if (error) throw new Error(JSON.stringify(error)); try { return (await readFile(join(cwd, 'coordinator.txt'), 'utf8')).startsWith('dispatched') } catch { return false } }, 'Coomi tool dispatch', 60000)
  await until(() => events.some(event => event.event_type === 'turn_end'), 'coordinator response')
  const updated = (await api('/api/deck/tasks')).tasks.find(item => item.id === task.id)
  assert.equal(updated.terminals[0].coomi_ready, true, 'dispatch preserves permanent control')
  assert.equal(updated.dispatches.length, 3)
  assert.equal(updated.dispatches[0].status, 'submitted')
  await until(async()=>{await drain();try{return await readFile(join(cwd,'coordinator-again.txt'),'utf8')==='dispatched again'}catch{return false}},'second dispatch without another handover')
  await assert.rejects(action({action:'input',terminal_id:terminalId,text:'human-blocked\r'}), /Coomi.*控制/)
  for (const text of ['\x1b[?1u','\x1b[?2026;1$y','\x1b[4;600;800t','\x1b]10;rgb:ffff/ffff/ffff\x1b\\','\x1bP1$r0m\x1b\\','\x1b[I','\x1b[O']) {
    await action({action:'reply',terminal_id:terminalId,text})
    assert.equal((await api('/api/deck/tasks')).tasks.find(item=>item.id===task.id).terminals[0].coomi_ready,true,'protocol reply cannot release input')
  }
  assert.ok(requests.length >= 7, 'Work read → question → Deck status → denied configure → approved configure → dispatch → final')
  assert.ok(requests.at(-1).toolMessages.some(message=>String(message.content).includes('Work tools are available in Deck')))
  assert.ok(requests.at(-1).toolMessages.some(message=>message.tool_call_id==='fixture-cli-deny'&&String(message.content).includes('not approved')))
  assert.equal(new Set(events.filter(event=>event.event_type==='tool_approval_request').map(event=>event.call_id)).size,3,'configuration and one takeover approval; repeated acquire and input need no extra prompts')
  assert.equal(new Set(events.filter(event=>event.event_type==='user_question_request').map(event=>event.call_id)).size,1,'original Work question channel')
  assert.ok(requests.at(-1).toolMessages.some(message => String(message.content).includes('submitted')))
  assert.equal(await readFile(join(cwd,'coordinator.txt'),'utf8'),'dispatcheddispatched','same arguments with a new call ID must execute twice');
  const workMessages=requests.at(-1).toolMessages;
  const statusValue=id=>JSON.parse(workMessages.find(message=>message.tool_call_id===id).content.replace(/^success:\s*/,''));
  assert.equal(statusValue('fixture-status').panel_info[0].owner,'user');
  assert.equal(statusValue('fixture-owned-status').panel_info[0].owner,'coomi','status must see the new owner within the same turn');
  assert.equal(statusValue('fixture-owned-status').panel_info[0].terminal_id,terminalId);
  assert.equal(statusValue('fixture-owned-status').cli_output[0].terminal_id,terminalId);
  assert.ok(statusValue('fixture-wait').settled,'wait should return after terminal output settles');
  // Verify the original Work approval channel is the single CLI handover.
  for (const mode of ['ask','auto','full']) {
    phase=mode
    const eventStart=events.length
    const before=(await api('/api/deck/tasks')).tasks.find(item=>item.id===task.id).terminals.map(item=>item.id)
    send({command:'set_permission_mode',mode})
    send({command:'send_message',text:'启动一个 CLI 并交给 Coomi 控制：'+mode})
    await until(()=>events.slice(eventStart).some(event=>event.event_type==='turn_end'),mode+' CLI start',60000)
    const launchEvents=events.slice(eventStart).filter(event=>event.event_type==='tool_approval_request')
    assert.equal(launchEvents.length,mode==='ask'?1:0,mode+' startup asks once or auto-allows')
    if(mode==='ask') assert.ok(launchEvents[0].risk_summary.includes('持续控制'))
    const launched=(await api('/api/deck/tasks')).tasks.find(item=>item.id===task.id).terminals.find(item=>!before.includes(item.id))
    assert.ok(launched?.coomi_ready,mode+' starts with persistent Coomi ownership')
    assert.equal(launched.full_access,mode==='full')
    await until(async()=>{await readCli(launched.id);try{const args=JSON.parse(await readFile(join(cwd,(mode==='full'?'zcode':'codex')+'-argv.json'),'utf8'));return mode==='full'?args.includes('yolo'):!args.includes('--dangerously-bypass-approvals-and-sandbox')}catch{return false}},mode+' native approval launch arguments')
    await until(async()=>{await readCli(launched.id);try{return (await readFile(join(cwd,(mode==='full'?'zcode':'codex')+'-input.txt'),'utf8')).includes('accepted-'+mode)}catch{return false}},mode+' Coomi responds to CLI without repeated approval')
    await assert.rejects(action({action:'input',terminal_id:launched.id,text:'blocked'}),/Coomi.*控制/)
    await action({action:'control',terminal_id:launched.id,ready:false})
    await action({action:'input',terminal_id:launched.id,text:'manual after release\r'})
    assert.equal((await api('/api/deck/tasks')).tasks.find(item=>item.id===task.id).terminals.find(item=>item.id===launched.id).coomi_ready,false,'only explicit release changes the owner')
    await action({action:'close',terminal_id:launched.id})
  }
  // UI/API starts in full mode use the same native launch policy and owner lock.
  const fullCodex=await action({action:'start',profile:'codex'})
  assert.equal(fullCodex.coomi_ready,true)
  assert.equal(fullCodex.full_access,true)
  await until(async()=>{await readCli(fullCodex.id);try{return JSON.parse(await readFile(join(cwd,'codex-argv.json'),'utf8')).includes('--dangerously-bypass-approvals-and-sandbox')}catch{return false}},'full Codex native approvals')
  await action({action:'close',terminal_id:fullCodex.id})
  const transcript=await api('/api/sessions/'+task.session_id)
  const user=transcript.messages.find(message=>message.role==='user')
  const branch=await api('/api/sessions/'+task.session_id+'/branch',{atMsgId:user.id})
  assert.ok(branch.deck_task && branch.deck_task.session_id===branch.id,'branch remains a Deck task')
  assert.deepEqual(branch.deck_task.terminals,[],'branch cannot inherit live terminals or grants')
  const listing=await api('/api/sessions')
  assert.ok(!listing.sessions.some(item=>item.id===branch.id))
  assert.ok(listing.deck_sessions.some(item=>item.id===branch.id),'shared Store receives Deck model/runtime metadata')
  const branchCwd=join(root,'branch-cwd');await mkdir(branchCwd)
  await api('/api/sessions/'+branch.id+'/cwd',{cwd:branchCwd})
  assert.equal((await api('/api/deck/tasks')).tasks.find(item=>item.id===branch.deck_task.id).cwd,branchCwd,'Work cwd control updates task binding')
  await action({ action: 'finish' })
  await until(async () => (await drain()).exited, 'terminal close drains output')
  assert.ok(output.includes('人工链路成功') && output.includes('调度链路成功'))
  assert.equal((await api('/api/deck/tasks')).tasks.find(item => item.id === task.id).status, 'completed')
  await writeFile(join(root, 'report.json'), JSON.stringify({ passed: true, task: task.id, session: task.session_id, requests: requests.length, assertions: 'original Work tool/approval/question channels, reconnect recovery, ask startup approves exactly once, auto/full no startup approval, native Codex/ZCode full-access argv, persistent ownership across repeated dispatch/poll/reply, backend blocks human input until explicit release, API full-mode ownership, configuration/isolation/ConPTY/branch/archive regression' }, null, 2))
  console.log('Deck real engine integration passed. Evidence: ' + root)
} finally {
  socket?.close()
  if (child && child.exitCode === null) {
    if (task) { try { await api(`/api/deck/tasks/${task.id}/action`, { action: 'finish' }) } catch { /* engine may already be stopped */ } }
    child.kill()
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 5000).unref() } })
  }
  log.end()
  await new Promise(resolve => mock.close(resolve))
}
