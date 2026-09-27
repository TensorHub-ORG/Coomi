type CloseOverlay = () => void

const stack: Array<{ id: string; close: CloseOverlay }> = []

export function registerOverlay(id: string, close: CloseOverlay): void {
  unregisterOverlay(id)
  stack.push({ id, close })
}

export function unregisterOverlay(id: string): void {
  const index = stack.findIndex(item => item.id === id)
  if (index >= 0) stack.splice(index, 1)
}

export function closeTopOverlay(): boolean {
  const item = stack.pop()
  if (!item) return false
  item.close()
  return true
}
