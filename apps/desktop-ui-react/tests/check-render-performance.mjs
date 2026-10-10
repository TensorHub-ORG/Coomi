import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolated browser + mock session: never connects to a real model or user profile.
const url = process.env.COOMI_PERF_URL || 'http://127.0.0.1:5274/'
const browserPath = process.env.COOMI_BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync)
assert.ok(browserPath, 'Edge or Chrome is required')
const profile = mkdtempSync(join(tmpdir(), 'coomi-render-perf-'))
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank'],
{ windowsHide: true, stdio: 'ignore' })
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
let ws
try {
  const activePort = join(profile, 'DevToolsActivePort')
  for (let i = 0; !existsSync(activePort) && i < 200; i++) await wait(100)
  assert.ok(existsSync(activePort), 'browser debugging port became available')
  const port = readFileSync(activePort, 'utf8').split('\n')[0]
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  const errors = []
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
    if (message.id) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(message.error)
      else entry.resolve(message.result)
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('coomi.onboarding.v1', JSON.stringify({version:2,acceptedAt:'2026-10-09'}));
    localStorage.setItem('coomi.prefs.v2', JSON.stringify({minimalUi:true,motion:true,fontFamily:'harmony'}));
  ` })
  await send('Page.navigate', { url })
  let ready = false
  for (let i = 0; i < 300; i++) {
    ready = await evaluate(`!!document.querySelector('[data-shell-part="rail"]')`)
    if (ready) break
    await wait(100)
  }
  assert.ok(ready, 'app mounted')
  await evaluate(`(async () => {
    const loaded = file => performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/stores/' + file + '.ts')?.name || '/src/stores/' + file + '.ts';
    const {useSession} = await import(loaded('session'));
    const {useEngine} = await import(loaded('engine'));
    const {useUi} = await import(loaded('ui'));
    const {applyEventsToMessages} = await import('/src/lib/chat.ts');
    window.perfSession = {useSession,useEngine,useUi,applyEventsToMessages,loadSessions:useSession.getState().loadSessions};
    const api = async path => path.includes('providers') ? {providers:[],models:[]} : {sessions:[],skills:[],mcp:[],tasks:[],entries:[],runtimes:[],views:[],files:[],artifacts:[]};
    useEngine.setState({ready:true,status:'running',api});
    useSession.setState({sessionId:'perf',sessions:[{id:'perf',title:'Render benchmark',running:false}],historyLoaded:{perf:true},messages:[],connected:true,connecting:false,loadSessions:async()=>{}});
    window.perfStart = () => {
      window.perfSamples = {longTasks:[],frames:[]};
      window.perfObserver = new PerformanceObserver(list => list.getEntries().forEach(e => perfSamples.longTasks.push(e.duration)));
      perfObserver.observe({type:'longtask'});
      let last=performance.now();
      const frame = now => {perfSamples.frames.push(now-last);last=now;window.perfFrame=requestAnimationFrame(frame)};
      window.perfFrame=requestAnimationFrame(frame);
    };
    window.perfStop = () => {cancelAnimationFrame(perfFrame);perfObserver.disconnect();return perfSamples};
  })()`)
  await wait(1500)
  await send('Performance.enable')
  const idleBefore = await send('Performance.getMetrics')
  await evaluate('perfStart()')
  await wait(5000)
  const idleAfter = await send('Performance.getMetrics')
  const idleSamples = await evaluate(`({ ...perfStop(), nodes:document.querySelectorAll('*').length,
    animations:document.getAnimations().filter(a=>a.playState==='running').map(a=>({target:a.effect?.target?.className,name:a.animationName})) })`)
  const metric = (data,name) => data.metrics.find(m=>m.name===name)?.value || 0
  const idleCpu = (metric(idleAfter,'TaskDuration')-metric(idleBefore,'TaskDuration'))*1000
  const polling = await evaluate(`(async () => {
    const {useSession:s,useEngine:e,loadSessions}=perfSession;
    const previousApi=e.getState().api;
    let running=false;
    e.setState({api:async()=>({sessions:[{id:'perf',title:'Render benchmark',running}]})});
    await loadSessions();
    const initial=s.getState().sessions;
    await loadSessions();await loadSessions();
    const unchanged=s.getState().sessions===initial;
    running=true;await loadSessions();
    const changed=s.getState().sessions!==initial && s.getState().sessions[0].running===true;
    e.setState({api:previousApi});
    return {unchanged,changed};
  })()`)
  await evaluate(`perfStart(); (() => {
    const messages=[];
    for(let i=0;i<24;i++) {
      messages.push({kind:'user',id:'u'+i,text:'History '+i,anchorSeq:i*2,at:1});
      const tools=Array.from({length:30},(_,j)=>({callId:'t'+i+'-'+j,name:'read_file',status:'done',args:JSON.stringify({path:'C:/project/file'+j}),preview:'result '.repeat(200),elapsedMs:5}));
      messages.push({kind:'assistant',id:'a'+i,text:'Completed reply '+i,reasoning:'Reasoning '.repeat(100),tools,segments:[{kind:'tools',callIds:tools.map(t=>t.callId)},{kind:'text',text:'Completed reply '+i}],streaming:false,anchorSeq:i*2+1,at:1});
    }
    perfSession.useSession.setState({messages});
  })()`)
  await wait(2000)
  const history = await evaluate(`({ ...perfStop(), nodes:document.querySelectorAll('[data-msg-scroller] *').length, toolDetails:document.querySelectorAll('[data-msg-scroller] pre').length })`)
  await evaluate(`(() => {
    const s=perfSession.useSession;
    const user={kind:'user',id:'live-user',text:'Stream benchmark',anchorSeq:48,at:1};
    s.setState({messages:[...s.getState().messages,user],streaming:true});
    window.perfText='| A | B |\\n| --- | --- |\\n| one | two |\\n\\n';
    s.setState({messages:perfSession.applyEventsToMessages(s.getState().messages,[{event_type:'text_chunk',content:perfText}],49)});
  })()`)
  await wait(1000)
  await evaluate(`perfStart(); (async () => {
    const s=perfSession.useSession;
    for(let i=0;i<180;i++) {
      const piece='streaming paragraph '+i+' '+('text '.repeat(24))+'\\n\\n';
      perfText+=piece;
      s.setState({messages:perfSession.applyEventsToMessages(s.getState().messages,[{event_type:'text_chunk',content:piece}],50+i)});
      await new Promise(r=>setTimeout(r,32));
    }
  })()`)
  // Let React's deferred stream commit finish before checking for missing text.
  await wait(250)
  const stream = await evaluate(`({ ...perfStop(), streamingTables:document.querySelectorAll('.md-body table').length, textPresent:document.querySelector('[data-msg-scroller]').textContent.includes(perfText.trim()) })`)
  await evaluate(`(() => {const s=perfSession.useSession;s.setState({messages:perfSession.applyEventsToMessages(s.getState().messages,[{event_type:'turn_end',ok:true,status:'completed'}],230),streaming:false})})()`)
  await wait(1500)
  const completedTables = await evaluate(`document.querySelectorAll('.md-body table').length`)
  const safeMode = await evaluate(`(async()=>{const {safeMode}=await import('/src/lib/guard.ts');return safeMode()})()`)
  const summarize = ({ frames, longTasks, ...rest }) => {
    const sorted = frames.slice().sort((a,b)=>a-b)
    return { ...rest, longTasks:longTasks.length, longTaskMs:Math.round(longTasks.reduce((a,b)=>a+b,0)),
      maxFrameMs:Math.round(Math.max(0,...frames)), p95FrameMs:Math.round(sorted[Math.floor(sorted.length*.95)] || 0) }
  }
  const report = { url, idle:{...summarize(idleSamples), mainThreadMs:Math.round(idleCpu)}, polling, history:summarize(history), stream:summarize(stream), completedTables, safeMode, errors }
  console.log(JSON.stringify(report,null,2))
  if (process.env.COOMI_PERF_OUTPUT) writeFileSync(process.env.COOMI_PERF_OUTPUT, JSON.stringify(report,null,2)+'\n')
  if (process.env.COOMI_PERF_ASSERT === '1') {
    assert.equal(errors.length,0,'no runtime exceptions')
    assert.equal(safeMode,false,'normal streaming must not silently force safe mode')
    assert.equal(polling.unchanged,true,'unchanged session polling preserves the array reference')
    assert.equal(polling.changed,true,'background running changes still update the session list')
    assert.equal(stream.streamingTables,0,'streaming never reparses Markdown tables')
    assert.equal(stream.textPresent,true,'all streamed content remains visible')
    assert.ok(completedTables>0,'completed response retains rich Markdown')
    assert.ok(history.toolDetails<100,'collapsed history does not mount all tool details')
    assert.ok(report.idle.mainThreadMs<750,'idle main thread uses less than 15% of 5 seconds')
    assert.ok(report.stream.p95FrameMs<100,'streaming frame p95 remains below 100 ms')
  }
} finally {
  ws?.close()
  browser.kill()
}
