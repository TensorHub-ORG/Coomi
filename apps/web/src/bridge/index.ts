import { WsTransport } from './wsTransport'
import { DemoTransport } from './demoTransport'
import { isDemoMode } from './demoMode'
import { engineToken } from './http'
import type { Transport } from './transport'

export type { Transport, ConnectionState, ConnectionStatus } from './transport'

export function createTransport(sessionId: string, wsUrl?: string): Transport {
  // 演示模式不碰网络：引擎没起来也要能看界面。界面上有「演示」标记。
  if (isDemoMode()) return new DemoTransport()
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const base = wsUrl || import.meta.env.VITE_ENGINE_WS || `${protocol}//${location.host}`
  const url = base.includes('/ws/') ? base : `${base.replace(/\/$/, '')}/ws/session/${sessionId}`
  // WS 握手无法带自定义 header，改用 query 传令牌（引擎中间件同样校验）。
  const token = engineToken()
  const urlWithToken = token
    ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
    : url
  const maxRetries = Number(localStorage.getItem('coomi.wsRetryCount'))
  const backoffBase = Number(localStorage.getItem('coomi.reconnectInitialDelayMs'))
  const backoffMax = Number(localStorage.getItem('coomi.reconnectMaxDelayMs'))
  return new WsTransport({
    url: urlWithToken,
    maxRetries: Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 30 ? maxRetries : 10,
    backoffBase: Number.isFinite(backoffBase) && backoffBase >= 500 && backoffBase <= 60_000 ? backoffBase : 500,
    backoffMax: Number.isFinite(backoffMax) && backoffMax >= 1_000 && backoffMax <= 120_000 ? backoffMax : 10_000,
  })
}
