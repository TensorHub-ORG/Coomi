<script setup lang="ts">
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import NoteLibrary from '@/components/NoteLibrary.vue'
import { useSessionStore } from '@/stores/session'
import { goBack } from '@/bridge/navigation'
const router=useRouter(),session=useSessionStore()
async function fill(text:string) {
  try {localStorage.setItem(`coomi.draft.${session.sessionId}`,text)}catch {/* dispatch remains available */}
  await router.push('/')
  window.dispatchEvent(new CustomEvent('coomi:prefill-draft',{detail:{sessionId:session.sessionId,text}}))
}
</script>
<template><div class="notes-page"><PageHead title="笔记" @back="goBack(router,'dashboard')" /><main><NoteLibrary @fill="fill" /></main></div></template>
<style scoped>.notes-page {height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bg)}main {flex:1;min-height:0;padding:12px 0 calc(12px + var(--safe-bottom));overflow:hidden}</style>
