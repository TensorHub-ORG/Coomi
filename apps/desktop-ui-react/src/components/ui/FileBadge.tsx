/** 文件类型徽标：图标 + 语义色 + 扩展名徽标（如 `.xlsx`）。
 *
 *  对外的三个入口都是稳定 API，其它模块直接 import 这一个文件即可：
 *    · <FileBadge path='a/b.xlsx' size='sm' />  —— 直接渲染
 *    · fileKind(path) / fileKindLabel(kind)     —— 只要分类
 *    · fileExt(path) / fileName(path)           —— 只要扩展名 / 文件名
 *
 *  配色一律走 styles/theme.css 的 `--file-*` 令牌（明暗两套值，正文对比度 ≥4.5:1），
 *  这里只把令牌接成 Tailwind 类名。**类名必须写成字面量**：动态拼 'text-file-' + kind
 *  会被 Tailwind 的扫描漏掉，整类样式直接不生成，所以下面是静态表。 */
import {
  File, FileArchive, FileAudio, FileCode, FileImage, FileJson, FileSpreadsheet,
  FileText, FileType2, FileVideo, Presentation, ScrollText, type LucideIcon,
} from 'lucide-react'
import { cn } from '../../lib/cn'

/** 文件类别：图标与颜色只由它决定，扩展名只用来推出它。 */
export type FileKind =
  | 'sheet' | 'doc' | 'slides' | 'pdf' | 'image' | 'audio'
  | 'video' | 'archive' | 'code' | 'data' | 'text' | 'other'

/** 扩展名 → 类别（键一律小写、不带点）。没登记的一律落到 `other`。 */
const KIND_BY_EXT: Record<string, FileKind> = {
  // 表格（绿）
  xlsx: 'sheet', xls: 'sheet', xlsm: 'sheet', csv: 'sheet', tsv: 'sheet', ods: 'sheet',
  // 文档（蓝）
  docx: 'doc', doc: 'doc', rtf: 'doc', odt: 'doc',
  // 演示（橙）
  pptx: 'slides', ppt: 'slides', odp: 'slides',
  // PDF（红）
  pdf: 'pdf',
  // 图片（紫）
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  bmp: 'image', ico: 'image', avif: 'image', tif: 'image', tiff: 'image',
  // 音频（青绿）
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', ogg: 'audio', aac: 'audio', opus: 'audio',
  // 视频（靛）
  mp4: 'video', mov: 'video', mkv: 'video', avi: 'video', webm: 'video', m4v: 'video', wmv: 'video',
  // 压缩包（黄）
  zip: 'archive', '7z': 'archive', rar: 'archive', tar: 'archive', gz: 'archive',
  tgz: 'archive', bz2: 'archive', xz: 'archive', zst: 'archive',
  // 代码（青）
  rs: 'code', ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  vue: 'code', svelte: 'code', py: 'code', go: 'code', java: 'code', kt: 'code', kts: 'code',
  c: 'code', h: 'code', cc: 'code', cpp: 'code', hpp: 'code', cs: 'code', swift: 'code',
  rb: 'code', php: 'code', sh: 'code', bash: 'code', zsh: 'code', ps1: 'code', bat: 'code',
  cmd: 'code', sql: 'code', html: 'code', htm: 'code', css: 'code', scss: 'code', less: 'code',
  // 数据（蓝紫）
  json: 'data', jsonc: 'data', yaml: 'data', yml: 'data', toml: 'data', xml: 'data',
  ini: 'data', cfg: 'data', conf: 'data', env: 'data', properties: 'data', lock: 'data',
  // 文本（灰蓝）
  md: 'text', markdown: 'text', txt: 'text', log: 'text', rst: 'text',
}

/** 没有扩展名、但一眼能认出来的文件名（键是小写全名）。 */
const KIND_BY_NAME: Record<string, FileKind> = {
  '.gitignore': 'code', '.gitattributes': 'code', '.editorconfig': 'data', '.npmrc': 'data',
  dockerfile: 'code', makefile: 'code', 'cmakelists.txt': 'code', license: 'text',
}

