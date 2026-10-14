/** Deck interaction review. Uses isolated stores and terminal fixtures, no model API. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const output = new URL('../../../.tmp/deck-review/', import.meta.url)
await mkdir(output, { recursive: true })
const browserPort = process.env.COOMI_REVIEW_PORT || '9338'
const target = await (await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: 'PUT' })).json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
let sequence = 0
const pending = new Map()
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  const request = pending.get(message.id)
  if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result) }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async expression => {
  for (let i = 0; i < 300; i++) { if (await evaluate(`Boolean(${expression})`)) return; await wait(100) }
  throw new Error('Not ready: ' + expression)
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
const resize = async (width, height) => { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await wait(500) }
const shot = async name => {
  await evaluate('document.fonts.ready')
  await wait(350)
  const result = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(new URL(name + '.png', output), Buffer.from(result.data, 'base64'))
}
try {
  await send('Page.enable')
  await send('Runtime.enable')
  await resize(1920, 1080)
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.clear();
    localStorage.setItem('coomi.onboarding.v1', JSON.stringify({version:2,acceptedAt:'2026-10-13'}));
    localStorage.setItem('coomi.mode','work');
    localStorage.setItem('coomi.prefs.v2', JSON.stringify({motion:false,fontFamily:'harmony'}));
  ` })
  await send('Page.navigate', { url: 'http://127.0.0.1:5273/' })
  await until(`!!document.querySelector('.welcome-title')`)
  await evaluate(`(async () => {
    const loaded = file => performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/stores/'+file+'.ts')?.name || '/src/stores/'+file+'.ts';
    const {useDeck} = await import(loaded('deck'));
    const {useEngine} = await import(loaded('engine'));
    const {useSession} = await import(loaded('session'));
    const {useUi} = await import(loaded('ui'));
    const {useChatSearch} = await import(loaded('chatSearch'));
    window.review = {useDeck,useEngine,useSession,useUi,useChatSearch};
    window.actions = [];
    window.fixtureSockets = [];
    window.WebSocket = class extends EventTarget {
      static OPEN = 1; readyState = 0;
      constructor(url) { super(); this.url=url; fixtureSockets.push(this); setTimeout(()=>{if(this.readyState===3)return;this.readyState=1; const event=new Event('open');this.dispatchEvent(event);this.onopen?.(event)},30) }
      send(text) { this.sent ||= []; this.sent.push(JSON.parse(text)); }
      close() { this.readyState=3; }
      emit(payload) { this.onmessage?.({data:JSON.stringify({payload})}); }
    };
    window.fixtureExited = false;
    window.fixtureCli={codex:{installed:true,source:'OpenAI Codex',node_available:true,npm_available:true,configuration:{managed:false}},zcode:{installed:false,source:'ZCode 社区终端客户端',node_available:true,npm_available:true,configuration:{managed:false}}};
    window.fixtureTasks = [
      {id:'task-a',title:'重构接口并验证兼容性',cwd:'F:/Projects/demo',session_id:'deck-session-a',status:'active',created_at:2,dispatches:[],terminals:['codex','zcode','powershell'].map((profile,index)=>({id:'terminal-'+index,number:index+1,profile,status:'running',coomi_ready:false}))},
      {id:'task-b',title:'整理发布文档',cwd:'F:/Projects/docs',session_id:'deck-session-b',status:'active',created_at:1,dispatches:[],terminals:[{id:'history-terminal',number:1,profile:'powershell',status:'interrupted',coomi_ready:false}]},
    ];
    const sessions=[{id:'work-session',title:'Work 中保留的会话',updated_at:Date.now(),cwd:'F:/Projects/work'}];
    window.fixtureHistory={};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedText=text},readText:async()=>window.copiedText||''}});
    useSession.setState({sessionId:'work-session',sessionSurface:'work',sessions,messages:[],connected:true,connecting:false,loadSessions:async()=>{},currentModel:'Fixture',historyLoaded:{'work-session':true}});
    useEngine.setState({ready:true,status:'running',cwd:'F:/Projects/demo',api:async(path,init)=>{
      if (path==='/api/deck/tasks') {
        const snapshot={tasks:structuredClone(window.fixtureTasks)};
        if(window.fixtureSnapshotDelay) { window.fixtureSnapshotDelay=false; return await new Promise(resolve=>{window.completeSnapshot=()=>resolve(snapshot)}); }
        return snapshot;
      }
      if (path.includes('/api/deck/') && path.endsWith('/action')) {
        const body=JSON.parse(init.body); actions.push(body);
        if(body.action==='cli') {
          if(body.operation==='inspect') return structuredClone(fixtureCli[body.profile]);
          if(body.operation==='configure') { fixtureCli[body.profile].configuration={managed:true,base_url:body.base_url,model:body.model,protocol:body.protocol,has_api_key:!!body.api_key};return {ok:true}; }
          const terminal={id:'managed-install',profile:'install-'+body.profile,status:'running',coomi_ready:false};fixtureTasks.find(task=>path.includes(task.id)).terminals.push(terminal);return {terminal};
        }
        if(body.action==='close') fixtureTasks.forEach(task=>task.terminals=task.terminals.filter(terminal=>terminal.id!==body.terminal_id));
        if(body.action==='control') {
          const apply=()=>{fixtureTasks.forEach(task=>task.terminals.forEach(terminal=>{if(terminal.id===body.terminal_id)terminal.coomi_ready=body.ready}));return {ok:true,coomi_ready:body.ready}};
          if(body.ready&&window.fixtureGrantDelay) return await new Promise(resolve=>{window.completeGrant=()=>resolve(apply())});
          return apply();
        }
        if(body.action==='read') {
          const text=body.terminal_id==='history-terminal' ? 'PS F:/Projects/docs> 已保留的终端日志\\r\\n' : '\\x1b[32m'+(body.terminal_id==='terminal-0'?'Codex':body.terminal_id==='terminal-1'?'ZCode':'PowerShell')+'\\x1b[0m\\r\\nF:/Projects/demo\\r\\n\\r\\n› '+(body.terminal_id==='terminal-0'?'分析接口与验收条件':body.terminal_id==='terminal-1'?'准备独立检查兼容性':'等待输入')+'\\r\\n';
          const bytes=new TextEncoder().encode(text);
          return {data:body.after? '':btoa(String.fromCharCode(...bytes)),next:bytes.length,reset:false,exited:body.terminal_id==='history-terminal'||window.fixtureExited};
        }
        return {ok:true};
      }
      if(path.includes('providers')) return {providers:[{id:'fixture',name:'测试模型',model:'Fixture',models:['Fixture'],active:true}],models:[]};
      if(path.includes('sessions')) {
        const sid=path.split('/')[3];
        if(path.endsWith('/branch')) {
          const branch={...structuredClone(fixtureTasks.find(task=>task.session_id===sid)),id:'task-branch',session_id:'deck-branch',title:'任务 · 分支',terminals:[],dispatches:[]};
          fixtureTasks.push(branch);fixtureHistory['deck-branch']=structuredClone(fixtureHistory[sid]||[]);
          return {id:branch.session_id,deck_task:branch};
        }
        if(path.endsWith('/truncate')) {window.truncations||=[];truncations.push(path);fixtureHistory[sid]=[];return {ok:true};}
        return path.endsWith('/context')?{context_window:262144,used_tokens:0}:path==='/api/sessions'?{sessions}:{messages:fixtureHistory[sid]||[],cwd:fixtureTasks.find(task=>task.session_id===sid)?.cwd||'F:/Projects/work',provider_id:'fixture',model:'Fixture'};
      }
      return {views:[],skills:[],entries:[],tasks:[],runtimes:[],mcp:[]};
    }});
    useDeck.setState({tasks:structuredClone(window.fixtureTasks),selected:'task-a'});
    useSession.getState().setDraft('Work 独立草稿');
    useSession.getState().addAttachments(['F:/Projects/work/note.md']);
  })()`)
  await click('.mode-switch')
  await until(`document.querySelectorAll('.deck-terminal').length===3`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.deck-terminal-number')].map(element=>element.textContent)`), ['#01', '#02', '#03'], 'each terminal shows its stable task-local number')
  const firstTerminalId = await evaluate(`document.querySelector('.deck-terminal').dataset.terminalId`)
  await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedTerminalId=text;window.copiedText=text},readText:async()=>window.copiedText||''}});document.querySelector('[aria-label="复制终端 #1 编号和 ID"]').click()`)
  await until(`window.__copiedTerminalId===${JSON.stringify('#01 · '+firstTerminalId)}`)
  assert.equal(await evaluate(`document.querySelector('[data-nav-key="chat"]').textContent`), '任务')
  await until(`review.useSession.getState().sessionId==='deck-session-a'&&review.useSession.getState().connected`)
  assert.equal(await evaluate(`fixtureSockets.filter(socket=>socket.readyState===1&&socket.url.includes('/ws/session/')).length`),1,'one shared foreground session socket')
  assert.equal(await evaluate(`new Set([...document.querySelectorAll('.deck-terminal')].filter(e=>e.offsetWidth).map(e=>Math.round(e.getBoundingClientRect().top))).size`), 1)
  await until(`document.querySelector('.deck-coordinator [aria-label="消息输入框"]')&&!document.querySelector('.deck-coordinator [aria-label="消息输入框"]').disabled`)
  await evaluate(`window.deckSocket=fixtureSockets.findLast(socket=>socket.readyState===1&&socket.url.includes('deck-session-a'));deckSocket.emit({event_type:'reasoning_chunk',text:'正在检查 CLI 环境与任务目标'});deckSocket.emit({event_type:'tool_start',call_id:'inspect-test',tool_name:'deck_cli',arguments:{operation:'inspect',profile:'codex'}})`)
  await until(`document.querySelector('[data-deck-summary]')?.textContent.includes('deck_cli')`)
  await evaluate(`deckSocket.emit({event_type:'reasoning_chunk',text:'，确认安装状态'});deckSocket.emit({event_type:'text_chunk',text:'已读取终端状态，准备调度。'})`)
  assert.equal(await evaluate(`document.querySelector('.deck-coordinator [data-chat-body]').getBoundingClientRect().height`),0,'collapsed waterfall takes no space');
  assert.ok(await evaluate(`document.querySelector('[data-deck-summary]').getBoundingClientRect().height<30`),'exactly one summary row');
  await shot('coordinator-single-line');
  await click('[title="半屏调度记录"]');
  await until(`document.querySelector('.deck-coordinator').dataset.layout==='half'`);
  const contentSizes = await evaluate(`(()=>{const message=document.querySelector('.deck-coordinator .workbench-msg').getBoundingClientRect();const input=document.querySelector('.deck-coordinator [data-composer-box]').getBoundingClientRect();const stage=document.querySelector('.deck-stage').getBoundingClientRect();return {message:message.width,input:input.width,left:input.left-stage.left,right:stage.right-input.right}})()`)
  assert.ok(Math.abs(contentSizes.message-contentSizes.input)<2, 'message and composer share width')
  assert.ok(contentSizes.left>=24&&contentSizes.right>=24, 'composer has Work-style side margins')
  await until(`document.querySelector('.deck-coordinator').dataset.layout==='half'`)
  const halfRatio=await evaluate(`document.querySelector('.deck-coordinator').clientHeight/document.querySelector('.deck-stage').clientHeight`)
  assert.ok(halfRatio>.6&&halfRatio<.7)
  assert.ok(await evaluate(`document.querySelector('.deck-coordinator [data-msg-scroller]').textContent.includes('确认安装状态')`), 'expanded reasoning is retained')
  await shot('coordinator-half')
  await click('[title="全屏调度记录"]')
  await until(`document.querySelector('.deck-coordinator').dataset.layout==='full'`)
  assert.ok(await evaluate(`document.querySelector('.deck-coordinator').clientHeight>=document.querySelector('.deck-stage').clientHeight-2`), 'full overlay covers terminal conversation')
  await shot('coordinator-full')
  // The coordinator renders and operates on the original Work transcript and controls.
  await evaluate(`(async()=>{
    fixtureHistory['deck-session-a']=[{id:'user-review',role:'user',content:'请验证接口',created_at:Date.now()},{id:'assistant-review',role:'assistant',content:'接口检查完成，等待验收。',created_at:Date.now()}];
    deckSocket.emit({event_type:'turn_end'});
    await review.useSession.getState().loadHistory('deck-session-a',{replace:true});
    review.useSession.setState({streaming:false,runState:'idle'});
  })()`)
  await until(`document.querySelector('.workbench-msg-assistant button')`)
  const messageAction=async(label,kind='assistant')=>evaluate(`[...document.querySelector('.deck-coordinator .workbench-msg-${kind}').querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(label)}).click()`)
  await messageAction('复制')
  assert.equal(await evaluate(`window.copiedText`),'接口检查完成，等待验收。')
  await messageAction('引用')
  assert.equal(await evaluate(`review.useSession.getState().quotes[0].msgId`),'assistant-review')
  await messageAction('不错')
  assert.ok(await evaluate(`JSON.parse(localStorage.getItem('coomi.feedback.v1')).some(item=>item.good&&item.text==='接口检查完成，等待验收。')`),'original Work feedback storage')
  await shot('shared-message-actions')
  await click('.deck-coordinator [aria-label="展开右侧栏"]')
  await until(`review.useUi.getState().panelOpen&&document.querySelector('[data-dock-root]').clientWidth>100`)
  await click('.deck-coordinator [aria-label="收起右侧栏"]')
  await until(`!review.useUi.getState().panelOpen&&document.querySelector('[data-dock-root]').clientWidth<=42`)
  await click('[title="收起调度记录"]')
  await evaluate(`deckSocket.emit({event_type:'tool_approval_request',call_id:'deny-review',tool_name:'deck_cli',risk_summary:'修改 CLI 模型配置'})`)
  await until(`document.querySelector('[role="dialog"]')?.textContent.includes('需要你的授权')`)
  await evaluate(`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button=>button.textContent==='拒绝').click()`)
  assert.ok(await evaluate(`deckSocket.sent.some(frame=>frame.payload.command==='approve_tool'&&frame.payload.call_id==='deny-review'&&frame.payload.decision==='')`))
  await evaluate(`deckSocket.emit({event_type:'tool_approval_request',call_id:'allow-review',tool_name:'deck_dispatch',risk_summary:'派发任务指令'})`)
  await until(`document.querySelector('[role="dialog"]')?.textContent.includes('需要你的授权')`)
  await evaluate(`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button=>button.textContent==='允许一次').click()`)
  assert.ok(await evaluate(`deckSocket.sent.some(frame=>frame.payload.command==='approve_tool'&&frame.payload.call_id==='allow-review'&&frame.payload.decision==='allow')`))
  await evaluate(`deckSocket.emit({event_type:'user_question_request',call_id:'question-review',questions:[{id:'acceptance',header:'验收',question:'选择验收方式',options:[{value:'tests',label:'运行测试'},{value:'manual',label:'人工检查'}]}]})`)
  await until(`document.querySelector('.deck-coordinator').dataset.layout==='half'&&document.querySelector('[data-ask-submit]')`)
  await click('[data-ask-option="tests"]')
  await click('[data-ask-submit]')
  await evaluate(`deckSocket.emit({event_type:'user_question_request',call_id:'question-review',questions:[{id:'acceptance',question:'选择验收方式',options:[{value:'tests',label:'运行测试'}]}]})`)
  assert.equal(await evaluate(`document.querySelectorAll('[data-ask-card="question-review"]').length`),1,'replay never duplicates the question card')
  assert.equal(await evaluate(`review.useSession.getState().question`),null,'replayed answered questions never suspend the session again')
  assert.ok(await evaluate(`deckSocket.sent.some(frame=>frame.payload.command==='answer_question'&&frame.payload.answers.acceptance==='tests')`))
  assert.ok(await evaluate(`document.querySelector('[data-ask-card="question-review"]').dataset.askAnswered==='1'`),'answered card remains in transcript')
  await shot('shared-question-card')
  await evaluate(`deckSocket.emit({event_type:'user_question_request',call_id:'question-skip',questions:[{id:'skip',question:'可选补充',options:[]}]})`)
  await until(`document.querySelector('[data-ask-card="question-skip"] [data-ask-skip]')`)
  await click('[data-ask-card="question-skip"] [data-ask-skip]')
  assert.ok(await evaluate(`deckSocket.sent.some(frame=>frame.payload.command==='answer_question'&&frame.payload.call_id==='question-skip'&&Object.keys(frame.payload.answers).length===0)`))
  await messageAction('编辑重发','user')
  await until(`document.querySelector('[role="dialog"] textarea')`)
  await evaluate(`(()=>{const el=document.querySelector('[role="dialog"] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'重新验证接口');el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await evaluate(`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button=>button.textContent==='重新发送').click()`)
  await until(`deckSocket.sent.some(frame=>frame.payload.command==='send_message'&&frame.payload.text==='重新验证接口')`)
  assert.ok(await evaluate(`truncations.some(path=>path.includes('deck-session-a/messages/user-review/truncate'))`),'edit uses original Work truncation')
  await evaluate(`(async()=>{fixtureHistory['deck-session-a']=[{id:'user-review',role:'user',content:'请验证接口'},{id:'assistant-review',role:'assistant',content:'接口检查完成，等待验收。'}];await review.useSession.getState().loadHistory('deck-session-a',{replace:true});review.useSession.setState({streaming:false,runState:'idle'})})()`)
  await messageAction('重新生成')
  await until(`truncations.filter(path=>path.includes('/user-review/truncate')).length===2`)
  await evaluate(`(async()=>{fixtureHistory['deck-session-a']=[{id:'user-review',role:'user',content:'请验证接口'},{id:'assistant-review',role:'assistant',content:'接口检查完成，等待验收。'}];await review.useSession.getState().loadHistory('deck-session-a',{replace:true});review.useSession.setState({streaming:false,runState:'idle'})})()`)
  await messageAction('分支')
  await until(`review.useDeck.getState().selected==='task-branch'&&review.useSession.getState().sessionId==='deck-branch'`)
  assert.equal(await evaluate(`review.useSession.getState().sessionSurface`),'deck')
  await evaluate(`review.useDeck.getState().select('task-a')`)
  await until(`review.useSession.getState().sessionId==='deck-session-a'&&review.useSession.getState().connected`)
  await evaluate(`window.deckSocket=fixtureSockets.findLast(socket=>socket.readyState===1&&socket.url.includes('deck-session-a'));review.useSession.getState().setDraft('任务 A 的草稿');review.useSession.getState().addAttachments(['F:/Projects/demo/spec.md']);deckSocket.emit({event_type:'tool_approval_request',call_id:'pending-review',tool_name:'deck_cli',risk_summary:'仅属于任务 A'});review.useDeck.getState().select('task-b')`)
  await until(`review.useSession.getState().sessionId==='deck-session-b'&&review.useSession.getState().connected`)
  assert.equal(await evaluate(`review.useSession.getState().approval`),null,'pending approval cannot leak across tasks')
  assert.equal(await evaluate(`review.useSession.getState().draft`),'')
  assert.equal(await evaluate(`review.useSession.getState().attachments.length`),0)
  await evaluate(`review.useSession.getState().setDraft('任务 B 的草稿');review.useDeck.getState().select('task-a')`)
  await until(`review.useSession.getState().sessionId==='deck-session-a'&&review.useSession.getState().connected`)
  assert.equal(await evaluate(`review.useSession.getState().draft`),'任务 A 的草稿')
  assert.equal(await evaluate(`review.useSession.getState().attachments[0].path`),'F:/Projects/demo/spec.md')
  assert.equal(await evaluate(`fixtureSockets.filter(socket=>socket.readyState===1&&socket.url.includes('/ws/session/')).length`),1)
  await click('[title="收起调度记录"]')
  await until(`document.querySelector('.deck-coordinator').dataset.layout==='compact'`)
  await until(`document.querySelector('.deck-coordinator [data-composer-box]').getBoundingClientRect().bottom<=document.querySelector('.deck-coordinator').getBoundingClientRect().bottom-8`)
  assert.ok(await evaluate(`document.querySelector('.deck-coordinator [data-composer-box]').getBoundingClientRect().height>80`),'full input with attachments/queue stays visible in compact mode')
  await evaluate(`window.savedXterm=document.querySelector('.xterm');review.useUi.getState().setPrefs({terminalTheme:'dark'})`)
  await until(`document.querySelector('.deck-terminal').dataset.terminalTheme==='dark'`)
  await shot('terminal-dark')
  await evaluate(`review.useUi.getState().setPrefs({terminalTheme:'light'})`)
  await until(`document.querySelector('.deck-terminal').dataset.terminalTheme==='light'`)
  assert.equal(await evaluate(`window.savedXterm===document.querySelector('.xterm')`), true, 'theme change preserves terminal state')
  await evaluate(`review.useUi.getState().setPrefs({terminalTheme:'interface'});review.useUi.getState().setThemeMode('dark')`)
  await until(`document.querySelector('.deck-terminal').dataset.terminalTheme==='dark'`)
  await evaluate(`review.useUi.getState().setThemeMode('light')`)
  await until(`document.querySelector('.deck-terminal').dataset.terminalTheme==='light'`)
  await shot('wide-three-terminals')
  await click('[title="最大化终端"]')
  await until(`!!document.querySelector('[data-maximized="true"]')`)
  await click('[title="恢复多列"]')
  await until(`!!document.querySelector('[data-maximized="false"]')`)
  await resize(1280, 900)
  await until(`[...document.querySelectorAll('.deck-terminal')].filter(e=>e.offsetWidth).length===2`)
  await shot('medium-two-terminals')
  await resize(740, 800)
  await until(`[...document.querySelectorAll('.deck-terminal')].filter(e=>e.offsetWidth).length===1`)
  assert.equal(await evaluate(`window.savedXterm===document.querySelector('.xterm')`), true, 'resize and pagination preserve terminal screen')
  await click('[title="刷新终端显示"]')
  await until(`actions.some(action=>action.action==='resize'&&action.repaint===true)`)
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`), true)
  await shot('narrow-one-terminal')
  await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type:'keyDown', key:'f', code:'KeyF', windowsVirtualKeyCode:70, nativeVirtualKeyCode:70, modifiers:2 })
  await send('Input.dispatchKeyEvent', { type:'keyUp', key:'f', code:'KeyF', windowsVirtualKeyCode:70, nativeVirtualKeyCode:70, modifiers:2 })
  assert.equal(await evaluate(`review.useChatSearch.getState().open`),false,'CLI Ctrl+F stays in terminal')
  await send('Input.dispatchKeyEvent', { type:'keyDown', key:'k', code:'KeyK', windowsVirtualKeyCode:75, nativeVirtualKeyCode:75, modifiers:2 })
  await send('Input.dispatchKeyEvent', { type:'keyUp', key:'k', code:'KeyK', windowsVirtualKeyCode:75, nativeVirtualKeyCode:75, modifiers:2 })
  await wait(250)
  assert.equal(await evaluate(`!!document.querySelector('[role="dialog"]')`), false, 'CLI Ctrl+K stays in terminal')
  assert.ok(await evaluate(`actions.some(action=>action.action==='input'&&action.text==='\\x0b')`), 'terminal receives Ctrl+K')
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`)
  await until(`!!document.querySelector('[role="dialog"]')`)
  assert.ok(await evaluate(`document.querySelector('[role="dialog"]').textContent.includes('新建任务')&&document.querySelector('[role="dialog"]').textContent.includes('切换任务')`), 'Deck command palette uses tasks')
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await until(`!document.querySelector('[role="dialog"]')`)
  await evaluate(`window.fixtureGrantDelay=true;document.querySelector('[title="交给 Coomi"]').click()`)
  await until(`!!document.querySelector('[role="dialog"]')`)
  await evaluate(`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button=>button.textContent==='交给 Coomi').click()`)
  await until(`typeof window.completeGrant==='function'`)
  await evaluate(`window.fixtureSnapshotDelay=true;void review.useDeck.getState().refresh()`)
  await until(`typeof window.completeSnapshot==='function'`)
  await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`)
  await send('Input.insertText',{text:'human-after-grant'})
  await wait(200)
  assert.equal(await evaluate(`actions.some(action=>action.action==='input'&&action.text==='human-after-grant')`), false, 'human input is blocked during pending handover')
  await evaluate(`window.completeGrant()`)
  await until(`document.querySelector('[data-terminal-id="terminal-0"]').dataset.coomiOwned==='true'`)
  await evaluate(`window.completeSnapshot()`)
  await evaluate(`review.useDeck.getState().refresh()`)
  await wait(400)
  assert.equal(await evaluate(`document.querySelector('[data-terminal-id="terminal-0"] .xterm-helper-textarea').readOnly`),true,'owned terminal is read only for users')
  assert.equal(await evaluate(`document.querySelector('[data-terminal-id="terminal-0"]').dataset.coomiOwned`),'true','late pre-grant task snapshot cannot revoke the new owner')
  await send('Input.insertText',{text:'human-while-owned'})
  await wait(200)
  assert.equal(await evaluate(`actions.some(action=>action.action==='input'&&action.text.includes('human-'))`), false, 'handover and owned input never reach CLI')
  await click('[data-terminal-id="terminal-0"] [title="解除 Coomi 控制"]')
  await until(`document.querySelector('[data-terminal-id="terminal-0"]').dataset.coomiOwned==='false'`)
  await evaluate(`document.querySelector('[data-terminal-id="terminal-0"] .xterm-helper-textarea').focus()`)
  await send('Input.insertText',{text:'manual-after-release'})
  await until(`actions.some(action=>action.action==='input'&&action.text==='manual-after-release')`)
  await click('[data-terminal-id="terminal-0"] [title="关闭终端"]')
  await until(`!!document.querySelector('[role="dialog"]')`)
  await evaluate(`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button=>button.textContent==='取消').click()`)
  assert.equal(await evaluate(`actions.some(action=>action.action==='close')`), false, 'cancel preserves the running terminal')
  await click('[data-terminal-id="terminal-0"] [title="最大化终端"]')
  await click('[data-terminal-id="terminal-0"] [title="关闭终端"]')
  await until(`!!document.querySelector('[role="dialog"]')`)
  await evaluate(`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button=>button.textContent==='确定').click()`)
  await until(`!document.querySelector('[data-terminal-id="terminal-0"]')`)
  assert.ok(await evaluate(`document.querySelector('[data-terminal-id="terminal-1"]').offsetWidth>0`), 'closing a maximized terminal restores the remaining terminal')
  assert.equal(await evaluate(`actions.filter(action=>action.action==='close').length`), 1)
  await evaluate(`window.savedTerminal=document.querySelector('.xterm'); window.fixtureExited=true; fixtureTasks[0].terminals.forEach(terminal=>terminal.status='exited'); review.useDeck.getState().refresh()`)
  await wait(700)
  assert.equal(await evaluate(`window.savedTerminal===document.querySelector('.xterm')`), true, 'exit preserves terminal output')
  await evaluate(`review.useDeck.getState().select('task-b')`)
  await until(`!!document.querySelector('[data-terminal-id="history-terminal"] .xterm')`)
  await wait(400)
  assert.ok(await evaluate(`actions.some(action=>action.action==='read'&&action.terminal_id==='history-terminal')`), 'interrupted terminal reads its saved log')
  await shot('restored-terminal-history')
  assert.equal(await evaluate(`actions.filter(action=>action.action==='close').length`), 1, 'switching tasks never closes PTYs')
  await evaluate(`review.useDeck.getState().select('task-a')`)
  await until(`document.querySelector('[data-terminal-id="terminal-1"]').offsetWidth>0`)
  assert.equal(await evaluate(`window.savedTerminal===document.querySelector('[data-terminal-id="terminal-1"] .xterm')`), true, 'task switch preserves xterm screen')
  await click('[data-terminal-id="terminal-1"] [title="关闭终端"]')
  await until(`!document.querySelector('[data-terminal-id="terminal-1"]')`)
  assert.equal(await evaluate(`!!document.querySelector('[role="dialog"]')`), false, 'stopped terminal closes without confirmation')
  await evaluate(`review.useDeck.getState().select('task-b')`)
  await click('.mode-switch')
  await until(`document.querySelector('[data-nav-key="chat"]').textContent==='会话'`)
  assert.equal(await evaluate(`review.useSession.getState().sessionId`), 'work-session')
  assert.equal(await evaluate(`review.useSession.getState().draft`),'Work 独立草稿')
  assert.equal(await evaluate(`review.useSession.getState().attachments[0].path`),'F:/Projects/work/note.md')
  assert.equal(await evaluate(`document.querySelector('[data-nav-key="chat"]').textContent`), '会话')
  await shot('work-restored')
  await click('.mode-switch')
  await until(`!!document.querySelector('[data-deck-view]')&&review.useDeck.getState().mode==='deck'`)
  assert.equal(await evaluate(`review.useDeck.getState().selected`), 'task-b')
  await click('[title="CLI 安装与模型配置"]')
  await until(`document.querySelector('[aria-label="CLI 模型 ID"]')&&!document.querySelector('[aria-label="CLI 模型 ID"]').disabled`)
  await shot('cli-manager')
  await evaluate(`(()=>{const set=(label,value)=>{const el=document.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))};set('CLI API 地址','https://api.example.com/v1');set('CLI 模型 ID','fixture-model');set('CLI API Key','isolated-ui-secret')})()`)
  await evaluate(`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button=>button.textContent==='保存模型配置').click()`)
  await until(`actions.some(action=>action.action==='cli'&&action.operation==='configure'&&action.model==='fixture-model')`)
  await until(`document.querySelector('[aria-label="CLI API Key"]').value===''`)
  assert.equal(await evaluate(`Object.values(localStorage).some(value=>value.includes('isolated-ui-secret'))`),false,'CLI keys are never cached in browser preferences')
  await evaluate(`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button=>button.textContent==='关闭').click()`)
  await until(`!document.querySelector('[role="dialog"]')`)
  await click('[title="CLI 安装与模型配置"]')
  await until(`document.querySelector('[aria-label="CLI 模型 ID"]')&&!document.querySelector('[aria-label="CLI 模型 ID"]').disabled`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="CLI 模型 ID"]').value`),'fixture-model')
  await evaluate(`[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(button=>button.textContent==='安装 / 更新').click()`)
  await until(`document.querySelector('[data-terminal-id="managed-install"]')&&!document.querySelector('[role="dialog"]')`)
  assert.equal(await evaluate(`document.querySelector('[data-terminal-id="managed-install"] [title="交给 Coomi"]').disabled`),true,'installation terminal cannot receive coordinator prompts')
  console.log('Deck browser review passed: shared Work copy/quote/feedback/edit/regenerate/branch, approval allow/deny and task isolation, answered/skipped question cards and replay deduplication, drafts and attachments, one foreground session socket, close running/stopped/maximized terminals, themes, resize/pagination repaint, compact/half/full overlays, CLI management and key clearing, task/mode persistence.')
} catch (error) {
  console.error(await evaluate(`({url:location.href,body:document.body.innerText.slice(0,3500)})`))
  await shot('failure')
  throw error
} finally { socket.close(); await fetch(`http://127.0.0.1:${browserPort}/json/close/`+target.id) }
