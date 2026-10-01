/**
 * 由**壳**代取远端文本（技能 / 插件市场来源）。
 *
 * 为什么不让渲染进程自己 fetch：
 *   ① CSP：放行任意 https 等于把 connect-src 整个打开，CSP 就失去意义；
 *   ② WebView 的网络受系统代理 / PAC / 安全软件影响（我们为 localhost 建传输桥就是这个原因）；
 *   ③ CORS：部分市场来源不带跨域头，直接 fetch 会被浏览器拒掉。
 * 壳走 curl，这三条都不受影响。
 */
import { ipc } from './ipc'

export interface RemoteTextReply {
  ok: boolean
  status: number
  body: string
}

export async function fetchRemoteText(url: string, timeoutMs: number): Promise<RemoteTextReply> {
  try {
    const reply = await ipc<{ status: number; body: string }>('fetch_remote_text', {
      url,
      timeoutMs,
    })
    const status = typeof reply?.status === 'number' ? reply.status : 0
    return { ok: status >= 200 && status < 300, status, body: reply?.body ?? '' }
  } catch (error) {
    // 壳侧给的原因是具体的（DNS 解析失败 / 连接超时 / 证书问题），比浏览器的 TypeError 有用得多。
    const message = error instanceof Error ? error.message : String(error)
    throw new Error('取数失败：' + message)
  }
}