/** 路径 / 文件名取最后一段（正反斜杠都认）。 */
export function fileName(path: string): string {
  const parts = String(path ?? '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** 扩展名：小写、带点（'.xlsx'）。没有扩展名、或只有开头的点（'.gitignore'）都是空串。 */
export function fileExt(path: string): string {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot).toLowerCase()
}

/** 分类：先认「没有扩展名但认得出」的文件名（Dockerfile / .gitignore），再按扩展名。 */
export function fileKind(path: string): FileKind {
  const named = KIND_BY_NAME[fileName(path).toLowerCase()]
  if (named) return named
  const ext = fileExt(path).slice(1)
  return ext ? (KIND_BY_EXT[ext] ?? 'other') : 'other'
}

/** 类别中文名（给悬停提示用）。 */
export const FILE_KIND_LABELS: Record<FileKind, string> = {
  sheet: '表格', doc: '文档', slides: '演示', pdf: 'PDF', image: '图片', audio: '音频',
  video: '视频', archive: '压缩包', code: '代码', data: '数据', text: '文本', other: '文件',
}

export function fileKindLabel(kind: FileKind): string {
  return FILE_KIND_LABELS[kind]
}

/** 图标 + 两类类名（图标色 / 徽标底色+字色）。类名是字面量，Tailwind 才扫得到。 */
const TONE: Record<FileKind, { Icon: LucideIcon; icon: string; badge: string }> = {
  sheet: { Icon: FileSpreadsheet, icon: 'text-file-sheet', badge: 'bg-file-sheet-soft text-file-sheet' },
  doc: { Icon: FileText, icon: 'text-file-doc', badge: 'bg-file-doc-soft text-file-doc' },
  slides: { Icon: Presentation, icon: 'text-file-slides', badge: 'bg-file-slides-soft text-file-slides' },
  pdf: { Icon: FileType2, icon: 'text-file-pdf', badge: 'bg-file-pdf-soft text-file-pdf' },
  image: { Icon: FileImage, icon: 'text-file-image', badge: 'bg-file-image-soft text-file-image' },
  audio: { Icon: FileAudio, icon: 'text-file-audio', badge: 'bg-file-audio-soft text-file-audio' },
  video: { Icon: FileVideo, icon: 'text-file-video', badge: 'bg-file-video-soft text-file-video' },
  archive: { Icon: FileArchive, icon: 'text-file-archive', badge: 'bg-file-archive-soft text-file-archive' },
  code: { Icon: FileCode, icon: 'text-file-code', badge: 'bg-file-code-soft text-file-code' },
  data: { Icon: FileJson, icon: 'text-file-data', badge: 'bg-file-data-soft text-file-data' },
  text: { Icon: ScrollText, icon: 'text-file-text', badge: 'bg-file-text-soft text-file-text' },
  other: { Icon: File, icon: 'text-file-other', badge: 'bg-file-other-soft text-file-other' },
}

/** 两档尺寸：sm 用于芯片 / 行内，md 用于卡片 / 列表。 */
const SIZES = {
  sm: { icon: 13, badge: 'h-4 rounded-[4px] px-1 text-10' },
  md: { icon: 16, badge: 'h-[18px] rounded-[5px] px-1.5 text-11' },
} as const

export type FileBadgeSize = keyof typeof SIZES

export interface FileBadgeProps {
  /** 文件路径或文件名：只用来取扩展名与分类 */
  path: string
  /** sm（默认）：13px 图标 + 10px 徽标；md：16px 图标 + 11px 徽标 */
  size?: FileBadgeSize
  /** 是否显示扩展名徽标（默认显示；只想要图标的行内场景可关掉） */
  showExt?: boolean
  className?: string
  /** 悬停提示；默认给完整路径 */
  title?: string
}

/** 文件类型徽标。`path` 只用于分类，组件本身不读文件、不发请求。 */
export function FileBadge({ path, size = 'sm', showExt = true, className, title }: FileBadgeProps) {
  const kind = fileKind(path)
  const { Icon, icon, badge } = TONE[kind]
  const dims = SIZES[size]
  // 徽标只写扩展名本身（.xlsx）；真正超长的少见扩展名截到 5 个字符，别让芯片被它撑宽。
  const ext = fileExt(path)
  const label = ext.length > 5 ? ext.slice(0, 5) : ext
  return (
    <span className={cn('inline-flex min-w-0 shrink-0 items-center gap-1', className)} title={title ?? path}>
      <Icon size={dims.icon} className={cn('shrink-0', icon)} aria-hidden />
      {showExt && label ? (
        <span
          className={cn(
            'inline-flex shrink-0 items-center font-mono leading-none',
            dims.badge,
            badge,
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  )
}
