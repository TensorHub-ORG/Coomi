import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { BUILTIN_PROMPTS, parsePrompts, PROMPT_STORAGE_KEY, savePrompt, type SavedPrompt } from '@/utils/promptLibrary'
import { apiGet, apiSend } from '@/bridge/http'

export const usePromptsStore = defineStore('prompts', () => {
  const custom = ref<SavedPrompt[]>([])
  const error = ref('')
  const busy = ref(false)
  let loaded = false
  let fetching: Promise<void> | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let pending = 0
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    pending += 1
    busy.value = true
    const result = queue.then(operation)
    // Failed requests must not prevent later retries from running.
    queue = result.catch(() => undefined)
    return result.finally(() => { pending -= 1; busy.value = pending > 0 })
  }
  try { custom.value = parsePrompts(localStorage.getItem(PROMPT_STORAGE_KEY)) } catch { error.value = '无法读取本机提示词' }
  const all = computed(() => [...custom.value, ...BUILTIN_PROMPTS])
  function cache(next: SavedPrompt[]) {
    custom.value = next
    try { localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(next)) } catch { /* engine file is authoritative */ }
  }
  function refresh(): Promise<void> {
    if (fetching) return fetching
    fetching = enqueue(loadRemote).finally(() => { fetching = null })
    return fetching
  }
  async function loadRemote() {
      try {
        const result = await apiGet<{ prompts: SavedPrompt[] }>('/api/prompts')
        if (!Array.isArray(result.prompts)) throw new Error('提示词数据格式异常')
        cache(parsePrompts(JSON.stringify(result.prompts)))
        loaded = true
        error.value = ''
      } catch { error.value = '无法读取提示词文件，请连接引擎后重试' }
  }
  async function persist(next: SavedPrompt[]) {
    try {
      await apiSend('/api/prompts', 'PUT', { prompts: next })
      cache(next)
      error.value = ''
      return true
    } catch (e) { error.value = `保存失败：${e instanceof Error ? e.message : e}`; return false }
  }
  async function save(draft: SavedPrompt) {
    const entry = { ...draft, tags: [...draft.tags] }
    return enqueue(async () => {
      if (!loaded) await loadRemote()
      if (!loaded) return false
      try { return await persist(savePrompt(custom.value, entry)) }
      catch (e) { error.value = e instanceof Error ? e.message : String(e); return false }
    })
  }
  async function remove(id: string) {
    return enqueue(async () => {
      if (!loaded) await loadRemote()
      if (!loaded) return false
      return persist(custom.value.filter(p => p.id !== id))
    })
  }
  window.addEventListener('storage', event => {
    if (event.key === PROMPT_STORAGE_KEY) custom.value = parsePrompts(event.newValue)
  })
  return { custom, all, error, busy, refresh, save, remove }
})
