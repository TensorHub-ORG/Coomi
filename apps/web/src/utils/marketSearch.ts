export interface MarketSearchItem {
  id: string
  name: string
  description?: string
  repository?: string
  author?: string
  tags?: string[]
}

export function filterMarketItems<T extends MarketSearchItem>(items: T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return items

  return items.filter(item => [
    item.id,
    item.name,
    item.description,
    item.repository,
    item.author,
    ...(item.tags ?? []),
  ].some(value => value?.toLowerCase().includes(needle)))
}
