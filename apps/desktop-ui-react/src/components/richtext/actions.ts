/**
 * 富块动作的公共实现：复制 / 下载 / 新窗口打开 / 存为产物。
 * 三个入口（代码块动作条、右侧栏预览页签、预览页签的工具条）都调这里，行为保持一致。
 */
import { useEngine } from '../../stores/engine'
import { useSession } from '../../stores/session'
import { useRichStore } from './store'
import type { RichBlock } from './store'
import { KIND_EXT, KIND_MIME } from './detect'

/* ── 复制 ── */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch { /* 剪贴板不可用（非安全上下文 / 被拒）时走兜底 */ }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

/* ── 下载 ── */

export function blockFileName(block: RichBlock, stamp = Date.now()): string {
  const ext = block.kind === 'code' ? (block.lang || KIND_EXT.code) : KIND_EXT[block.kind]
  return 'coomi-' + block.kind + '-' + stamp + '.' + ext
}

export function downloadText(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 在部分 WebView 里会把下载掐断，给 30s 缓冲。
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function downloadBlock(block: RichBlock): void {
  const ext = block.kind === 'code' ? (block.lang || 'txt') : KIND_EXT[block.kind]
  const mime = block.kind === 'code' ? 'text/plain' : KIND_MIME[block.kind]
  downloadText('coomi-' + block.kind + '-' + Date.now() + '.' + ext, block.code, mime)
}

/* ── 新窗口打开 ──
   三步兜底，任何一步成功就返回：
     1) window.open 真的给了窗口 → 直接把独立文档写进去（内容自包含）；
     2) 交给桌面壳用系统默认程序打开（blob/data 之外先落盘，见下）；
     3) 都不行就下载成文件，并告诉用户为什么。 */

export function standaloneDocument(block: RichBlock): string {
  const escaped = block.code.replace(/<\/script/gi, '<\\/script')
  if (block.kind === 'svg') {
    return '<!doctype html><meta charset="utf-8"><title>Coomi SVG</title><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100%}</style>' + block.code
  }
  if (block.kind === 'html') return block.code
  if (block.kind === 'css') {
    return '<!doctype html><meta charset="utf-8"><title>Coomi CSS</title><style>' + block.code.replace(/<\/style/gi, '<\\/style') + '</style>'
      + '<h1>标题 H1</h1><p>正文段落，用来观察排版、行高与颜色。</p><button>按钮</button>'
  }
  if (block.kind === 'mermaid') {
    // Mermaid 需要渲染器，独立文档里只给源码 + 说明，不硬塞一个联网 CDN。
    return '<!doctype html><meta charset="utf-8"><title>Coomi Mermaid</title><pre style="font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;padding:12px">' + escapeHtml(block.code) + '</pre>'
  }
  if (block.kind === 'json' || block.kind === 'csv' || block.kind === 'diff' || block.kind === 'math') {
    return '<!doctype html><meta charset="utf-8"><title>Coomi ' + block.kind + '</title><pre style="font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;padding:12px">' + escapeHtml(block.code) + '</pre>'
  }
  return '<!doctype html><meta charset="utf-8"><title>Coomi ' + block.kind + '</title><pre style="font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;padding:12px">' + escapeHtml(escaped) + '</pre>'
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export type OpenWindowResult = 'window' | 'system' | 'failed'

export async function openBlockInNewWindow(block: RichBlock): Promise<OpenWindowResult> {
  const html = standaloneDocument(block)
  // 1) 直接开一个空白窗口写进去：桌面 WebView 与浏览器都可能放行。
  try {
    const win = window.open('', '_blank')
    if (win && win.document) {
      win.document.open()
      win.document.write(html)
      win.document.close()
      return 'window'
    }
  } catch { /* 被拦截就往下走 */ }

  // 2) 交给系统默认程序：先落盘拿到真实文件路径，再让壳打开（blob:/data: 系统浏览器都不可靠）。
  try {
    const path = await writePreviewFile(block, 'open')
    const { ipc } = await import('../../lib/ipc')
    await ipc('open_external', { url: pathToFileUrl(path) })
    return 'system'
  } catch { /* 壳不可用（浏览器里跑）就下载 */ }

  // 3) 最后兜底：下载成文件。
  try {
    downloadText(blockFileName(block), html, 'text/html')
    return 'failed'
  } catch {
    return 'failed'
  }
}

export function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.startsWith('/') ? 'file://' + encodeURI(normalized) : 'file:///' + encodeURI(normalized)
}

/* ── 存为产物 ──
   写进当前会话的工作目录（和 Markdown 里原来的「另存到工作目录」同一套语义：
   引擎的 /api/fs/write 直接落盘，不弹原生对话框）。 */

export function sessionCwd(): string {
  const session = useSession.getState()
  const fromSession = session.sessions.find((x) => x.id === session.sessionId)?.cwd
  return (fromSession || session.pendingCwd || useEngine.getState().cwd || '').trim()
}

async function writePreviewFile(block: RichBlock, tag: string): Promise<string> {
  const cwd = sessionCwd()
  if (!cwd) throw new Error('还没有工作目录：先打开一个会话或选一个目录，预览文件才有地方落盘')
  const file = 'coomi-' + tag + '-' + block.kind + '-' + Date.now() + '.' + (block.kind === 'code' ? (block.lang || 'txt') : KIND_EXT[block.kind])
  const path = cwd.replace(/[\\/]+$/, '') + '/' + file
  await useEngine.getState().api('/api/fs/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content: block.kind === 'html' ? standaloneDocument(block) : block.code }),
  })
  return path
}

/** 存为产物：失败抛可读错误，调用方负责 toast。 */
export async function saveBlockAsArtifact(block: RichBlock): Promise<string> {
  try {
    const path = await writePreviewFile(block, 'artifact')
    useRichStore.getState().bumpArtifacts(path)
    return path
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(describeWriteError(message))
  }
}

/** 把引擎的报错翻译成用户能看懂的一句话（原来的提示只有 HTTP 码，看不出该干什么）。 */
function describeWriteError(message: string): string {
  if (/404/.test(message)) return '引擎没有 /api/fs/write 接口（可能引擎版本较旧）：' + message
  if (/401|403/.test(message)) return '引擎拒绝了写入（鉴权失败，重启一下应用试试）：' + message
  if (/工作目录/.test(message)) return message
  return '写入会话工作区失败：' + message
}
