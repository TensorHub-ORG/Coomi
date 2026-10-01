/**
 * JSON 预览：可折叠树 + 逐节点「复制路径」。
 * - 解析失败 → 明确说「不是合法 JSON」并降级成源码（不假装能预览）；
 * - 巨大对象 → 只展开第一层、单节点最多列 200 个子项，避免把几万行塞进 DOM 卡住主界面。
 * 复制的是 JSONPath（$.a[0].b），粘贴到别处能直接定位。
 */
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../../lib/cn'
import { PreviewNote } from './common'
import { copyText } from '../actions'
import type { RichBlock } from '../store'

const MAX_CHILDREN = 200
const MAX_NODES = 20_000
const BIG_SOURCE = 300_000

function childPath(parent: string, key: string, isIndex: boolean): string {
  if (isIndex) return parent + '[' + key + ']'
  return /^[A-Za-z_$][\w$]*$/.test(key) ? parent + '.' + key : parent + '["' + key.replace(/"/g, '\\"') + '"]'
}

function countNodes(value: unknown, budget = MAX_NODES): number {
  // 预算用完就停：只想知道「是不是大得离谱」，不需要真的数完。
  let count = 0
  const stack: unknown[] = [value]
  while (stack.length && count < budget) {
    const node = stack.pop()
    count++
    if (Array.isArray(node)) { for (const item of node) stack.push(item) }
    else if (node && typeof node === 'object') { for (const item of Object.values(node)) stack.push(item) }
  }
  return count
}

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className='text-ink-4'>null</span>
  if (typeof value === 'string') return <span className='break-all text-ok'>"{value}"</span>
  if (typeof value === 'number') return <span className='text-primary'>{String(value)}</span>
  if (typeof value === 'boolean') return <span className='text-warn'>{String(value)}</span>
  return <span className='text-ink-3'>{String(value)}</span>
}

function JsonNode({ label, value, path, depth, open, toggle }: {
  label: string
  value: unknown
  path: string
  depth: number
  open: Set<string>
  toggle: (path: string) => void
}) {
  const isObject = value !== null && typeof value === 'object'
  if (!isObject) {
    return (
      <li className='group/json flex min-w-0 items-start gap-1 py-[1px] pl-3'>
        <span className='shrink-0 font-mono text-11 text-ink-3'>{label}:</span>
        <span className='min-w-0 flex-1 font-mono text-11'><Primitive value={value} /></span>
        <button
          type='button'
          className='shrink-0 opacity-0 transition-opacity group-hover/json:opacity-100'
          title={'复制路径 ' + path}
          onClick={() => void copyText(path).then((ok) => (ok ? toast.success('已复制路径 ' + path) : toast.error('复制失败')))}
        >
          <Copy size={11} className='text-ink-4 hover:text-ink-2' />
        </button>
      </li>
    )
  }

  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as [string, unknown])
    : Object.entries(value as Record<string, unknown>)
  const expanded = open.has(path)
  const size = Array.isArray(value) ? '数组·' + entries.length + ' 项' : '对象·' + entries.length + ' 个键'

  return (
    <li className='min-w-0'>
      <div className='group/json flex min-w-0 items-center gap-1 py-[1px]'>
        <button
          type='button'
          onClick={() => toggle(path)}
          className='flex min-w-0 flex-1 items-center gap-1 text-left'
          title={expanded ? '折叠' : '展开'}
        >
          {expanded ? <ChevronDown size={11} className='shrink-0 text-ink-4' /> : <ChevronRight size={11} className='shrink-0 text-ink-4' />}
          <span className='shrink-0 font-mono text-11 text-ink-2'>{label}</span>
          <span className='shrink-0 text-11 text-ink-4'>: {size}</span>
        </button>
        <button
          type='button'
          className='shrink-0 opacity-0 transition-opacity group-hover/json:opacity-100'
          title={'复制路径 ' + path}
          onClick={() => void copyText(path).then((ok) => (ok ? toast.success('已复制路径 ' + path) : toast.error('复制失败')))}
        >
          <Copy size={11} className='text-ink-4 hover:text-ink-2' />
        </button>
      </div>
      {expanded ? (
        <ul className='min-w-0 border-l border-line-soft pl-2'>
          {entries.slice(0, MAX_CHILDREN).map(([key, item]) => (
            <JsonNode
              key={key}
              label={key}
              value={item}
              path={childPath(path, key, Array.isArray(value))}
              depth={depth + 1}
              open={open}
              toggle={toggle}
            />
          ))}
          {entries.length > MAX_CHILDREN
            ? <li className='pl-3 text-11 text-ink-4'>…还有 {entries.length - MAX_CHILDREN} 项未展开（单节点最多列 {MAX_CHILDREN} 项）</li>
            : null}
        </ul>
      ) : null}
    </li>
  )
}

export function JsonPreview({ block }: { block: RichBlock }) {
  const parsed = useMemo(() => {
    try { return { value: JSON.parse(block.code) as unknown, error: '' } }
    catch (e) { return { value: undefined as unknown, error: e instanceof Error ? e.message : String(e) } }
  }, [block.code])

  const [open, setOpen] = useState<Set<string>>(() => new Set(['$']))
  const toggle = (path: string): void => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const stats = useMemo(() => (parsed.error ? null : { nodes: countNodes(parsed.value) }), [parsed])

  if (parsed.error) {
    return (
      <div className='px-3 py-3'>
        <PreviewNote tone='warn'>这段内容按 JSON 识别，但解析失败：{parsed.error}</PreviewNote>
        <pre className='mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-11 text-ink-2'>{block.code}</pre>
      </div>
    )
  }

  if (block.code.length > BIG_SOURCE) {
    return (
      <div className='px-3 py-3'>
        <PreviewNote tone='info'>内容约 {Math.round(block.code.length / 1024)}KB，树视图容易拖慢主界面，已只显示源码。</PreviewNote>
        <pre className='mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-11 text-ink-2'>{block.code.slice(0, 20_000)}</pre>
      </div>
    )
  }

  return (
    <div className='min-w-0'>
      <div className='flex items-center gap-2 border-b border-line px-2 py-1 text-11 text-ink-4'>
        <span>可折叠树 · 点键名展开/折叠，点行尾图标复制 JSONPath</span>
        <div className='flex-1' />
        <span className='tabular-nums'>节点 {stats?.nodes ?? 0}{(stats?.nodes ?? 0) >= MAX_NODES ? '+' : ''}</span>
        <button type='button' className='text-primary hover:underline' onClick={() => { setOpen(new Set(['$'])); }}>全部折叠</button>
      </div>
      <ul className='max-h-[520px] min-w-0 overflow-auto py-1.5 font-mono text-11'>
        <JsonNode label='$' value={parsed.value} path='$' depth={0} open={open} toggle={toggle} />
      </ul>
      <div className={cn('border-t border-line px-2 py-1 text-11 text-ink-4')}>
        解析自 markdown 代码块，未做任何改写。
      </div>
    </div>
  )
}
