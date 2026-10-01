/**
 * 文件芯片的「服务层」：状态校验缓存、原始字节读取、以及那几个动作（打开 / 复制 / 另存为 / 存为产物）。
 *
 * 四块内容，各自只有一条职责：
 *   1) **状态缓存**（useFileStatStore）：/api/fs/stat 的轻校验。一条消息里可能有几十个路径，
 *      所以这里有三个约束 —— 同一路径只发一次请求、并发上限 3、屏幕外的芯片先不校验（见 FileChip 的 useInView）。
 *      正结果缓存 5 分钟，负结果只缓存 20 秒（刚生成的文件不该被一次早到的「不存在」钉死）。
 *   2) **原始字节**（readRawBuffer / fileRawUrl）：xlsx / zip / docx 都要拿 ArrayBuffer，
 *      走 /api/fs/raw + Bearer 令牌；iframe（PDF）拿不到请求头，所以另给一个带 ?token= 的 URL。
 *   3) **动作**：在文件夹中打开 / 复制路径 / 用系统默认程序打开 / 存为产物。
 *      前三个复用右侧栏既有的实现；「另存为」不在这里 —— 它是全应用共用的一条路，
 *      统一走 lib/saveAs.ts 的 saveArtifactAs（那里已经处理好取消、失败文案与壳未就绪的降级）。
 *   4) **预览目标**（useFilePeek）：路径芯片左键点开的那一个文件。与 dockShared 的 useDockPreview
 *      分开存，是因为后者只认文本与图片；这里要接管 xlsx / pdf / zip / docx 这些「富文件」。
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { ipc } from '../../lib/ipc'
import { useEngine } from '../../stores/engine'
import { basename, copyPath, revealPath, statPath, useDockPreview } from '../shell/dockShared'
import { openDockTab } from '../shell/dockShared'
import { useRichStore } from './store'
import { joinRawPath, normalizePath } from './filePath'
import { filePreviewKind } from './fileTypes'
import { pathToFileUrl, sessionCwd } from './actions'

/* ── 1. 状态校验缓存 ── */

export type FileStatState = 'checking' | 'file' | 'dir' | 'missing'

export interface FileStatEntry {
  state: FileStatState
  size: number
  modified: number
  /** 写入缓存的时间戳（毫秒）。 */
  at: number
}

interface FileStatStore {
  stats: Record<string, FileStatEntry>
  /** 需要这个路径的状态时调用：命中缓存就什么都不做，否则排队校验。 */
  ensure: (path: string) => void
  /** 丢掉缓存并重新校验（「重新读取」用）。 */
  refresh: (path: string) => void
}

/** 正结果缓存 5 分钟；负结果只缓存 20 秒。 */
const TTL_HIT = 5 * 60_000
const TTL_MISS = 20_000
const MAX_ENTRIES = 500
const CONCURRENCY = 3

const pending = new Set<string>()
const queue: string[] = []
let active = 0

function put(path: string, entry: FileStatEntry): void {
  useFileStatStore.setState((state) => {
    const stats = { ...state.stats, [path]: entry }
    const keys = Object.keys(stats)
    if (keys.length <= MAX_ENTRIES) return { stats }
    // 超上限：按写入时间丢掉最旧的四分之一，避免长会话把缓存撑成内存泄漏。
    keys.sort((a, b) => (stats[a]?.at ?? 0) - (stats[b]?.at ?? 0))
    const drop = new Set(keys.slice(0, Math.ceil(keys.length / 4)))
    const next: Record<string, FileStatEntry> = {}
    for (const key of keys) if (!drop.has(key)) next[key] = stats[key] as FileStatEntry
    return { stats: next }
  })
}

function pump(): void {
  while (active < CONCURRENCY && queue.length) {
    const path = queue.shift() as string
    pending.delete(path)
    active += 1
    void statPath(path).then(
      (info) => put(path, {
        state: info.exists ? (info.isDir ? 'dir' : 'file') : 'missing',
        size: info.size,
        modified: info.modified,
        at: Date.now(),
      }),
      () => put(path, { state: 'missing', size: 0, modified: 0, at: Date.now() }),
    ).finally(() => { active -= 1; pump() })
  }
}

export const useFileStatStore = create<FileStatStore>((set, get) => ({
  stats: {},
  ensure: (raw) => {
    const path = String(raw ?? '').trim()
    if (!path) return
    const entry = get().stats[path]
    if (entry && entry.state !== 'checking' && entry.state !== 'missing' && Date.now() - entry.at < TTL_HIT) return
    if (entry && entry.state === 'missing' && Date.now() - entry.at < TTL_MISS) return
    if (pending.has(path) || queue.indexOf(path) !== -1) return
    pending.add(path)
    queue.push(path)
    if (!entry) put(path, { state: 'checking', size: 0, modified: 0, at: 0 })
    pump()
  },
  refresh: (path) => {
    const key = String(path ?? '').trim()
    if (!key) return
    const stats = { ...get().stats }
    delete stats[key]
    set({ stats })
    get().ensure(key)
  },
}))

