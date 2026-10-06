import type { Timelineitem, ToolCard } from '@/stores/viewModel'

export const MAX_TRANSCRIPT_ITEMS = 400

export type TimelineBlockItem =
  | { t: 'one'; key: string; item: Timelineitem }
  | { t: 'tools'; key: string; cards: ToolCard[] }

function itemId(item: Timelineitem): string {
  return 'id' in item ? item.id : item.callId
}

/**
 * 时间线分块，并保证「结构没变就复用同一个对象」。
 *
 * 为什么必须复用：ChatView 把这些块喂给 DynamicScroller，而
 * DynamicScrollerItem 会对 size-dependencies 的每一项挂一个浅 watcher
 * （vue-virtual-scroller `this.$watch(() => sizeDependencies[k], onDataUpdate)`）。
 * 只要元素引用变了就会重新量尺寸并触发整条虚拟列表重排 —— 从前每来一个 token
 * 都重建全部块对象，于是「一输出文字/一调工具」整个列表闪一下。
 * 现在只有真正新增或替换的块才会换对象，稳定块原样复用。
 */
type OneBlock = { t: 'one'; key: string; item: Timelineitem }
type ToolsBlock = { t: 'tools'; key: string; cards: ToolCard[] }

const oneCache = new Map<string, OneBlock>()
const toolsCache = new Map<string, { block: ToolsBlock; members: readonly ToolCard[] }>()
let lastBlocks: TimelineBlockItem[] = []

export function buildTimelineBlocks(items: readonly Timelineitem[]): TimelineBlockItem[] {
  const blocks: TimelineBlockItem[] = []
  const seenOne = new Set<string>()
  const seenTools = new Set<string>()

  let index = 0
  while (index < items.length) {
    const item = items[index]
    if (item.kind === 'tool') {
      // 连续的工具调用合并成一组；组内的卡片对象本身是稳定的（store 原地改属性）。
      const members: ToolCard[] = []
      while (index < items.length && items[index].kind === 'tool') {
        members.push(items[index] as ToolCard)
        index += 1
      }
      const key = `g:${members[0].callId}`
      const cached = toolsCache.get(key)
      const reused =
        cached &&
        cached.members.length === members.length &&
        members.every((card, i) => card === cached.members[i])
      const block = reused ? cached.block : { t: 'tools' as const, key, cards: members.slice() }
      if (!reused) toolsCache.set(key, { block, members: members.slice() })
      seenTools.add(key)
      blocks.push(block)
      continue
    }
    const key = `${item.kind}:${itemId(item)}`
    const cached = oneCache.get(key)
    const block = cached && cached.item === item ? cached : { t: 'one' as const, key, item }
    if (!cached || cached.item !== item) oneCache.set(key, block)
    seenOne.add(key)
    blocks.push(block)
    index += 1
  }

  // 清理本次没出现的键，避免长时间会话把缓存越堆越大。
  for (const key of oneCache.keys()) if (!seenOne.has(key)) oneCache.delete(key)
  for (const key of toolsCache.keys()) if (!seenTools.has(key)) toolsCache.delete(key)

  // 结构完全没变时返回同一个数组：DynamicScroller 的 items watcher 也就不会跑。
  if (blocks.length === lastBlocks.length && blocks.every((block, i) => block === lastBlocks[i])) {
    return lastBlocks
  }
  lastBlocks = blocks
  return blocks
}

export function transcriptTail(
  items: readonly Timelineitem[],
  limit = MAX_TRANSCRIPT_ITEMS,
): Timelineitem[] {
  if (!Number.isInteger(limit) || limit <= 0) return []
  return items.slice(-limit).map(item => {
    if (item.kind !== 'user') return item
    return item.attachments?.length
      ? { kind: item.kind, id: item.id, mid: item.mid, content: item.content, attachments: item.attachments }
      : { kind: item.kind, id: item.id, mid: item.mid, content: item.content }
  })
}


export function parseTranscript(raw: string | null): Timelineitem[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as Timelineitem[]).map(item => item.kind === 'user'
      ? { ...item, morphing: false, morphArrived: false }
      : item)
  } catch {
    return []
  }
}
