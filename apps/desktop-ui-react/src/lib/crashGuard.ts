/**
 * 崩溃自救（白屏止血：错误边界背后的那点纯逻辑）。**零 import**，所以能直接在 node 里断言。
 *
 * 症状：切换会话后**整屏白**，重启无效。渲染期一抛异常，React 会把**整棵树**卸载掉 ——
 * 页面上什么都不剩，而这个异常不会再被第二个人接住：重启只是把同一份数据再放一遍，
 * 于是「重启无效」。止血的两件事：
 *   ① 错误边界（components/ErrorBoundary.tsx）接住异常，画一句人话 + 两个出口，绝不白屏；
 *   ② **启动自愈**：短时间内崩过 >= 2 次 → 下一次启动直接进安全模式（只画纯文本那一档），
 *      用户哪怕还带着那份坏数据，也还有一个能用的界面可以进去收拾。
 *
 * 这一份只管「显示什么」与「该不该自愈」，不碰 DOM、不 import 任何东西：
 * 安全模式的开关本体在 lib/guard.ts（?safe=1 与 localStorage 都认），main.tsx 把它们接起来。
 * 断言见 tests/check-event-port.mjs。
 */

/** 崩溃账的本地键：**localStorage**（不是 sessionStorage）—— 「重启无效」说的就是关掉再开，
    只活在当前进程里的账本跟不过去。UI 跑满 15 秒没崩过时由 main.tsx 清掉。 */
export const CRASH_STORAGE_KEY = 'coomi.crash.v1'
/** 多久之内的崩溃算「同一轮故障」（超过就当上一次的账已经过期）。 */
export const CRASH_WINDOW_MS = 5 * 60 * 1000
/** 同一个 scope + 同一条错误在这么多毫秒内只记一次（StrictMode 与多个边界会重复上报）。 */
export const CRASH_DEDUPE_MS = 5 * 1000
/** 崩到这个次数（窗口内）→ 下一次启动自动进安全模式。 */
export const CRASH_SELF_HEAL_AT = 2

/** 展示给用户的错误摘要：一句标题 + 头几行栈（一屏读完，不含整页源码）。 */
export interface CrashSummary {
  /** 「TypeError：xxx is not a function」这种一行标题。 */
  title: string
  /** 堆栈的头几行（已裁剪），没有堆栈时给一句说明。 */
  detail: string
}

/** 崩溃账：窗口内的次数、最后一次的时刻、最后一次的 scope 与标题。 */
export interface CrashRecord {
  count: number
  lastAt: number
  scope: string
  message: string
}

/** 只用得到这三个方法，所以 node 里塞一个 Map 也能当存储（断言不必碰 DOM）。 */
export interface CrashStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const memory = new Map<string, string>()
const memoryStorage: CrashStorage = {
  getItem: (key) => (memory.has(key) ? (memory.get(key) as string) : null),
  setItem: (key, value) => { memory.set(key, value) },
  removeItem: (key) => { memory.delete(key) },
}

/** 默认存储：真实环境用 localStorage；隐私模式 / node 里退回内存（功能照旧，只是不跨重启）。 */
export function defaultCrashStorage(): CrashStorage {
  try {
    const local = typeof localStorage === 'undefined' ? null : localStorage
    if (local && typeof local.getItem === 'function') return local
  } catch { /* 隐私模式下取 localStorage 本身就可能抛 */ }
  return memoryStorage
}

/** 裁剪一行文本（摘要只留一小段：整个堆栈贴到界面上既读不下去，也可能带出过多路径信息）。 */
function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 任意抛出物 → Error（字符串、对象、undefined 都能收拾成一句人话）。 */
function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === 'string') return new Error(error)
  try {
    if (error && typeof error === 'object') return new Error(JSON.stringify(error))
    return new Error(String(error))
  } catch { return new Error('未知错误（无法读取的抛出物）') }
}

