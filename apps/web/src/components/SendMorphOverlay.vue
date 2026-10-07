<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useConfigStore } from '@/stores/config'
import { prefersReducedMotion } from '@/composables/useGsap'
interface RectSnapshot { left: number; top: number; width: number; height: number }
interface MorphRequest { messageId: string; source: RectSnapshot }
const session=useSessionStore(), config=useConfigStore()
const dot=ref<HTMLElement|null>(null), ripple=ref<HTMLElement|null>(null), active=ref(false)
let disposed=false, epoch=0
let running:Animation[]=[]
const pending=new Set<string>()
const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
function finish(id:string) { session.completeSendMorph(id);pending.delete(id) }
function stop() {
  epoch++
  for(const a of running) a.cancel()
  running=[];active.value=false
  for(const id of pending) session.completeSendMorph(id)
  pending.clear()
}
async function run(detail:MorphRequest) {
  if(active.value||disposed||prefersReducedMotion()||!config.sendMorphAnimation){finish(detail.messageId);return}
  active.value=true
  const ticket=++epoch
  const valid=()=>!disposed&&ticket===epoch&&!config.allAnimationsOff
  try {
    let target:HTMLElement|null=null
    for(let tries=0;tries<12&&valid();tries++) {
      await frame()
      const escaped=CSS.escape(detail.messageId)
      target=document.querySelector(`[data-message-id="${escaped}"] .bubble`)
      if(target&&target.getBoundingClientRect().width>0)break
    }
    const node=dot.value
    if(!valid()||!target||!node||!node.animate)return
    const end=target.getBoundingClientRect(), source=detail.source
    const sx=source.left+source.width/2-8, sy=source.top+source.height/2-8
    const tx=end.left+end.width/2-8,ty=end.top+end.height/2-8
    node.style.width='16px';node.style.height='16px'
    // One transform timeline, not competing translate/scale animations on the same node.
    const flight=node.animate([
      {transform:`translate(${sx}px,${sy}px) scale(1.4)`,opacity:.85},
      {transform:`translate(${sx}px,${sy}px) scale(.5)`,opacity:1,offset:.16},
      {transform:`translate(${sx+(tx-sx)*.55}px,${sy+(ty-sy)*.48-18}px) scale(.7)`,opacity:1,offset:.62},
      {transform:`translate(${tx}px,${ty}px) scale(.65)`,opacity:.9,offset:.85},
      {transform:`translate(${tx}px,${ty}px) scale(1.9)`,opacity:0},
    ],{duration:530,easing:'cubic-bezier(.2,.75,.25,1)',fill:'forwards'})
    running.push(flight)
    if(ripple.value) {
      ripple.value.style.left=`${tx+8}px`;ripple.value.style.top=`${ty+8}px`
      running.push(ripple.value.animate([
        {transform:'translate(-50%,-50%) scale(.3)',opacity:0},
        {opacity:.55,offset:.18},
        {transform:'translate(-50%,-50%) scale(1.5)',opacity:0},
      ],{duration:250,delay:370,easing:'ease-out',fill:'both'}))
    }
    await flight.finished
  } catch { /* cancelled or unsupported animation: reveal the actual message immediately */ }
  finally {
    finish(detail.messageId)
    if(ticket===epoch){for(const a of running)a.cancel();running=[];active.value=false}
  }
}
function onRequest(event:Event){const d=(event as CustomEvent<MorphRequest>).detail;if(!d?.messageId||!d.source)return;pending.add(d.messageId);void run(d)}
watch(()=>config.allAnimationsOff,off=>{if(off)stop()})
watch(()=>session.sessionId,stop)
onMounted(()=>{window.addEventListener('coomi:send-morph',onRequest);window.addEventListener('coomi:all-animations-off',stop)})
onBeforeUnmount(()=>{disposed=true;stop();window.removeEventListener('coomi:send-morph',onRequest);window.removeEventListener('coomi:all-animations-off',stop)})
</script>
<template><div v-show="active" ref="dot" class="send-morph-dot" aria-hidden="true"/><div v-show="active" ref="ripple" class="send-ripple" aria-hidden="true"/></template>
<style scoped>
.send-morph-dot{position:fixed;left:0;top:0;z-index:95;pointer-events:none;border-radius:50%;background:var(--blue);box-shadow:0 0 10px color-mix(in srgb,var(--blue) 35%,transparent);will-change:transform,opacity}
.send-ripple{position:fixed;width:30px;height:30px;z-index:94;pointer-events:none;border:1px solid var(--blue);border-radius:50%}
</style>
