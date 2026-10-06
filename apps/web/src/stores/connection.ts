import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ConnectionState, ConnectionStatus } from '@/bridge'
import { isDemoMode } from '@/bridge/demoMode'

export const useConnectionStore = defineStore('connection', () => {
  const state = ref<ConnectionState>('connecting')
  const retryMessage = ref<string | null>(null)
  const retryAttempt = ref(0)
  const retryMax = ref(0)
  const retryDelayMs = ref(0)
  const wsUrl = ref('')
  const isOpen = computed(() => state.value === 'open')
  /** 演示模式：底下接的是脚本，不是引擎。所有状态文案都要说清这件事。 */
  const demo = ref(isDemoMode())

  const label = computed(() => {
    if (demo.value) return '演示模式（未连引擎）'
    switch (state.value) {
      case 'connecting': return '连接中…'
      case 'reconnecting': return retryMessage.value || '正在重连…'
      case 'open': return '已连接'
      case 'closed': return '已断开'
      case 'error': return '连接错误'
    }
  })

  function setStatus(status: ConnectionStatus) {
    state.value = status.state
    retryAttempt.value = status.attempt ?? 0
    retryMax.value = status.maxRetries ?? 0
    retryDelayMs.value = status.delayMs ?? 0
    retryMessage.value = status.state === 'reconnecting'
      ? `第 ${retryAttempt.value}/${retryMax.value} 次重连，${Math.ceil(retryDelayMs.value / 1000)} 秒后尝试`
      : status.state === 'open' ? null : status.reason ?? null
  }
  function setState(s: ConnectionState) { setStatus({ state: s }) }
  function setRetry(msg: string | null) { retryMessage.value = msg }
  function setWsUrl(url: string) { wsUrl.value = url }

  return { state, retryMessage, retryAttempt, retryMax, retryDelayMs, wsUrl, isOpen, demo, label, setStatus, setState, setRetry, setWsUrl }
})
