/**
 * SVG 预览：内联渲染（不走 img，方便直接看样式与交互），并提供导出 PNG。
 *
 * 内联 SVG 最大的风险是「AI 给的图形里夹了 <script> / on* 事件 / javascript: 链接」——
 * 那等于把脚本注进主界面。所以这里先过一遍 sanitizeSvg：删 script、删 foreignObject、
 * 剥掉所有 on* 属性、只保留 #fragment 与 data: 的引用。sanitize 失败就降级成源码显示。
 *
 * 导出 PNG：把（已清理的）SVG 序列化 → Image → canvas → toBlob，纯本地，不联网。
 * 画布被污染（引用了外部资源）时 toBlob 会抛错，此时给出可读提示而不是静默失败。
 */
import { useMemo, useState } from 'react'
import { Copy, ImageOff, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../ui/Button'
import { Tip } from '../../ui/Overlay'
import { copyText, downloadText } from '../actions'
import type { RichBlock } from '../store'

/** 清理 SVG：返回可安全内联的源码；无法解析时返回 null（调用方降级）。 */
export function sanitizeSvg(source: string): string | null {
  const text = source.trim()
  if (!text) return null
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (parsed.querySelector('parsererror') || !parsed.documentElement) return null
  const root = parsed.documentElement
  if (root.nodeName.toLowerCase() !== 'svg') return null

  root.querySelectorAll('script, foreignObject, iframe, use[href^="http"]').forEach((node) => node.remove())
  const walker = parsed.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  const strip: Element[] = []
  let current: Node | null = walker.currentNode
  while (current) {
    strip.push(current as Element)
    current = walker.nextNode()
  }
  for (const el of strip) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) { el.removeAttribute(attr.name); continue }
      if ((name === 'href' || name === 'xlink:href' || name === 'src') && !/^(#|data:)/i.test(attr.value.trim())) {
        el.removeAttribute(attr.name)
      }
    }
  }
  return root.outerHTML
}

/** SVG 尺寸：优先 width/height，其次 viewBox，都没有给 1024×768。 */
export function svgSize(source: string): { width: number; height: number } {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = parsed.documentElement
  const px = (value: string | null): number => {
    const num = Number.parseFloat(String(value ?? '').replace(/[^\d.]/g, ''))
    return Number.isFinite(num) && num > 0 ? num : 0
  }
  const width = px(root?.getAttribute('width') ?? null)
  const height = px(root?.getAttribute('height') ?? null)
  if (width && height) return { width, height }
  const box = (root?.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  if (box.length === 4 && box[2] && box[3] && Number.isFinite(box[2]) && Number.isFinite(box[3])) {
    return { width: Math.round(box[2]), height: Math.round(box[3]) }
  }
  return { width: 1024, height: 768 }
}

export async function svgToPngBlob(source: string, scale = 2): Promise<Blob> {
  const size = svgSize(source)
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = parsed.documentElement
  root.setAttribute('width', String(size.width))
  root.setAttribute('height', String(size.height))
  const serialized = new XMLSerializer().serializeToString(root)
  const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    image.decoding = 'sync'
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('SVG 无法被浏览器渲染（可能引用了外部资源）'))
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(size.width * scale))
    canvas.height = Math.max(1, Math.round(size.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前环境不支持 canvas 2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('画布导不出 PNG（可能被跨域资源污染）')
    return blob
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function SvgPreview({ block }: { block: RichBlock }) {
  const [busy, setBusy] = useState(false)
  const clean = useMemo(() => sanitizeSvg(block.code), [block.code])

  const exportPng = async (): Promise<void> => {
    if (!clean) return
    setBusy(true)
    try {
      const blob = await svgToPngBlob(clean)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'coomi-svg-' + Date.now() + '.png'
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      toast.success('已导出 PNG')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出 PNG 失败')
    } finally {
      setBusy(false)
    }
  }

  if (!clean) {
    return (
      <div className='px-3 py-3 text-12 text-ink-3'>
        <p className='flex items-center gap-1.5'><ImageOff size={13} />这段 SVG 解析不了，已按源码显示。</p>
        <pre className='mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-11 text-ink-2'>{block.code}</pre>
        <Button className='mt-2' size='sm' variant='secondary' onClick={() => void copyText(block.code)}>复制源码</Button>
      </div>
    )
  }

  return (
    <div className='min-w-0'>
      <div className='flex items-center gap-1.5 border-b border-line px-2 py-1'>
        <Tip label='已移除 script / on* 事件 / 外部引用后再内联渲染'>
          <span className='flex items-center gap-1 text-11 text-ink-4'><ShieldCheck size={12} />已清理后内联</span>
        </Tip>
        <div className='flex-1' />
        <Button variant='ghost' size='icon-sm' className='h-6 w-6' title='复制 SVG 源码' onClick={() => void copyText(block.code)}>
          <Copy size={12} />
        </Button>
        <Button variant='ghost' size='sm' className='h-6 text-11' loading={busy} onClick={() => void exportPng()}>
          导出 PNG
        </Button>
      </div>
      <div
        className='flex max-h-[420px] min-w-0 items-center justify-center overflow-auto bg-white p-3 [&_svg]:max-h-[380px] [&_svg]:max-w-full'
        // 上面的 sanitizeSvg 已经把 script / on* / 外部引用清掉了，这里才敢用 innerHTML。
        dangerouslySetInnerHTML={{ __html: clean }}
      />
      <div className='flex items-center gap-2 border-t border-line px-2 py-1 text-11 text-ink-4'>
        <span className='flex-1'>导出 PNG 时按 SVG 自身的尺寸 ×2 渲染，纯本地绘制。</span>
        <Button variant='ghost' size='sm' className='h-6 text-11' onClick={() => downloadText('coomi-svg-' + Date.now() + '.svg', block.code, 'image/svg+xml')}>
          下载 SVG
        </Button>
      </div>
    </div>
  )
}