/** 组件里读状态：自动在挂载 / 路径变化时补一次校验。 */
export function useFileStat(path: string): FileStatEntry | undefined {
  const entry = useFileStatStore((s) => (path ? s.stats[path] : undefined))
  useEffect(() => {
    if (path) useFileStatStore.getState().ensure(path)
  }, [path])
  return entry
}

export function formatSize(bytes: number): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
  return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/** 状态 → 悬停提示里那句「在不在」。 */
export function statSummary(entry: FileStatEntry | undefined): string {
  if (!entry) return '未校验'
  if (entry.state === 'checking') return '校验中…'
  if (entry.state === 'dir') return '是个目录'
  if (entry.state === 'missing') return '文件不存在'
  return '存在 · ' + formatSize(entry.size)
}

/* ── 2. 原始字节 ── */

/** 读原始内容的 URL（带令牌）：iframe / <img> 这类拿不到请求头的地方用它。 */
export function fileRawUrl(path: string): string {
  const engine = useEngine.getState()
  return 'http://127.0.0.1:' + engine.port + '/api/fs/raw?path=' + encodeURIComponent(path)
    + '&token=' + encodeURIComponent(engine.token)
}

/** 文件超过上限时抛这个：调用方按「只给文件信息」降级，而不是当成失败。 */
export class OversizedFileError extends Error {
  readonly bytes: number
  constructor(bytes: number, limit: number) {
    super('文件 ' + formatSize(bytes) + ' 超过预览上限 ' + formatSize(limit))
    this.name = 'OversizedFileError'
    this.bytes = bytes
  }
}

/** 读文件的原始字节（带 Bearer 令牌），超过 maxBytes 直接抛 OversizedFileError。 */
export async function readRawBuffer(path: string, maxBytes: number): Promise<ArrayBuffer> {
  const engine = useEngine.getState()
  const res = await fetch('http://127.0.0.1:' + engine.port + '/api/fs/raw?path=' + encodeURIComponent(path), {
    headers: engine.authHeaders(),
  })
  if (!res.ok) throw new Error('读取失败：HTTP ' + res.status)
  // 先看 Content-Length：已知超限就直接拒绝，一个字节都不下载（以前是先全量读进内存再判断，上限形同虚设）。
  const declared = Number(res.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new OversizedFileError(declared, maxBytes)
  // 长度缺失 / 不可信时流式读取并累计；一旦超限立刻 cancel，不再把整个大文件读进内存。
  const reader = res.body?.getReader()
  if (reader) {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => { /* 忽略 */ })
        throw new OversizedFileError(total, maxBytes)
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
    return merged.buffer
  }
  // 拿不到流（老内核）：退回一次性读取，行为与以前一致。
  const buffer = await res.arrayBuffer()
  if (buffer.byteLength > maxBytes) throw new OversizedFileError(buffer.byteLength, maxBytes)
  return buffer
}

/** 纯文本预览的读取上限（与 dockShared.readRawText 同一口径）：几 MB 的日志直接塞进 DOM 会卡死。 */
const TEXT_PREVIEW_MAX = 400_000

/** 读文本给预览用；超长就截断并明确标注。 */
export async function readRawTextPreview(path: string): Promise<string> {
  const engine = useEngine.getState()
  const res = await fetch('http://127.0.0.1:' + engine.port + '/api/fs/raw?path=' + encodeURIComponent(path), {
    headers: engine.authHeaders(),
  })
  if (!res.ok) throw new Error('读取失败：HTTP ' + res.status)
  // 文本预览**不**因 Content-Length 超限就抛错 —— 既有语义是"截断并标注"，让它报错是体验回退。
  // 但仍然要流式读取、到上限立刻 cancel：以前是 await res.text() 先把整个文件读进内存再截断。
  const declared = Number(res.headers.get('Content-Length'))
  const reader = res.body?.getReader()
  let text = ''
  let truncated = Number.isFinite(declared) && declared > TEXT_PREVIEW_MAX
  if (reader) {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (total + value.byteLength > TEXT_PREVIEW_MAX) {
        // 只取到上限为止的那一段就够渲染：cancel 掉剩余响应，不再往内存里搬。
        chunks.push(value.subarray(0, TEXT_PREVIEW_MAX - total))
        total = TEXT_PREVIEW_MAX
        await reader.cancel().catch(() => { /* 忽略 */ })
        truncated = true
        break
      }
      total += value.byteLength
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
    text = new TextDecoder().decode(merged)
  } else {
    // 拿不到流（老内核）：退回一次性读取，行为与以前一致。
    text = await res.text()
    if (text.length > TEXT_PREVIEW_MAX) {
      text = text.slice(0, TEXT_PREVIEW_MAX)
      truncated = true
    }
  }
  return truncated ? text + '\n\n…（内容过长，已截断）' : text
}