/** 把抛出物摘成可读摘要：**界面上一句话说明白发生了什么**（绝不显示 "undefined"）。 */
export function describeError(error: unknown): CrashSummary {
  const raw = toError(error)
  const name = typeof raw.name === 'string' && raw.name ? raw.name : 'Error'
  const message = typeof raw.message === 'string' ? raw.message.trim() : ''
  const title = message ? name + '：' + clip(message, 300) : name + '（没有错误信息）'
  const stack = typeof raw.stack === 'string' ? raw.stack : ''
  const detail = stack
    .split('\n')
    .map((line) => clip(line.trim(), 200))
    .filter(Boolean)
    .slice(0, 6)
    .join('\n')
  return { title, detail: detail || '（没有可用的堆栈信息）' }
}

/** React 的组件栈（componentDidCatch 的第二个参数）→ 头几行，用来定位是哪一段界面崩的。 */
export function describeComponentStack(info: { componentStack?: string | null } | null | undefined): string {
  const stack = info && typeof info.componentStack === 'string' ? info.componentStack : ''
  return stack.split('\n').map((line) => clip(line.trim(), 160)).filter(Boolean).slice(0, 4).join(' ← ')
}

/** 读崩溃账；形状不对就当没有（半个坏 JSON 不该让启动路径也跟着崩）。 */
export function readCrashRecord(storage: CrashStorage = defaultCrashStorage()): CrashRecord | null {
  let raw: string | null = null
  try { raw = storage.getItem(CRASH_STORAGE_KEY) } catch { return null }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<CrashRecord> | null
    if (!parsed || typeof parsed !== 'object') return null
    const count = Number(parsed.count)
    const lastAt = Number(parsed.lastAt)
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(lastAt)) return null
    return {
      count: Math.floor(count),
      lastAt,
      scope: typeof parsed.scope === 'string' ? parsed.scope : '',
      message: typeof parsed.message === 'string' ? parsed.message : '',
    }
  } catch { return null }
}

function writeCrashRecord(record: CrashRecord, storage: CrashStorage): void {
  try { storage.setItem(CRASH_STORAGE_KEY, JSON.stringify(record)) } catch { /* 写不进去也不影响止血 */ }
}

/** 记一次崩溃并返回累加后的账。窗口外的旧账不累加（那上一次故障已经过去了）；重复上报只算一次。 */
export function recordCrash(
  scope: string,
  error: unknown,
  now: number = Date.now(),
  storage: CrashStorage = defaultCrashStorage(),
): CrashRecord {
  const summary = describeError(error)
  const previous = readCrashRecord(storage)
  // 一次崩溃会被 StrictMode / 内外两层边界报好几遍：同 scope 同标题 5 秒内只记一次。
  if (previous && previous.scope === scope && previous.message === summary.title
    && now - previous.lastAt <= CRASH_DEDUPE_MS) return previous
  const recent = previous !== null && now - previous.lastAt <= CRASH_WINDOW_MS
  const record: CrashRecord = {
    count: (recent ? previous.count : 0) + 1,
    lastAt: now,
    scope,
    message: summary.title,
  }
  writeCrashRecord(record, storage)
  return record
}

/** 清账：界面跑满一段时间没崩过 = 这一次启动是好的，旧账不该把下一次启动也拖进安全模式。 */
export function clearCrashRecord(storage: CrashStorage = defaultCrashStorage()): void {
  try { storage.removeItem(CRASH_STORAGE_KEY) } catch { /* 清不掉只是多降级一次，不影响主流程 */ }
}

/** 启动自愈判据：窗口内崩了 >= CRASH_SELF_HEAL_AT 次 → 这一次启动直接进安全模式。 */
export function shouldSelfHeal(now: number = Date.now(), storage: CrashStorage = defaultCrashStorage()): boolean {
  const record = readCrashRecord(storage)
  if (!record) return false
  return record.count >= CRASH_SELF_HEAL_AT && now - record.lastAt <= CRASH_WINDOW_MS
}
