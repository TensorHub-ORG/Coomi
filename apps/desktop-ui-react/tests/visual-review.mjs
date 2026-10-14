/** Browser review against a Vite dev server. Uses an isolated CDP browser profile and
 * fixture stores; never connects to a real engine or modifies user conversations.
 * Start headless Edge/Chrome with --remote-debugging-port=9337, then run this file.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const out = new URL(process.env.COOMI_REVIEW_OUTPUT || '../../../docs/design/screenshots/', import.meta.url)
await mkdir(out, { recursive: true })
const browserPort = process.env.COOMI_REVIEW_PORT || '9337'
const target = await (await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
let seq = 0
const pending = new Map()
const errors = []
ws.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  if (pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id)
    clearTimeout(timer)
    pending.delete(message.id)
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
  }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)) }, 30000)
  pending.set(id, { resolve, reject, timer })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (expression) => {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(200) }
  throw new Error(`Not ready: ${expression}`)
}
const shot = async (name) => {
  await evaluate('document.fonts.ready')
  await wait(400)
  const image = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(new URL(name + '.png', out), Buffer.from(image.data, 'base64'))
}
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
const pointerClick = async (expression) => {
  const point = await evaluate(`(() => { const r=(${expression}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}
const menuAction = async (menu, item) => {
  await pointerClick(`Array.from(document.querySelectorAll('.desktop-menu-trigger')).find(e=>e.textContent===${JSON.stringify(menu)})`)
  await until(`!!document.querySelector('[role="menu"]')`)
  await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.includes(${JSON.stringify(item)})).click()`)
  await wait(150)
}
try {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('coomi.onboarding.v1', JSON.stringify({version:2,acceptedAt:'2026-10-08'}));
    localStorage.removeItem('coomi.theme');
    localStorage.setItem('coomi.dock.w', '340');
    localStorage.setItem('coomi.list.w', '264');
    localStorage.setItem('coomi.prefs.v2', JSON.stringify({ minimalUi:true, motion:false, fontFamily:'harmony' }));
  ` })
  await send('Page.navigate', { url: process.env.COOMI_REVIEW_URL || 'http://127.0.0.1:5273/' })
  await until(`!!document.querySelector('.welcome-title')`)
  await evaluate(`(async () => {
    const loaded = (file) => performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/stores/' + file + '.ts')?.name || '/src/stores/' + file + '.ts';
    const {useEngine} = await import(loaded('engine'));
    const {useSession} = await import(loaded('session'));
    const {useUi} = await import(loaded('ui'));
    window.review = {useEngine,useSession,useUi};
    const sessions = [
      {id:'welcome',title:'新的灵感',updated_at:Date.now(),cwd:'C:/Projects/coomi'},
      {id:'design',title:'一起打磨 Coomi 的新界面',updated_at:Date.now(),cwd:'C:/Projects/coomi'},
      {id:'docs',title:'整理产品想法与设计笔记',updated_at:Date.now()-86400000,cwd:'C:/Projects/coomi'},
    ];
    useSession.setState({sessionId:'',sessions,historyLoaded:{welcome:true},messages:[],connected:true,connecting:false,loadSessions:async()=>{},currentModel:'DeepSeek V3.2',currentProviderId:'deepseek'});
    useEngine.setState({ready:true,status:'running',lastError:'',cwd:'C:/Projects/coomi',api:async(path)=>{
      if(path.includes('providers')) return {providers:[{id:'deepseek',name:'DeepSeek',model:'DeepSeek V3.2',models:['DeepSeek V3.2'],type:'openai_compatible',baseUrl:'https://example.com/v1',active:true,hasKey:true,modelContextWindows:{'DeepSeek V3.2':262144}}],models:['DeepSeek V3.2']};
      if(path.includes('sessions')) return {sessions};
      if(path === '/api/catalog') return {skills:[],mcp:[
        {id:'filesystem',name:'文件管理',description:'读取与整理本地文件，让工作目录井井有条。',installed:true,enabled:true},
        {id:'context7',name:'Context7 文档助手',description:'获取最新的开发文档与代码示例。'},
        {id:'memory',name:'知识记忆',description:'连接零散的信息，建立持续积累的知识。'},
        {id:'fetch',name:'网页阅读',description:'获取网页内容，将资料整理成清晰的线索。'},
      ]};
      if(path.includes('/api/runtime/runtimes')) return {runtimes:[{id:'node',found:true,version:'22.23.1'},{id:'npx',found:true},{id:'git',found:true}]};
      if(path.includes('/api/fs/list')) return {path:'C:/Projects/coomi',entries:[
        {name:'design',is_dir:true}, {name:'界面设计说明.md',size:4096}, {name:'design-tokens.json',size:2048}, {name:'产品计划.xlsx',size:16384},
      ]};
      return {skills:[],mcp:[],entries:[],runtimes:[],tasks:[],views:[],files:[],artifacts:[]};
    }});
    useSession.setState({sessionId:'welcome',connected:true,connecting:false,linkError:''});
  })()`)
  await wait(1800)
  await shot('01-welcome-light')
  assert.equal(await evaluate(`review.useUi.getState().themeMode`), 'light', 'new installations default to light even on a dark system')
  assert.equal(await evaluate(`document.querySelector('.welcome-title').textContent`), '慎终如始，则无败事')
  assert.equal(await evaluate(`document.querySelector('.welcome-brand').textContent`), 'Coomi.')
  assert.equal(await evaluate(`document.querySelector('.welcome-brand img').getBoundingClientRect().width`), 48)
  assert.equal(await evaluate(`document.querySelector('.welcome-wordmark').getBoundingClientRect().width`), 104)
  assert.equal(await evaluate(`document.querySelector('.welcome-description').textContent`), '准备好了，就告诉我想做什么')
  assert.equal(await evaluate(`document.querySelector('[data-shell-part="rail"] img')`), null)
  assert.equal(await evaluate(`(() => { const buttons=[...document.querySelectorAll('[data-shell-part="rail"] button')];return buttons.indexOf(document.querySelector('[data-plugins-entry]')) === buttons.indexOf(document.querySelector('[data-nav-key="artifacts"]')) + 1 })()`), true, 'plugins follow artifacts')
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.desktop-menu-trigger'), e => e.textContent)`), ['文件','编辑','视图','帮助'])
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.window-control svg'), e => e.getAttribute('width'))`), ['16','16','16'])
  assert.equal(await evaluate('document.querySelectorAll(".welcome-suggestions, .welcome-suggestion").length'), 0, 'welcome suggestions are removed')
  assert.equal(await evaluate('document.querySelectorAll("[aria-label=\\"极简界面模式\\"]").length'), 0, 'minimal mode control is removed')
  // The welcome page intentionally has no suggestion cards.
  await evaluate(`review.useSession.getState().setDraft(''); review.useUi.getState().setThemeMode('dark')`)
  await shot('02-welcome-dark')
  await evaluate(`review.useUi.getState().setThemeMode('light')`)
  await click('[data-nav-key="settings"]')
  await until(`!!document.querySelector('[data-testid="settings-body"]')`)
  await wait(500)
  await shot('03-settings')
  assert.equal(await evaluate(`document.querySelector('[data-settings-group="general"]').getAttribute('aria-current')`), 'page')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-settings-cell]')).borderRadius`), '0px')
  for (const group of ['general', 'models', 'workspace', 'ai', 'life', 'engine', 'about']) {
    await click(`[data-settings-group="${group}"]`)
    await wait(300)
    assert.equal(await evaluate(`document.querySelector('[data-settings-group="${group}"]').getAttribute('aria-current')`), 'page')
    assert.ok(await evaluate(`(() => { const e = document.querySelector('[data-testid="settings-body"]'); return e.scrollWidth <= e.clientWidth + 1 })()`), `${group} settings fit`)
    await shot('settings-' + group)
  }
  assert.equal(await evaluate(`document.documentElement.dataset.minimalUi`), 'false')
  await click('[data-nav-key="chat"]')
  await until(`!!document.querySelector('[data-view-state="active"] [data-chat-col]')`)
  // Editing preserves the stored key and activation, while reveal/copy use the
  // authenticated endpoint. This entire provider is a fixture, never a user key.
  await evaluate(`(() => {
    const original = review.useEngine.getState().api;
    window.providerSave = null;
    window.copiedKey = '';
    Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:async(value)=>{window.copiedKey=value} } });
    review.useEngine.setState({api:async(path,options)=>{
      if(path.endsWith('/reveal')) return {apiKey:'fixture-key'};
      if(path==='/api/providers' && options?.method==='POST') {window.providerSave=JSON.parse(options.body);return {ok:true}};
      if(path==='/api/providers') return {providers:[{id:'deepseek',name:'DeepSeek',model:'DeepSeek V3.2',models:['DeepSeek V3.2'],type:'openai_compatible',baseUrl:'https://example.com/v1',active:true,hasKey:true,modelContextWindows:{'DeepSeek V3.2':262144}}]};
      if(path.endsWith('/context')) return {context_window:262144,used_tokens:60678};
      return original(path,options);
    }});
  })()`)
  await evaluate(`review.useUi.getState().setSettingsGroup('models'); review.useUi.getState().setView('settings')`)
  await until(`Array.from(document.querySelectorAll('[data-testid="settings-body"] button')).some(e=>e.textContent==='编辑')`)
  await evaluate(`Array.from(document.querySelectorAll('[data-testid="settings-body"] button')).find(e=>e.textContent==='编辑').click()`)
  await until(`!!document.querySelector('[title="显示密钥"]')`)
  assert.equal(await evaluate(`document.querySelector('input[type="password"]').placeholder`), '已保存密钥（留空保留）')
  await click('[title="显示密钥"]')
  await until(`!!document.querySelector('[title="隐藏密钥"]')`)
  assert.equal(await evaluate(`document.querySelector('input[autocomplete="off"]').value`), 'fixture-key')
  await click('[title="隐藏密钥"]')
  await until(`document.querySelector('input[autocomplete="off"]').type==='password'`)
  assert.equal(await evaluate(`document.querySelector('input[autocomplete="off"]').type`), 'password')
  await click('[title="复制密钥"]')
  await until(`window.copiedKey==='fixture-key'`)
  await evaluate(`(() => {const input=document.querySelector('input[autocomplete="off"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(e=>e.textContent.includes('下一步')).click()`)
  await until(`Array.from(document.querySelectorAll('[role="dialog"] button')).some(e=>e.textContent.trim()==='保存')`)
  await evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(e=>e.textContent.trim()==='保存').click()`)
  await until(`window.providerSave!==null`)
  assert.equal(await evaluate(`window.providerSave.apiKey`), undefined, 'blank key is omitted on edit')
  assert.equal(await evaluate(`window.providerSave.activate`), true, 'active provider stays active')
  assert.equal(await evaluate(`window.providerSave.modelContextWindows['DeepSeek V3.2']`), 262144)
  await click('[data-nav-key="chat"]')
  await until(`!!document.querySelector('[data-view-state="active"] [data-chat-col]')`)
  await evaluate(`review.useUi.getState().setSettingsGroup('models'); review.useUi.getState().setView('settings')`)
  await until(`document.querySelector('[data-settings-group="models"]')?.getAttribute('aria-current') === 'page'`)
  await click('[data-nav-key="chat"]')
  await click('[data-nav-key="settings"]')
  await until(`document.querySelector('[data-settings-group="general"]')?.getAttribute('aria-current') === 'page'`)
  await click('[data-nav-key="chat"]')
  await until(`!!document.querySelector('[data-view-state="active"] [data-chat-col]')`)
  await evaluate(String.raw`review.useSession.setState({messages:[
    {kind:'user',id:'u1',text:'帮我梳理一下 Coomi 的界面设计方向。',at:Date.now()},
    {kind:'assistant',id:'a1',text:'## 让每一次对话，都更专注\n\n以移动端的**蓝白配色**为起点，让内容成为界面的主角。\n\n- 清晰的层次：浅灰侧栏、白色画布与轻盈的输入区。\n- 适度的留白：让长文本更易读，让操作更容易找到。\n- 按需展开：工具执行收为小块，细节随时可查。\n\n接下来，我们可以从首页与对话体验开始。',reasoning:'先检查现有组件，再梳理移动端的设计令牌。',tools:[{callId:'t1',name:'read_file',args:'{"path":"src/styles/theme.css"}',status:'done',elapsedMs:240,preview:'Design tokens loaded'},{callId:'t2',name:'list_directory',args:'{}',status:'done',elapsedMs:180,preview:'12 components'}],streaming:false,at:Date.now()}
  ]})`)
  await until(`!!document.querySelector('[data-msg-index] button[aria-controls][aria-expanded]')`)
  assert.equal(await evaluate(`document.querySelector('[data-chat-toolbar]').textContent.includes('工作区') || document.querySelector('[data-chat-toolbar]').textContent.includes('DeepSeek V3.2')`), false, 'toolbar shows title without stacked metadata')
  await until(`!!document.querySelector('[data-nav-point]')`)
  assert.ok(await evaluate(`Math.abs(document.querySelector('[data-nav-point] button').getBoundingClientRect().left - document.querySelector('[data-chat-col]').getBoundingClientRect().left) < 1`), 'message ticks attach to the chat left edge')
  assert.equal(await evaluate(`document.querySelector('[data-nav-point]').querySelectorAll('button').length`), 1, 'one navigation tick per turn')
  const tickBefore = await evaluate(`document.querySelector('[data-nav-point] button').getBoundingClientRect().width`)
  const tickPosition = await evaluate(`(() => { const r=document.querySelector('[data-nav-point] button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...tickPosition })
  await wait(500)
  assert.ok(await evaluate(`document.querySelector('[data-nav-point] button').getBoundingClientRect().width`) > tickBefore, 'hover extends the single tick')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1400, y: 20 })
  assert.equal(await evaluate(`document.querySelector('[data-msg-index] button[aria-controls][aria-expanded]').getAttribute('aria-expanded')`), 'false')
  await shot('04-conversation')
  await click('[data-msg-index] button[aria-controls][aria-expanded]')
  assert.equal(await evaluate(`document.querySelector('[data-msg-index] button[aria-controls][aria-expanded]').getAttribute('aria-expanded')`), 'true')
  await until(`!!document.querySelector('[data-msg-index] [data-tool-group]')`)
  // Work waterfall: preserve event order and full payloads without tool cards.
  await evaluate(`window.waterfallOriginal=review.useSession.getState().messages`)
  const waterfallTools = [
    {callId:'read',name:'read_file',args:JSON.stringify({path:'src/App.tsx'}),status:'done',preview:'Full file contents'},
    {callId:'edit',name:'edit_file',args:JSON.stringify({path:'src/App.tsx',old_string:'const old = 1',new_string:'const next = 2'}),status:'done',preview:'edited src/App.tsx'},
    {callId:'terminal',name:'exec_command',args:JSON.stringify({command:'npm run build',cwd:'F:/project'}),status:'done',preview:'Build log\nAll checks passed\nEND OF COMPLETE LOG'},
    {callId:'git',name:'exec_command',args:JSON.stringify({command:'git diff -- src/App.tsx'}),status:'done',preview:'diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,2 +1,2 @@\n-const old = 1\n+const next = 2\n export default App'},
    {callId:'custom',name:'plugin.custom_action',args:JSON.stringify({option:'complete parameters'}),status:'done',preview:'Plugin output preserved'},
    {callId:'failed',name:'write_file',args:JSON.stringify({path:'locked.txt',content:'request'}),status:'error',preview:'Permission denied — original error details'},
  ]
  await evaluate(`review.useSession.setState(s=>({messages:s.messages.map(m=>m.kind==='assistant'?{...m,tools:${JSON.stringify(waterfallTools)},segments:[{kind:'text',text:'Inspect the source first.'},{kind:'tools',callIds:['read','edit']},{kind:'text',text:'Run validation and inspect Git changes.'},{kind:'tools',callIds:['terminal','git','custom','failed']},{kind:'text',text:m.text}]}:m)}))`)
  await until(`document.querySelectorAll('[data-tool-row]').length===6`)
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-tool-row]')).map(e=>e.dataset.toolRow)`), waterfallTools.map(t=>t.callId), 'execution order is preserved')
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('[data-tool-row]')).every(e=>getComputedStyle(e).borderTopWidth==='0px' && getComputedStyle(e).borderRadius==='0px')`), 'all executions use unframed rows')
  assert.equal(await evaluate(`document.querySelectorAll('[data-tool-detail]').length`), 1, 'successful logs stay lazy; failure details remain visible')
  await click('[data-tool-row="edit"] > button')
  await until(`!!document.querySelector('[data-tool-replacements]')`)
  assert.ok(await evaluate(`document.querySelector('[data-tool-replacements]').textContent.includes('const next = 2')`), 'replacement snippets remain readable')
  await click('[data-tool-row="terminal"] > button')
  assert.ok(await evaluate(`document.querySelector('[data-tool-row="terminal"]').textContent.includes('END OF COMPLETE LOG')`), 'terminal output is complete')
  await click('[data-tool-row="git"] > button')
  await until(`!!document.querySelector('[data-tool-diff]')`)
  assert.ok(await evaluate(`document.querySelector('[data-tool-row="git"] > button').textContent.includes('+1')`), 'Git changes show actual additions')
  await click('[data-tool-row="custom"] > button')
  assert.ok(await evaluate(`document.querySelector('[data-tool-row="custom"]').textContent.includes('complete parameters')`), 'unknown tools retain full parameters')
  await shot('15-work-waterfall')
  await evaluate(`document.querySelector('[data-tool-row="git"]').scrollIntoView({block:'center'})`)
  await shot('16-work-waterfall-git')
  await evaluate(`review.useUi.getState().setThemeMode('dark')`)
  await shot('17-work-waterfall-dark')
  await evaluate(`review.useUi.getState().setThemeMode('light')`)
  await click('[data-tool-row="git"] > button')
  assert.equal(await evaluate(`document.querySelector('[data-tool-row="git"] [data-tool-detail]')===null`), true, 'collapsed diffs unmount heavy content')
  // Pending prompts are a composer-adjacent queue with real engine-backed actions.
  await evaluate(`review.useSession.setState(s=>({messages:[...s.messages,{kind:'user',id:'q1',queueId:'queue-1',text:'测试排队消息',queued:true,at:Date.now(),structured:true}]}))`)
  await until(`!!document.querySelector('[data-queued-message="queue-1"]')`)
  assert.equal(await evaluate(`document.querySelector('[data-msg-scroller]').textContent.includes('测试排队消息')`), false, 'queued user messages move out of the transcript')
  await shot('18-composer-message-queue')
  const priorApi = await evaluate(`window.queuePriorApi=review.useEngine.getState().api;true`)
  assert.equal(priorApi, true)
  await evaluate(`review.useEngine.setState({api:async(path,options)=>{const body=JSON.parse(options.body);return {event_type:body.action==='edit'?'queue_updated':body.action==='delete'?'queue_removed':'queue_immediate',queue_id:path.split('/').at(-1),text:body.text}}})`)
  await click('[data-queued-message="queue-1"] [aria-label="编辑排队消息"]')
  await until(`!!document.querySelector('[data-queued-message="queue-1"] textarea')`)
  await evaluate(`(()=>{const e=document.querySelector('[data-queued-message="queue-1"] textarea');const key=Object.keys(e).find(k=>k.startsWith('__reactProps$'));e[key].onChange({target:{value:'修改后的排队消息'}})})()`)
  await evaluate(`Array.from(document.querySelectorAll('[data-queued-message="queue-1"] button')).find(b=>b.textContent.includes('保存')).click()`)
  await until(`document.querySelector('[data-queued-message="queue-1"]')?.textContent.includes('修改后的排队消息')`)
  await click('[data-queued-message="queue-1"] [aria-label="立即执行排队消息"]')
  await until(`document.querySelector('[data-queued-message="queue-1"]')?.textContent.includes('已优先')`)
  assert.equal(await evaluate(`document.querySelector('[data-queued-message="queue-1"] [aria-label="立即执行排队消息"]').disabled`), true, 'immediate queue action locks while the engine reaches a safe point')
  await evaluate(`review.useSession.setState(s=>({messages:s.messages.map(m=>m.queueId==='queue-1'?{...m,queued:false}:m)}))`)
  await until(`!document.querySelector('[data-queued-message="queue-1"]')`)
  await evaluate(`review.useSession.setState(s=>({messages:[...s.messages,{kind:'user',id:'q2',queueId:'queue-2',text:'删除这条',queued:true,at:Date.now(),structured:true}]}))`)
  await until(`!!document.querySelector('[data-queued-message="queue-2"]')`)
  await click('[data-queued-message="queue-2"] [aria-label="删除排队消息"]')
  await until(`!document.querySelector('[data-queued-message="queue-2"]')`)
  await evaluate(`review.useEngine.setState({api:window.queuePriorApi})`)
  // Long conversation: a new prompt returns to latest; intentional wheel navigation detaches
  // following while content continues to grow; the centered arrow restores it on demand.
  await evaluate(`window.scrollTestOriginal=review.useSession.getState().messages;review.useSession.setState({messages:Array.from({length:18},(_,i)=>i%2===0?{kind:'user',id:'scroll-u'+i,text:'用户消息 '+i,at:i+1}:{kind:'assistant',id:'scroll-a'+i,text:('持续输出内容 '+i+' ').repeat(110),reasoning:'',tools:[],streaming:false,at:i+1})})`)
  await wait(300)
  const listRect = await evaluate(`(()=>{const r=document.querySelector('[data-msg-scroller]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await evaluate(`document.querySelector('[data-msg-scroller]').scrollTop=0`)
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',...listRect,deltaY:-320,deltaX:0})
  await wait(180)
  await until(`!!document.querySelector('[data-scroll-latest]')`)
  assert.ok(await evaluate(`(()=>{const b=document.querySelector('[data-scroll-latest]').getBoundingClientRect();const s=document.querySelector('[data-msg-scroller]').getBoundingClientRect();return Math.abs(b.left+b.width/2-(s.left+s.width/2))<2 && Math.abs(b.width-48)<1})()`), 'latest button is a centered circular arrow')
  await click('[data-scroll-latest]')
  await wait(100)
  assert.ok(await evaluate(`(()=>{const e=document.querySelector('[data-msg-scroller]');return e.scrollHeight-e.scrollTop-e.clientHeight<5})()`), 'latest button immediately returns to the bottom')
  await evaluate(`document.querySelector('[data-msg-scroller]').scrollTop=0`)
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',...listRect,deltaY:-320,deltaX:0})
  await until(`!!document.querySelector('[data-scroll-latest]')`)
  await evaluate(`review.useSession.setState(s=>({streaming:true,messages:[...s.messages,{kind:'user',id:'send-bottom',text:'send bottom test',at:Date.now()}]}));window.dispatchEvent(new CustomEvent('coomi:scroll-chat-bottom'))`)
  await wait(300)
  const afterSendScroll = await evaluate(`(()=>{const e=document.querySelector('[data-msg-scroller]');return {distance:e.scrollHeight-e.scrollTop-e.clientHeight,top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,navBusy:document.documentElement.dataset.navBusy,button:!!document.querySelector('[data-scroll-latest]')}})()`)
  assert.ok(afterSendScroll.distance < 5, 'sending a message forces the conversation to the latest content: ' + JSON.stringify(afterSendScroll))
  await evaluate(`document.querySelector('[data-msg-scroller]').scrollTop=0`)
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',...listRect,deltaY:-320,deltaX:0})
  await until(`!!document.querySelector('[data-scroll-latest]')`)
  const heldTop = await evaluate(`document.querySelector('[data-msg-scroller]').scrollTop`)
  await evaluate(`review.useSession.setState(s=>({messages:s.messages.map(m=>m.kind==='assistant'&&m.id==='scroll-a17'?{...m,text:m.text+' extra output '.repeat(100)}:m)}))`)
  await wait(250)
  assert.ok(await evaluate(`Math.abs(document.querySelector('[data-msg-scroller]').scrollTop-${heldTop})<3`), 'stream growth does not override intentional user scrolling')
  await click('[data-scroll-latest]')
  await wait(100)
  await evaluate(`review.useSession.setState(s=>({messages:s.messages.map(m=>m.kind==='assistant'&&m.id==='scroll-a17'?{...m,text:m.text+' following output '.repeat(100)}:m)}))`)
  await wait(200)
  assert.ok(await evaluate(`(()=>{const e=document.querySelector('[data-msg-scroller]');return e.scrollHeight-e.scrollTop-e.clientHeight<5})()`), 'returning to latest resumes following content growth')
  await evaluate(`review.useSession.setState({messages:window.scrollTestOriginal,streaming:false})`)
  const fullResult = 'full output '.repeat(1000) + 'FULL RESULT END'
  await evaluate(`window.waterfallApi=review.useEngine.getState().api;review.useEngine.setState({api:async()=>({messages:[{role:'tool',tool_call_id:'terminal',content:${JSON.stringify(fullResult)}}]})});review.useSession.setState(s=>({messages:s.messages.map(m=>m.kind==='assistant'?{...m,tools:m.tools.map(t=>t.callId==='terminal'?{...t,preview:'x'.repeat(1000)+'...'}:t)}:m)}))`)
  if (!await evaluate(`!!document.querySelector('[data-tool-row="terminal"] [data-tool-detail]')`)) await click('[data-tool-row="terminal"] > button')
  await until(`!!document.querySelector('[data-tool-load-full]')`)
  await click('[data-tool-load-full]')
  await until(`document.querySelector('[data-tool-row="terminal"]').textContent.includes('FULL RESULT END')`)
  assert.equal(await evaluate(`document.querySelector('[data-tool-load-full]')===null`), true, 'full output replaces the abbreviated stream preview')
  await evaluate(`review.useEngine.setState({api:window.waterfallApi})`)
  await evaluate(`review.useSession.setState({messages:window.waterfallOriginal})`)
  await wait(150)
  await click('[data-msg-index] button[aria-controls][aria-expanded]')
  await evaluate(`review.useUi.getState().openPanel('stats')`)
  const mathSample = '\n\n行内 $x^2 + y^2 = 1$\n\n$$\\frac{1}{2} + \\nabla f$$\n\n`$raw$`'
  await evaluate(`review.useSession.setState(s=>({messages:s.messages.map(m=>m.kind==='assistant'?{...m,text:m.text+${JSON.stringify(mathSample)}}:m)}))`)
  await until(`document.querySelectorAll('[data-chat-col] .katex').length >= 2`)
  assert.ok(await evaluate(`!!document.querySelector('[data-chat-col] .katex-display')`), 'single-line double-dollar formulas render as display math')
  assert.equal(await evaluate(`document.querySelector('[data-chat-col] .katex-error') === null`), true, 'valid formulas render without errors')
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('[data-chat-col] code')).some(e=>e.textContent==='$raw$')`), 'code containing dollars stays literal')
  await evaluate(`(async()=>{const {groupSessions}=await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/stores/workspace.ts')?.name || '/src/stores/workspace.ts');const groups=groupSessions([{id:'p1',cwd:'F:/Projects/App',updatedAt:1},{id:'p2',cwd:'f:\\\\projects\\\\app\\\\',updatedAt:2},{id:'p3',cwd:'F:/Projects/Other'}],'F:/Projects/App',{});if(groups.length!==2||groups.find(g=>g.sessions.length===2)?.sessions[0].id!=='p2')throw Error('path grouping failed')})()`)
  await evaluate(`(async()=>{const {useLibrary}=await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/stores/library.ts')?.name || '/src/stores/library.ts');useLibrary.setState({skills:[{id:'review-skill',name:'Review Skill',installed:true}]});review.useUi.getState().setPrefs({motion:true})})()`)
  await pointerClick(`document.querySelector('[data-view-state="active"] button[aria-label="添加"]')`)
  await until(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(e=>e.textContent.includes('Review Skill'))`)
  await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.includes('Review Skill')).click()`)
  await until(`!!document.querySelector('[data-view-state="active"] [aria-label="移除技能"]')`)
  await click('[data-view-state="active"] [aria-label="移除技能"]')
  await until(`!document.querySelector('[data-view-state="active"] [aria-label="移除技能"]')`)
  await evaluate(`review.useUi.getState().setPrefs({motion:false})`)
  await pointerClick(`document.querySelector('[data-view-state="active"] [data-effort-picker]')`)
  await until(`!!document.querySelector('.es-ticks')`)
  assert.ok(await evaluate(`(()=>{const g=document.querySelector('.es-groove').getBoundingClientRect();const t=Array.from(document.querySelectorAll('.es-tick')).map(e=>e.getBoundingClientRect());return Math.abs(t[0].left+t[0].width/2-g.left-15)<1 && Math.abs(g.right-t.at(-1).left-t.at(-1).width/2-15)<1})()`), 'endpoint ticks sit at capsule centers')
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await until(`document.querySelector('[data-dock-panel]')?.getBoundingClientRect().width > 200`)
  const dockLayout = await evaluate(`(() => {const c=document.querySelector('[data-composer-box]').getBoundingClientRect();const d=document.querySelector('[data-dock-panel]').getBoundingClientRect();return {right:c.right,dockLeft:d.left}})()`)
  assert.ok(dockLayout.right <= dockLayout.dockLeft, 'dock does not cover composer')
  await evaluate(`review.useEngine.setState({ready:false}); review.useUi.getState().openPanel('side')`)
  await until(`!!document.querySelector('[data-aux-composer] textarea')`)
  await evaluate(`document.activeElement?.blur()`)
  await wait(250)
  assert.ok(await evaluate(`(() => {
    const main=document.querySelector('[data-chat-col] [data-composer-box]');
    const side=document.querySelector('[data-aux-composer] [data-composer-box]');
    const properties=['borderRadius','padding','borderColor','boxShadow'];
    return properties.every(key=>getComputedStyle(main)[key]===getComputedStyle(side)[key])
      && getComputedStyle(main.querySelector('textarea')).fontSize===getComputedStyle(side.querySelector('textarea')).fontSize;
  })()`), 'auxiliary composer shares the main surface and text styles')
  assert.ok(await evaluate(`(() => {
    const side=document.querySelector('[data-aux-composer]');
    const row=side.querySelector('[data-composer-tools]');
    const send=side.querySelector('[data-composer-send]');
    return !!side.querySelector('[data-effort-picker]') && !!side.querySelector('[data-aux-model]')
      && !!side.querySelector('[title="任务放行程度"]') && row.scrollWidth<=row.clientWidth+1
      && send.getBoundingClientRect().right<=row.getBoundingClientRect().right+1;
  })()`), 'auxiliary controls and fixed send fit the narrow dock')
  await shot('aux-composer-shared-design')
  await evaluate(`review.useUi.getState().openPanel('stats'); review.useEngine.setState({ready:true})`)
  await until(`!!document.querySelector('[data-dock-tab="stats"]') || !document.querySelector('[data-aux-composer]')`)
  await wait(400)
  const dockWidthBefore = await evaluate(`document.querySelector('[data-dock-panel]').getBoundingClientRect().width`)
  const divider = await evaluate(`(() => {const r=document.querySelector('#coomi-dock-sep').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...divider })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...divider, button: 'left', clickCount: 1 })
  for (let distance = 20; distance <= 100; distance += 20) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: divider.x - distance, y: divider.y, button: 'left', buttons: 1 })
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: divider.x - 100, y: divider.y, button: 'left', clickCount: 1 })
  await wait(300)
  const dockWidthAfter = await evaluate(`document.querySelector('[data-dock-panel]').getBoundingClientRect().width`)
  assert.ok(dockWidthAfter > dockWidthBefore + 60, `dragging the dock edge grows the preview (${dockWidthBefore} → ${dockWidthAfter}, divider ${JSON.stringify(divider)})`)
  assert.ok(await evaluate(`(() => {const d=document.querySelector('[data-dock-root]').getBoundingClientRect();const p=document.querySelector('[data-dock-panel]').getBoundingClientRect();const b=document.querySelector('[data-dock-bar]').getBoundingClientRect();return Math.abs(b.width-40)<1 && Math.abs(p.right-b.left)<1 && Math.abs(b.right-d.right)<1})()`), 'preview and icon rail share the dock without overlap or clipping')
  assert.ok(await evaluate(`Math.abs(document.querySelector('[data-nav-point] button').getBoundingClientRect().left - document.querySelector('[data-chat-col]').getBoundingClientRect().left) < 1`), 'message ticks remain attached after dock resizing')
  await shot('12-resizable-dock')
  await evaluate(`review.useUi.getState().togglePanel(false)`)
  await wait(350)
  await evaluate(`review.useUi.getState().openPanel('stats')`)
  await wait(350)
  assert.ok(await evaluate(`Math.abs(document.querySelector('[data-dock-panel]').getBoundingClientRect().width - ${dockWidthAfter}) < 2`), 'reopening the dock restores its dragged width')
  const shrinkDivider = await evaluate(`(() => {const r=document.querySelector('#coomi-dock-sep').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...shrinkDivider })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...shrinkDivider, button: 'left', clickCount: 1 })
  for (let distance = 20; distance <= 100; distance += 20) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: shrinkDivider.x + distance, y: shrinkDivider.y, button: 'left', buttons: 1 })
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: shrinkDivider.x + 100, y: shrinkDivider.y, button: 'left', clickCount: 1 })
  await wait(300)
  assert.ok(await evaluate(`document.querySelector('[data-dock-panel]').getBoundingClientRect().width`) < dockWidthAfter - 60, 'dragging right shrinks the preview')
  await evaluate(`review.useUi.getState().togglePanel(false)`)
  await click('[data-nav-key="skills"]')
  await until(`!!document.querySelector('[data-skills-page]')`)
  await wait(1000)
  await shot('06-skills')
  await click('[data-nav-key="artifacts"]')
  await until(`document.querySelectorAll('[data-artifact-row]').length === 4`)
  await shot('07-artifacts')
  await click('[data-nav-key="chat"]')
  await until(`!!document.querySelector('[data-view-state="active"] [data-chat-col]')`)
  await evaluate(`review.useSession.setState({messages:[]})`)
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false })
  await wait(500)
  await shot('05-compact-window')
  await evaluate(`review.useUi.getState().openPanel('stats')`)
  await wait(400)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-view-state="active"] [data-composer-model]')).display`), 'none', 'narrow composer hides the model selector')
  await evaluate(`review.useUi.getState().togglePanel(false)`)
  await wait(350)
  const layout = await evaluate(`(() => { const box=document.querySelector('[data-composer-box]').getBoundingClientRect(); const main=document.querySelector('[data-chat-col]').getBoundingClientRect(); return {box:box.toJSON(),main:main.toJSON(),bodyWidth:document.body.scrollWidth,viewport:innerWidth} })()`)
  assert.ok(layout.box.x >= layout.main.x && layout.box.right <= layout.main.right + 1, 'composer stays in main column')
  assert.ok(layout.bodyWidth <= layout.viewport, 'no horizontal page overflow')
  await click('[data-list-toggle]')
  await until(`!!document.querySelector('[data-list-drawer][data-state="open"]')`)
  await click('[data-drawer-scrim]')
  await until(`!document.querySelector('[data-list-drawer][data-state="open"]')`)
  await evaluate(`review.useUi.getState().setFontScale(1.18)`)
  await wait(300)
  assert.ok(await evaluate(`(() => {const e=document.querySelector('[data-composer-tools]');return e.scrollWidth <= e.clientWidth + 1})()`), 'large font toolbar fits')
  assert.ok(await evaluate(`(() => {const row=document.querySelector('[data-composer-tools]');const send=row.querySelector('[data-composer-send]');const r=row.getBoundingClientRect();const s=send.getBoundingClientRect();return getComputedStyle(row).flexWrap==='nowrap' && s.right<=r.right+1 && s.top>=r.top && s.bottom<=r.bottom+1})()`), 'send stays on the same toolbar row')
  await shot('08-large-font')
  await evaluate(`review.useUi.getState().setFontScale(1.08); review.useUi.getState().setPrefs({motion:true})`)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await click('[data-nav-key="settings"]')
  await until(`!!document.querySelector('[data-view-state="active"] [data-testid="settings-body"]')`)
  await click('[data-nav-key="chat"]')
  await until(`!!document.querySelector('[data-view-state="active"] [data-chat-col]')`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
  await evaluate(`review.useUi.getState().setPrefs({motion:false})`)
  // Menus perform real actions; theme changes also update portaled notifications.
  await menuAction('视图', '深色主题')
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark')
  await evaluate(`(async()=>{ const url=performance.getEntriesByType('resource').find(e=>e.name.includes('/sonner.js'))?.name; const {toast}=await import(url); toast('设置已保存',{duration:Infinity,description:'更改已立即生效'}); })()`)
  await until(`!!document.querySelector('[data-sonner-toast] [data-close-button]')`)
  assert.equal(await evaluate(`document.querySelector('[data-sonner-toaster]').getAttribute('data-sonner-theme')`), 'dark')
  await shot('09-notification-dark')
  await click('[data-sonner-toast] [data-close-button]')
  await until(`!document.querySelector('[data-sonner-toast]')`)
  await menuAction('视图', '亮色主题')
  await send('Emulation.setEmulatedMedia', { features: [{name:'prefers-color-scheme',value:'dark'}] })
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'light', 'system changes preserve explicit light preference')
  await menuAction('视图', '跟随系统')
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark')
  await menuAction('视图', '亮色主题')
  await menuAction('文件', '设置')
  await until(`!!document.querySelector('[data-view-state="active"] .settings-navigation')`)
  await menuAction('视图', '会话')
  await until(`!!document.querySelector('[data-view-state="active"] textarea')`)
  await evaluate(`const input=document.querySelector('[data-view-state="active"] textarea'); input.focus();`)
  await send('Input.insertText', {text:'编辑菜单验证'})
  await menuAction('编辑', '全选')
  assert.equal(await evaluate(`document.activeElement.selectionEnd-document.activeElement.selectionStart`), 6, 'Edit > Select all restores input focus and selection')
  await evaluate(`review.useSession.getState().setDraft('')`)
  await menuAction('帮助', '帮助中心')
  await until(`!!document.querySelector('[data-help-center]')`)
  assert.equal(await evaluate(`document.querySelectorAll('[data-help-doc]').length`), 1)
  await evaluate(`Array.from(document.querySelectorAll('[data-help-toc] button')).find(e=>e.textContent.includes('快捷键')).click()`)
  await until(`!!document.querySelector('[data-help-doc="shortcuts"]')`)
  await shot('10-help')
  await click('[aria-label="关闭帮助"]')
  await until(`!document.querySelector('[data-help-center]')`)
  await menuAction('帮助', '隐私与使用说明')
  await until(`!!document.querySelector('[data-onboarding]')`)
  assert.equal(await evaluate(`document.querySelector('[data-onboarding] [aria-expanded]').getAttribute('aria-expanded')`), 'false')
  await shot('11-onboarding')
  await click('[data-onboarding] [aria-expanded]')
  assert.equal(await evaluate(`document.querySelector('[data-onboarding] [aria-expanded]').getAttribute('aria-expanded')`), 'true')
  await click('[data-onboarding-done]')
  // Exercise initial consent without touching any real user's storage.
  await evaluate(`(async()=>{const url=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/components/onboarding/store.ts').name;const {useOnboarding}=await import(url);useOnboarding.getState().show(true)})()`)
  await until(`!!document.querySelector('[data-onboarding-agree]')`)
  assert.equal(await evaluate(`document.querySelector('[data-onboarding-agree]').checked`), false, 'consent is never preselected')
  assert.equal(await evaluate(`document.activeElement===document.querySelector('[data-onboarding] [aria-expanded]')`), false, 'privacy link is not autofocused')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-onboarding]')).outlineStyle`), 'none', 'dialog does not receive a default blue selection outline')
  assert.equal(await evaluate(`document.querySelector('[data-onboarding-enter]').disabled`), true)
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  assert.ok(await evaluate(`!!document.querySelector('[data-onboarding]')`), 'initial consent stays open on Escape')
  await click('[data-onboarding-agree]')
  await click('[data-onboarding-enter]')
  await until(`!document.querySelector('[data-onboarding]')`)
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('coomi.onboarding.v1')).version`), 2)
  await evaluate(`(async()=>{
    const writes=[];
    review.useEngine.setState({ready:false,api:async(path,options)=>{if(options?.method==='POST')writes.push({path,body:JSON.parse(options.body)});return {messages:[],sessions:[]}}});
    review.useSession.setState({sessions:[{id:'old-project',cwd:'F:/Projects/Original'}],sessionId:'old-project',pendingCwd:'F:/Unrelated'});
    await review.useSession.getState().newSession();
    if(writes.at(-1)?.body.cwd!=='F:/Projects/Original')throw Error('new session must inherit current project');
    await review.useSession.getState().newSession(undefined,'F:/Projects/Chosen');
    if(writes.at(-1)?.body.cwd!=='F:/Projects/Chosen')throw Error('group new session must use chosen path');
    const count=writes.length;
    await review.useSession.getState().newSession('restored-session');
    if(writes.length!==count)throw Error('restoring a session must not overwrite its cwd');
  })()`)
  assert.equal(errors.length, 0, JSON.stringify(errors))
  console.log('PASS: art + logo sizing, light/dark, eight settings groups, menus + editor focus, dismissible themed toast, help, onboarding consent, draft, tool disclosure, dock, narrow layout, large fonts and reduced motion; screenshots saved.')
} finally {
  await send('Page.close').catch(() => {})
  ws.close()
}
