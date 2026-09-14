import type { Timelineitem, ToolCard } from '@/stores/viewModel'

export const MAX_TRANSCRIPT_ITEMS = 400

export type TimelineBlockItem =
  | { t: 'one'; key: string; item: Timelineitem }
  | { t: 'tools'; key: string; cards: ToolCard[] }

function itemId(item: Timelineitem): string {
  return 'id' in item ? item.id : item.callId
}

/**
 * block 引用稳定化缓存。
 *
 * DynamicScrollerItem 的 size-dependencies 里放的是 block / item / cards 引用,
 * 而 buildTimelineBlocks 会被高频调用（流式期间每个事件都可能重算时间线）。
 * 若每次都返回全新对象，虚拟列表会把「所有 item」都当成内容变了，
 * 全列表重新测量尺寸 → 流式回复时整个界面抖动/闪烁。
 *
 * timeline 里的 item 对象是稳定引用（store 原地 mutate，不替换对象），
 * 因此按引用缓存 block 即可：对象被真正替换 / 组内增删时自然拿到新 block，
 * 其余 item 保持旧引用，虚拟列表只重测真正变高的那一条。
 */
const oneBlockCache = new WeakMap<Timelineitem, TimelineBlockItem>()

interface ToolsBlockCacheEntry {
  block: TimelineBlockItem
  cards: ToolCard[]
}
const toolsBlockCache = new Map<string, ToolsBlockCacheEntry>()
/** 防御性上限：时间线本身受 MAX_TRANSCRIPT_ITEMS 约束，这里防异常输入撑爆内存。 */
const TOOLS_CACHE_MAX = 512

function cachedOneBlock(item: Timelineitem): TimelineBlockItem {
  let block = oneBlockCache.get(item)
  if (!block) {
    block = { t: 'one', key: `${item.kind}:${itemId(item)}`, item }
    oneBlockCache.set(item, block)
  }
  return block
}

function sameCards(a: ToolCard[], b: ToolCard[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function cachedToolsBlock(key: string, cards: ToolCard[]): TimelineBlockItem {
  const cached = toolsBlockCache.get(key)
  if (cached && sameCards(cached.cards, cards)) return cached.block
  const block: TimelineBlockItem = { t: 'tools', key, cards }
  if (toolsBlockCache.size >= TOOLS_CACHE_MAX) toolsBlockCache.clear()
  toolsBlockCache.set(key, { block, cards })
  return block
}

export function buildTimelineBlocks(items: readonly Timelineitem[]): TimelineBlockItem[] {
  const blocks: TimelineBlockItem[] = []
  let groupKey = ''
  let groupCards: ToolCard[] = []
  const flushGroup = () => {
    if (groupCards.length) blocks.push(cachedToolsBlock(groupKey, groupCards))
    groupKey = ''
    groupCards = []
  }
  for (const item of items) {
    if (item.kind === 'tool') {
      if (!groupCards.length) groupKey = `g:${item.callId}`
      groupCards.push(item)
      continue
    }
    flushGroup()
    blocks.push(cachedOneBlock(item))
  }
  flushGroup()
  return blocks
}

export function transcriptTail(
  items: readonly Timelineitem[],
  limit = MAX_TRANSCRIPT_ITEMS,
): Timelineitem[] {
  if (!Number.isInteger(limit) || limit <= 0) return []
  return items.slice(-limit)
}

export function parseTranscript(raw: string | null): Timelineitem[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as Timelineitem[] : []
  } catch {
    return []
  }
}
