<script setup lang="ts">
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import PromptLibrary from '@/components/PromptLibrary.vue'
import { useSessionStore } from '@/stores/session'
import { goBack } from '@/bridge/navigation'
const router = useRouter(), session = useSessionStore()
async function fill(text: string) {
  try { localStorage.setItem(`coomi.draft.${session.sessionId}`, text) } catch { /* live event still fills mounted composer */ }
  await router.push('/')
  window.dispatchEvent(new CustomEvent('coomi:prefill-draft', { detail: { sessionId: session.sessionId, text } }))
}
</script>
<template><div class="prompts-page"><PageHead title="常用提示词指令" @back="goBack(router, 'dashboard')" /><main><PromptLibrary @fill="fill" /></main></div></template>
<style scoped>
.prompts-page {height:100%; min-height:0; display:flex; flex-direction:column; background:var(--bg)}
main {flex:1; min-height:0; width:100%; max-width:760px; margin-inline:auto; padding:12px 16px calc(12px + var(--safe-bottom)); overflow:hidden}
</style>
