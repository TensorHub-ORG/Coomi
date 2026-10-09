/** Browser review against a Vite dev server. Uses an isolated CDP browser profile and
 * fixture stores; never connects to a real engine or modifies user conversations.
 * Start headless Edge/Chrome with --remote-debugging-port=9337, then run this file.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const out = new URL('../../../docs/design/screenshots/', import.meta.url)
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
    localStorage.setItem('coomi.prefs.v2', JSON.stringify({ minimalUi:true, motion:false, fontFamily:'harmony' }));
  ` })
  await send('Page.navigate', { url: 'http://127.0.0.1:5273/' })
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
      if(path.includes('providers')) return {providers:[{id:'deepseek',name:'DeepSeek',model:'DeepSeek V3.2',active:true}],models:['DeepSeek V3.2']};
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
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.desktop-menu-trigger'), e => e.textContent)`), ['文件','编辑','视图','帮助'])
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.window-control svg'), e => e.getAttribute('width'))`), ['16','16','16'])
  await click('.welcome-suggestion')
  await until(`document.activeElement.tagName === 'TEXTAREA'`)
  assert.match(await evaluate('document.querySelector("textarea").value'), /实现一个功能/)
  assert.equal(await evaluate('document.activeElement.tagName'), 'TEXTAREA')
  await evaluate(`review.useSession.getState().setDraft(''); review.useUi.getState().setThemeMode('dark')`)
  await shot('02-welcome-dark')
  await evaluate(`review.useUi.getState().setThemeMode('light')`)
  await click('[data-nav-key="settings"]')
  await until(`!!document.querySelector('[data-testid="settings-body"]')`)
  await wait(500)
  await shot('03-settings')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-settings-cell]')).borderRadius`), '0px')
  await click('[role="switch"][aria-label="极简界面模式"]')
  for (const group of ['general', 'models', 'workspace', 'ai', 'life', 'engine', 'about']) {
    await click(`[data-settings-group="${group}"]`)
    await wait(300)
    assert.equal(await evaluate(`document.querySelector('[data-settings-group="${group}"]').getAttribute('aria-current')`), 'page')
    assert.ok(await evaluate(`(() => { const e = document.querySelector('[data-testid="settings-body"]'); return e.scrollWidth <= e.clientWidth + 1 })()`), `${group} settings fit`)
    await shot('settings-' + group)
  }
  await click('[data-settings-group="appearance"]')
  await until(`document.documentElement.dataset.minimalUi === 'false'`)
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('coomi.prefs.v2')).minimalUi`), false)
  await click('[role="switch"][aria-label="极简界面模式"]')
  await click('[data-nav-key="chat"]')
  await until(`!!document.querySelector('[data-view-state="active"] [data-chat-col]')`)
  await evaluate(String.raw`review.useSession.setState({messages:[
    {kind:'user',id:'u1',text:'帮我梳理一下 Coomi 的界面设计方向。',at:Date.now()},
    {kind:'assistant',id:'a1',text:'## 让每一次对话，都更专注\n\n以移动端的**蓝白配色**为起点，让内容成为界面的主角。\n\n- 清晰的层次：浅灰侧栏、白色画布与轻盈的输入区。\n- 适度的留白：让长文本更易读，让操作更容易找到。\n- 按需展开：工具执行收为小块，细节随时可查。\n\n接下来，我们可以从首页与对话体验开始。',reasoning:'先检查现有组件，再梳理移动端的设计令牌。',tools:[{callId:'t1',name:'read_file',args:'{"path":"src/styles/theme.css"}',status:'done',elapsedMs:240,preview:'Design tokens loaded'},{callId:'t2',name:'list_directory',args:'{}',status:'done',elapsedMs:180,preview:'12 components'}],streaming:false,at:Date.now()}
  ]})`)
  await until(`!!document.querySelector('[data-tool-group] .tool-summary')`)
  assert.equal(await evaluate(`document.querySelector('[data-tool-group] button').getAttribute('aria-expanded')`), 'false')
  await shot('04-conversation')
  await click('[data-tool-group] button')
  assert.equal(await evaluate(`document.querySelector('[data-tool-group] button').getAttribute('aria-expanded')`), 'true')
  await click('[data-tool-group] button')
  await evaluate(`review.useUi.getState().openPanel('stats')`)
  await until(`document.querySelector('[data-dock-panel]')?.getBoundingClientRect().width > 200`)
  const dockLayout = await evaluate(`(() => {const c=document.querySelector('[data-composer-box]').getBoundingClientRect();const d=document.querySelector('[data-dock-panel]').getBoundingClientRect();return {right:c.right,dockLeft:d.left}})()`)
  assert.ok(dockLayout.right <= dockLayout.dockLeft, 'dock does not cover composer')
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
  await click('[data-onboarding-agree]')
  assert.equal(await evaluate(`document.querySelector('[data-onboarding-enter]').disabled`), true)
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  assert.ok(await evaluate(`!!document.querySelector('[data-onboarding]')`), 'initial consent stays open on Escape')
  await click('[data-onboarding-agree]')
  await click('[data-onboarding-enter]')
  await until(`!document.querySelector('[data-onboarding]')`)
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('coomi.onboarding.v1')).version`), 2)
  assert.equal(errors.length, 0, JSON.stringify(errors))
  console.log('PASS: art + logo sizing, light/dark, eight settings groups, menus + editor focus, dismissible themed toast, help, onboarding consent, draft, tool disclosure, dock, narrow layout, large fonts and reduced motion; screenshots saved.')
} finally {
  await send('Page.close').catch(() => {})
  ws.close()
}