/* ── 3. 动作 ── */

/** 在文件夹中打开（资源管理器）。 */
export function revealFile(path: string): Promise<void> {
  return revealPath(path)
}

/** 复制完整路径。 */
export function copyFilePath(path: string): Promise<void> {
  return copyPath(path)
}

/** 用系统默认程序打开。 */
export async function openFileWithSystem(path: string): Promise<void> {
  await ipc('open_external', { url: pathToFileUrl(path) })
}

/**
 * 存为产物：把文件复制进当前会话工作目录（引擎的 /api/fs/copy，二进制安全）。
 * 同名时自动加 -1 / -2 后缀，绝不覆盖工作区里已有的文件。
 */
export async function copyFileAsArtifact(path: string): Promise<string> {
  const source = String(path ?? '').trim()
  if (!source) throw new Error('没有可复制的文件路径')
  const cwd = sessionCwd()
  if (!cwd) throw new Error('还没有工作目录：先打开一个会话或选一个目录，文件才有地方落盘')
  const name = basename(source)
  let target = joinRawPath(cwd, name)
  let index = 0
  while (index < 50) {
    const info = await statPath(target)
    if (!info.exists) break
    index += 1
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    target = joinRawPath(cwd, stem + '-' + index + ext)
  }
  await useEngine.getState().api('/api/fs/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: normalizePath(source), to: normalizePath(target) }),
  })
  useRichStore.getState().bumpArtifacts(target)
  return target
}

/** 没有工作目录时给一句统一的解释（芯片点击与右键菜单都用它）。 */
export const NO_CWD_NOTE = '这个相对路径解析不出绝对位置：先打开一个会话（或选一个工作目录）再点。'

/* ── 4. 预览目标：路径芯片左键点开的那一个文件 ── */

interface FilePeekState {
  path: string
  name: string
  /** 文本 / Markdown 文件的正文（其它类型留空，由各自的预览器自己读）。 */
  text: string
  loading: boolean
  error: string
  at: number
  open: (path: string) => void
  /** 「重新读取」：按当前路径再取一次正文（富文件由 PreviewPanel 的 key 重建预览器）。 */
  reload: () => void
  close: () => void
}

/** 只有这两类要在这里先把正文读出来：其余（图片 / 富文件）由各自的预览器自己取。 */
function needsText(path: string): boolean {
  const kind = filePreviewKind(path)
  return kind === 'text' || kind === 'markdown'
}

export const useFilePeek = create<FilePeekState>((set, get) => ({
  path: '',
  name: '',
  text: '',
  loading: false,
  error: '',
  at: 0,
  open: (raw) => {
    const path = String(raw ?? '').trim()
    if (!path) return
    // 先把「产物 / 文件页签」那一份预览关掉：PreviewPanel 里它优先级更高，
    // 不清掉的话刚点开的芯片会被上一次的预览路径压住（换页签的 effect 也顺带把它收掉）。
    useDockPreview.setState({ path: '', name: '', text: '', loading: false, error: '' })
    set({ path, name: basename(path), text: '', loading: needsText(path), error: '', at: Date.now() })
    // 这一句同时把侧栏打开并切到「预览」页签；PreviewPanel 见到本 store 有值就渲染文件预览。
    openDockTab('preview')
    if (needsText(path)) void loadText(set, get, path)
  },
  reload: () => {
    const path = get().path
    if (!path) return
    set({ text: '', loading: needsText(path), error: '' })
    if (needsText(path)) void loadText(set, get, path)
  },
  close: () => set({ path: '', name: '', text: '', loading: false, error: '', at: 0 }),
}))

/** 取一次正文并写回；期间用户又点了别的文件就丢弃这次结果（避免串台）。 */
async function loadText(
  set: (partial: Partial<FilePeekState>) => void,
  get: () => FilePeekState,
  path: string,
): Promise<void> {
  try {
    const text = await readRawTextPreview(path)
    if (get().path !== path) return
    set({ text, loading: false, error: '' })
  } catch (error) {
    if (get().path !== path) return
    set({ text: '', loading: false, error: error instanceof Error ? error.message : String(error) })
  }
}
