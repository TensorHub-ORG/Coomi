import { marked } from 'marked'

/**
 * Markdown → HTML，出门前过一遍白名单。
 *
 * marked 会把源文里的裸 HTML 原样吐出来，而这段文字来自模型和工具结果 ——
 * 不可信。直接 v-html 就等于把 `<img onerror=…>` 放进 WebView，而这个
 * WebView 和引擎同源（127.0.0.1，手里有 shell）。所以解析完再过一遍：
 * 名单外的标签拆掉只留文字，属性一律丢，链接只放行 http(s)/mailto。
 */
marked.setOptions({ breaks: true, gfm: true })

/** marked 正常会产出的标签，多一个都不放。 */
const ALLOWED = new Set([
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'input',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
])

/** 这些连文字都不要：里面装的是代码，不是内容。 */
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math', 'link', 'meta'])

const ATTRS: Record<string, string[]> = {
  a: ['href'],
  code: ['class'],
  ol: ['start'],
  th: ['align'],
  td: ['align'],
  input: ['type', 'checked', 'disabled'],
}

const SAFE_HREF = /^(?:https?:|mailto:)/i
const SAFE_LANG = /^language-[\w+#.-]{1,24}$/
const SAFE_ALIGN = /^(?:left|right|center)$/
/** 空白和控制字符：URL 解析器会把它们抠掉，"java\tscript:" 是真能跑的。 */
const URL_NOISE = new RegExp('[\\s\\x00-\\x1f]+', 'g')

/** 返回要留下的属性值（可能被改写过）；不要就返回 null。 */
function cleanAttr(tag: string, name: string, value: string): string | null {
  if (!(ATTRS[tag] ?? []).includes(name)) return null
  if (name === 'href') {
    const url = value.replace(URL_NOISE, '')
    return SAFE_HREF.test(url) ? url : null
  }
  if (name === 'class') return SAFE_LANG.test(value) ? value : null
  if (name === 'align') return SAFE_ALIGN.test(value) ? value : null
  if (name === 'start') return /^\d{1,6}$/.test(value) ? value : null
  if (name === 'type') return value.toLowerCase() === 'checkbox' ? 'checkbox' : null
  return value
}

function clean(node: Element): void {
  for (const el of Array.from(node.children)) {
    const tag = el.tagName.toLowerCase()
    if (DROP.has(tag)) { el.remove(); continue }
    if (!ALLOWED.has(tag)) {
      // 名单外的标签拆掉，孩子（文字）留下 —— 不能因为一个 <div> 吞掉半段回答。
      clean(el)
      el.replaceWith(...Array.from(el.childNodes))
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      const kept = cleanAttr(tag, name, attr.value)
      if (kept === null) el.removeAttribute(attr.name)
      else if (kept !== attr.value) el.setAttribute(name, kept)
    }
    // 链接一律新窗口打开：别把整个 WebView 导航跑了。
    if (tag === 'a' && el.hasAttribute('href')) {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer nofollow')
    }
    clean(el)
  }
}

/** DOMParser 建出来的文档是惰性的：不跑脚本，也不会去拉 src。 */
const parser = new DOMParser()

function sanitize(html: string): string {
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  clean(doc.body)
  return doc.body.innerHTML
}

/**
 * 流式期间同一段文字会被反复渲染（MessageBubble 每 60ms 重建一次全部块），
 * 已经定稿的块没必要一遍遍解析，缓存住。
 */
const CACHE_MAX = 240
const cache = new Map<string, string>()

export function renderMarkdown(src: string): string {
  const hit = cache.get(src)
  if (hit !== undefined) return hit
  const html = sanitize(marked.parse(src, { async: false }) as string)
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(src, html)
  return html
}
