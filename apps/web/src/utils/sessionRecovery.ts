/** Events arriving while a snapshot is in flight must be replayed above its
 * watermark. Never merge deltas across that watermark or discard overflow silently. */
export class RecoveryEvents<T extends { event_seq?: number }> {
  private events: T[] = []
  private bytes = 0
  overflow = false
  private maxEvents: number
  private maxBytes: number
  constructor(maxEvents = 3000, maxBytes = 4 * 1024 * 1024) {
    this.maxEvents = maxEvents
    this.maxBytes = maxBytes
  }

  push(event: T) {
    if (this.overflow) return
    this.bytes += JSON.stringify(event).length * 2
    if (this.events.length >= this.maxEvents || this.bytes > this.maxBytes) {
      this.events = []
      this.overflow = true
      return
    }
    this.events.push(event)
  }

  after(watermark: number): T[] {
    const seen = new Set<number>()
    return this.events.filter(event => {
      const seq = event.event_seq
      if (!seq || seq <= watermark || seen.has(seq)) return false
      seen.add(seq)
      return true
    }).sort((a, b) => a.event_seq! - b.event_seq!)
  }
}
