/**
 * Markdown 正文里的文件路径 → 路径芯片（FileChip）的桥梁。
 *
 * 为什么走 remark 插件而不是在 `p` / `li` / `td` 里递归 children：
 *   · 递归改 children 会破坏 React 的元素身份，列表里每个文本节点都要重建一遍；
 *   · 表格单元格（GFM 的 tableCell）里的文本节点用组件映射根本拦不到 ——
 *     `td` 拿到的 children 已经是渲染结果，而 react-markdown 不允许覆盖 text 节点。
 *   remark 这一层拿到的还是**纯 mdast**：只有 text 节点，代码块（code）与行内代码（inlineCode）
 *   的 value 活在别的节点类型上，天然不会被碰到 —— 这正是「代码块内不识别」的实现方式。
 *
 * 产物是一个链接节点，href 带 `coomi-file:` 前缀（见 FILE_LINK_PREFIX），
 * 由 Markdown.tsx 里覆盖的 `a` 组件识别后换成芯片；路径一律 encodeURIComponent，
 * 免得正文里的 `#` / `?` / 中文把 href 撕开。
 *
 * 本文件是纯函数 + 一个 remark 变换，不碰 DOM / 不碰网络。
 */
import { scanPaths } from './filePath'

/** 芯片链接的协议前缀：只有本文件与 chat/FileChip.tsx 认它。 */
export const FILE_LINK_PREFIX = 'coomi-file:'

/** 路径 → 链接 href。 */
export function fileLinkHref(raw: string): string {
  return FILE_LINK_PREFIX + encodeURIComponent(String(raw ?? ''))
}

/** 链接 href → 路径；不是芯片链接时返回空串。 */
export function filePathFromHref(href: unknown): string {
  const text = typeof href === 'string' ? href : ''
  if (!text.startsWith(FILE_LINK_PREFIX)) return ''
  try {
    const decoded = decodeURIComponent(text.slice(FILE_LINK_PREFIX.length))
    return decoded.trim()
  } catch {
    // 坏掉的百分号转义（例如正文里本来就写了 %zz）：当作不是芯片链接，别让整段渲染挂掉。
    return ''
  }
}

interface MdNode {
  type?: string
  value?: unknown
  url?: unknown
  title?: unknown
  children?: unknown
}

/** 这些节点的 children 不再往下走：链接里不能再嵌链接，图片/HTML/代码没有可切的文本。 */
const SKIP_CHILDREN = new Set(['link', 'linkReference', 'image', 'imageReference', 'html', 'code'])

/** 把一段文本按路径切成 [文本, 芯片链接, 文本, …]。没有命中时原样放回同一个文本节点。 */
function pushSegments(out: MdNode[], text: string): void {
  const spans = scanPaths(text)
  if (!spans.length) {
    out.push({ type: 'text', value: text })
    return
  }
  let at = 0
  for (const span of spans) {
    if (span.start > at) out.push({ type: 'text', value: text.slice(at, span.start) })
    out.push({
      type: 'link',
      url: fileLinkHref(span.raw),
      title: null,
      children: [{ type: 'text', value: span.raw }],
    })
    at = span.end
  }
  if (at < text.length) out.push({ type: 'text', value: text.slice(at) })
}

/** 深度优先重写一棵子树的 children：只有 text 节点会被切分。 */
function rewrite(node: MdNode): void {
  const children = node.children
  if (!Array.isArray(children)) return
  const next: MdNode[] = []
  for (const raw of children) {
    // 非对象（null / 字符串）本来也不该出现在 children 里：直接丢掉，别把它塞回新数组。
    const child = raw as MdNode | null
    if (!child || typeof child !== 'object') continue
    if (child.type === 'text' && typeof child.value === 'string') {
      pushSegments(next, child.value)
      continue
    }
    if (typeof child.type === 'string' && !SKIP_CHILDREN.has(child.type)) rewrite(child)
    next.push(child)
  }
  node.children = next
}

/**
 * remark 插件：把正文 / 列表 / 表格单元格里的路径切成链接节点。
 * 代码块（fenced code）与行内代码是 code / inlineCode 节点，本插件不碰它们的 value。
 */
export function remarkFilePaths() {
  return (tree: unknown): void => {
    if (tree && typeof tree === 'object') rewrite(tree as MdNode)
  }
}
