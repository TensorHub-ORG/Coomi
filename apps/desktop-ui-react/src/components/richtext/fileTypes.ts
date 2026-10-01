/**
 * 「按扩展名决定怎么预览」的唯一登记处：路径芯片的提示、右侧栏预览分发器、
 * 以及各预览器自己的大小闸都读这里，避免同一份扩展名表在四五处各写一遍。
 *
 * 这里只有纯函数与常量，不 import 任何预览实现 —— 它是主包里的东西，
 * 一旦在这里 import xlsx / mammoth，懒加载就白做了。
 */

/** 预览方式：默认走系统打开之外的六种只读预览 + 纯文本兜底。 */
export type FilePreviewKind =
  | 'sheet' | 'pdf' | 'zip' | 'docx' | 'markdown' | 'html' | 'image' | 'text' | 'binary'

const SHEET_EXT = new Set(['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv'])
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd'])
const HTML_EXT = new Set(['html', 'htm', 'xhtml'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])
const TEXT_EXT = new Set([
  'txt', 'log', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'css', 'scss', 'less', 'xml',
  'py', 'rs', 'go', 'java', 'kt', 'kts', 'swift', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sql', 'patch', 'diff', 'rst', 'properties', 'lock', 'gitignore',
])

/** 取小写扩展名（不带点）；没有扩展名时是空串。路径与文件名都吃。 */
export function previewExtension(path: string): string {
  const name = String(path ?? '').split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** 路径 → 预览方式。认不出的一律 binary（显示文件信息 + 交给系统打开）。 */
export function filePreviewKind(path: string): FilePreviewKind {
  const ext = previewExtension(path)
  if (!ext) return 'binary'
  if (SHEET_EXT.has(ext)) return 'sheet'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'zip') return 'zip'
  if (ext === 'docx') return 'docx'
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  if (HTML_EXT.has(ext)) return 'html'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'binary'
}

/** 「右侧栏要不要把它当成文件预览来渲染」：这些类型都有自己的只读预览器。 */
export function isRichFileKind(kind: FilePreviewKind): boolean {
  return kind === 'sheet' || kind === 'pdf' || kind === 'zip' || kind === 'docx' || kind === 'html' || kind === 'binary'
}

export const FILE_KIND_TITLE: Record<FilePreviewKind, string> = {
  sheet: '表格预览',
  pdf: 'PDF 预览',
  zip: '压缩包目录',
  docx: 'Word 文档预览',
  markdown: 'Markdown 预览',
  html: 'HTML 沙箱预览',
  image: '图片预览',
  text: '文本预览',
  binary: '文件信息',
}

/* ── 各预览器的大小闸 ──
   三道闸的口径一致：先读文件大小，超限就只给「文件信息 + 用系统打开」，
   绝不把 200MB 的 xlsx 读进内存再让 SheetJS 解析。 */

/** 表格：5MB（需求口径）。 */
export const SHEET_MAX_BYTES = 5 * 1024 * 1024
/** 表格：最多解析 5 万行（超出的行不解析，也不渲染）。 */
export const SHEET_MAX_ROWS = 50_000
/** 表格：一次最多往 DOM 里塞多少行（其余按需「再显示 N 行」）。 */
export const SHEET_PAGE_ROWS = 200
/** 压缩包：条目表最多列这么多行。 */
export const ZIP_MAX_BYTES = 32 * 1024 * 1024
export const ZIP_MAX_ENTRIES = 5_000
/** Word：一份 docx 体积上限。 */
export const DOCX_MAX_BYTES = 20 * 1024 * 1024
/** HTML：注入沙箱的源码上限。 */
export const HTML_MAX_BYTES = 4 * 1024 * 1024

/** 人类可读的大小（预览器提示语里用，避免每处各写一份）。 */
export function formatBytes(bytes: number): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
  return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}
