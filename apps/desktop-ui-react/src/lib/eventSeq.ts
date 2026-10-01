/**
 * event_seq 顺序门：缺口识别 / 乱序缓冲 / 去重。
 *
 * **字段位置（已核对引擎实现）**：引擎在 `apps/coomi-rs/ui/src/web/mod.rs` 的 `push_event` 里
 * 把 `payload["event_seq"] = json!(seq)` 写进**事件 payload**，再用
 * `coomi_envelope("event", None, payload)` 包成 `{ v, type:'event', ts, payload }` 发给客户端。
 * 前端 stores/session.ts 的 `ws.onmessage` 解包后拿到的是 `frame.payload`，
 * 所以 `event_seq` 就挂在事件对象**顶层**、与 `event_type` 同级。
 * （注意：走 `ConnectionContext::send_event` 的少数帧不经过 `push_event`，没有 `event_seq`，
 * 这些帧按老逻辑直接处理。）
 *
 * 引擎还维护未确认事件队列（上限 2048），并提供两条命令：
 *   · `{ command: 'resync', after_seq }` —— 按原顺序重发 `event_seq > after_seq` 的未确认事件；
 *   · `{ command: 'ack', seq }`          —— 裁掉 `event_seq <= seq` 的未确认事件。
 * 但 `begin_turn` 会清空未确认队列，所以**补帧只在同一轮内有效**；跨轮仍靠轮末回读会话历史。
 *
 * 本文件是纯逻辑（不碰 socket / store），浏览器与 node 回归脚本共用：
 * 把「乱序帧先暂存、缺口补齐后按序倾倒」做成一台小机器，保证：
 *   ① 交给业务处理的一定是**严格连续递增**的序列；
 *   ② 重发 / 重放的旧帧直接判重，不会画出重复气泡；
 *   ③ 缺口不会把缺的那几帧吃掉（先暂存本帧，等 resync 补回缺口再一起放行）。
 */

/** 事件对象（引擎 payload 解包后的形态）。 */
export type SeqEvent = Record<string, any>

/** 读事件里的 `event_seq`：只认正的安全整数（数字或纯数字字符串）。
 *  取不到（老引擎 / 走 send_event 的兼容帧）返回 null —— 调用方按老逻辑处理，绝不报错。 */
export function readEventSeq(ev: SeqEvent | null | undefined): number | null {
  if (!ev) return null
  const raw = ev.event_seq
  const n = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** 顺序门对一帧的处置。 */
export interface SeqGateOutcome<T> {
  /** 此刻能**按序**处理的事件：正常接续时就是本帧；补帧把缺口补齐时会把缓冲里的几帧一起带出。 */
  ready: T[]
  /** 与已处理序列之间有缺口（ready 为空）：本帧已暂存，调用方应请求 resync。 */
  gap: boolean
  /** 早于 / 重复于已处理序列的帧：直接丢弃，不产生任何内容。 */
  duplicate: boolean
}

/** 顺序门：每帧按 event_seq 送入，拿回「现在该处理哪些帧」。 */
export interface SeqGate<T> {
  /** 已按序处理的最后一个 event_seq（还没有基线时为 0）。 */
  last(): number
  /** 暂存中（等缺口补齐）的帧数，用于诊断与溢出保护。 */
  buffered(): number
  /** 复位（换会话 / 引擎重启）。重连**不要**复位 —— 要留 last 给 resync 补帧。 */
  reset(): void
  /** 送入一帧。 */
  push(seq: number, event: T): SeqGateOutcome<T>
}

/** 暂存上限：缺口大到这个程度说明补帧也追不回来了（引擎队列只有 2048 且会被裁剪），
 *  再等下去界面就停在缺口上；直接按 seq 升序把缓冲帧放行，跳过的那段由轮末回读补齐。 */
const DEFAULT_MAX_PENDING = 512

/** 新建一台顺序门。 */
export function createSeqGate<T>(options: { maxPending?: number } = {}): SeqGate<T> {
  const maxPending = options.maxPending && options.maxPending > 0 ? options.maxPending : DEFAULT_MAX_PENDING
  let last = 0
  const pending = new Map<number, T>()

  /** 从 last 往后尽可能多地倾倒连续帧。 */
  const drain = (): T[] => {
    const ready: T[] = []
    for (;;) {
      const next = pending.get(last + 1)
      if (next === undefined) break
      pending.delete(last + 1)
      last += 1
      ready.push(next)
    }
    return ready
  }

  return {
    last: () => last,
    buffered: () => pending.size,
    reset: () => { last = 0; pending.clear() },
    push: (seq, event) => {
      if (seq <= last || pending.has(seq)) return { ready: [], gap: false, duplicate: true }
      // 还没有基线（首连 / 刚复位）：引擎的 seq 可能已经从别处涨上去了（会话任务被复用、
      // 同一任务里更早的事件没发到这台客户端），无法推断缺口 —— 直接以本帧为起点。
      if (last === 0) {
        last = seq
        return { ready: [event], gap: false, duplicate: false }
      }
      pending.set(seq, event)
      if (seq === last + 1) return { ready: drain(), gap: false, duplicate: false }
      // 缺口：本帧先留着，等 resync 把缺的几帧补回来再按序一起放行。
      // **不能**一边收下本帧一边把 last 推到 seq：那样补回来的缺口帧会因「seq <= last」
      // 被当成重复帧永久丢掉（这正是这套机制要防的丢内容形态）。
      if (pending.size > maxPending) {
        const keys = [...pending.keys()].sort((a, b) => a - b)
        const ready = keys.map((key) => pending.get(key) as T)
        pending.clear()
        last = keys[keys.length - 1]
        return { ready, gap: false, duplicate: false }
      }
      return { ready: [], gap: true, duplicate: false }
    },
  }
}
