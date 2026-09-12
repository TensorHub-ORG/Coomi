// HTTP API 基址推导。
// 生产：web 由 bridge 同源伺服 → 用相对路径（base=""）。
// 开发：若设了 VITE_ENGINE_WS（ws://host:port），推导出 http://host:port。
function deriveBase(): string {
  const ws = import.meta.env.VITE_ENGINE_WS as string | undefined
  if (!ws) return '' // same-origin
  try {
    const u = new URL(ws)
    const proto = u.protocol === 'wss:' ? 'https:' : 'http:'
    return `${proto}//${u.host}`
  } catch {
    return ''
  }
}

export const API_BASE = deriveBase()

/**
 * 引擎访问令牌：由 Android 侧注入页面 URL query（?token=…）。
 * 仅在模块加载时读取一次，并立即用 history.replaceState 从地址栏/浏览器历史中
 * 清除，避免令牌持久留在系统浏览器历史、跨设备同步或扩展可见范围内。
 */
const ENGINE_TOKEN: string = (() => {
  try {
    const token = new URLSearchParams(window.location.search).get('token') ?? ''
    if (token && window.history?.replaceState) {
      const url = new URL(window.location.href)
      url.searchParams.delete('token')
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
    return token
  } catch {
    return ''
  }
})()

/** 引擎访问令牌（模块加载时已捕获；URL query 已即时清除）。 */
export function engineToken(): string {
  return ENGINE_TOKEN
}

/** 带引擎令牌的 fetch：所有 /api/* 与 /ws/* 请求必须携带 Bearer token。 */
export async function authedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers)
  const token = engineToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(input, { ...init, headers })
}

export async function apiGet<T>(path: string): Promise<T> {
  const r = await authedFetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    // The Android WebView may keep a JSON response fresh for the whole run;
    // studio polling must always observe messages written since the last tick.
    cache: 'no-store',
  })
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`)
  return r.json() as Promise<T>
}

export async function apiSend<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  // axum 的 Json<T> 提取器对「Content-Type: application/json + 空 body」直接 400。
  // 可选参数不传时（如 /api/git/ai/*、/api/git/stash/push）统一发送 {}，
  // 让所有可选 body 端点保持健壮；DELETE 不附加 body。
  const payload = body !== undefined
    ? JSON.stringify(body)
    : method === 'POST' || method === 'PUT' ? '{}' : undefined
  const r = await authedFetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: payload,
  })
  if (!r.ok) {
    let msg = `${method} ${path} → ${r.status}`
    try { const e = await r.json(); if (e?.error) msg = e.error } catch { /* ignore */ }
    throw new Error(msg)
  }
  return r.json() as Promise<T>
}
