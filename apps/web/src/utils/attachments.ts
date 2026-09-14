export type AttachmentKind = 'image' | 'file'

export interface ChatAttachment {
  path: string
  name: string
  kind: AttachmentKind
}

const ATTACHMENTS_OPEN = '<coomi_attachments>'
const ATTACHMENTS_CLOSE = '</coomi_attachments>'

const IMAGE_EXTENSIONS = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i

export function attachmentFromPath(path: string): ChatAttachment {
  const normalized = path.trim()
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  const name = parts[parts.length - 1] || '附件'
  return { path: normalized, name, kind: IMAGE_EXTENSIONS.test(name) ? 'image' : 'file' }
}

export function normalizeAttachments(paths: string[]): ChatAttachment[] {
  const seen = new Set<string>()
  return paths
    .map(path => attachmentFromPath(String(path)))
    .filter(attachment => attachment.path && !seen.has(attachment.path) && seen.add(attachment.path))
}

/** The transport sees real sandbox paths; the composer and user bubble never show this block. */
export function buildAttachmentRequest(text: string, attachments: ChatAttachment[]): string {
  const prompt = text.trim()
  if (!attachments.length) return prompt
  const payload = JSON.stringify({ paths: attachments.map(item => item.path) })
  return [prompt, `${ATTACHMENTS_OPEN}${payload}${ATTACHMENTS_CLOSE}\n请读取并结合以上附件完成本次任务。`]
    .filter(Boolean)
    .join('\n\n')
}

export function parseAttachmentRequest(content: string): { text: string; attachments: ChatAttachment[] } {
  const start = content.lastIndexOf(ATTACHMENTS_OPEN)
  if (start < 0) return { text: content, attachments: [] }
  const payloadStart = start + ATTACHMENTS_OPEN.length
  const end = content.indexOf(ATTACHMENTS_CLOSE, payloadStart)
  if (end < 0) return { text: content, attachments: [] }
  try {
    const parsed = JSON.parse(content.slice(payloadStart, end)) as { paths?: unknown }
    if (!Array.isArray(parsed.paths) || !parsed.paths.every(path => typeof path === 'string')) {
      return { text: content, attachments: [] }
    }
    return {
      text: content.slice(0, start).trimEnd(),
      attachments: normalizeAttachments(parsed.paths),
    }
  } catch {
    return { text: content, attachments: [] }
  }
}
