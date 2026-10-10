import assert from 'node:assert/strict'
import { createStormProbe, setStormListener } from '../src/lib/stormProbe.ts'

const originalNow = Date.now
let now = 1000
const records = []
Date.now = () => now
setStormListener(record => records.push(record))
try {
  const probe = createStormProbe('ChatPage')
  for (let i=0;i<60;i++) { now += 16; probe.report('ChatPage','update',0.5) }
  assert.equal(records.length,0,'normal 60 fps updates are not a render storm')
  probe.reset();now=3000
  for (let i=0;i<120;i++) { now += 16; probe.report('ChatPage','update',8) }
  assert.equal(records.length,1,'sustained expensive rendering is still detected once per window')
  assert.ok(records[0].renderMs>=200)
  probe.reset();now=5000
  for(let i=0;i<21;i++){now+=16;probe.report('ChatPage','update',0.5)}
  assert.equal(records.length,1,'the screenshot burst of 21 commits does not trigger fallback')
  probe.reset();now=7000
  probe.report('ChatPage','mount',700)
  for(let i=0;i<60;i++){now+=16;probe.report('ChatPage','update',0.5)}
  assert.equal(records.length,1,'one costly history mount does not trigger persistent fallback')
  console.log('PASS: normal streaming, expensive render storm, single-window reporting and screenshot burst')
} finally { Date.now=originalNow;setStormListener(null) }
