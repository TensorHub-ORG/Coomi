import { useMemo } from 'react'
import { create } from 'zustand'
import { toast } from 'sonner'
import { useEngine } from './engine'
import { useUi } from './ui'
// 提问超时设置（设置页「AI 能力」里的 askUser / askUserTimeoutMinutes）在这里落地：
// 到点自动跳过，见 scheduleAskTimeout。
import { useCapabilities } from './capabilities'
// 对话渲染管线的**唯一事实来源**是这一份 `messages: ChatItem[]`：
// 事件就地追加（applyEventsToMessages）、历史回读合并（applyHistoryItems）、
// 历史映射（itemsFromHistory）都在 lib/chat.ts，这里只负责把事件 / 回读结果落到 state。
import {
  applyEventsToMessages, applyHistoryItems, collapseAssistantCopies, dropPersistedAssistantCopies,
  firstTokenFromEvent,
  itemsFromHistory, tokenWindowMs, turnDurationFromEvent, validTurnMs,
  type AskAnswer, type AskAnswerItem, type ChatItem, type HistoryMergeOptions,
} from '../lib/chat'
import { notifyTurnDone } from '../lib/notify'
// 传输兜底：直连 WS 不通时改走壳内桥（见该文件顶部说明）。
import { createEngineSocket } from '../lib/engineSocket'
// event_seq 顺序门：缺口检测 / 乱序缓冲 / 去重（字段位置与协议见该文件顶部说明）。
import { createSeqGate, readEventSeq } from '../lib/eventSeq'
// 流式正文的提交节流（32ms 合批）：窗口内到达的 chunk 合成一次 set()，见 scheduleFlush。
import { commitDelay, countChars } from '../lib/streamCommit'
// 界面保险丝：提交闸门（熔断）、精简模式判定、单次折叠的时间预算。
import { DEFER_MS, commitWindowMs, isLean, reportCommit } from '../lib/guard'
import {
  ATTACHMENTS_PREFIX, DRAFT_PREFIX, QUOTES_PREFIX,
  clearInput, dropSessionBuckets, loadInput, saveInput, writeList, writeText,
  type BucketStore, type ComposerInput,
} from '../lib/sessionInput'
// 「新建但还没发第一条消息」的空会话：不进列表、发出首条才露面（规则见 lib/emptySession.ts 顶部）。
import {
  firstMessageSummary, hasSessionContent, readHiddenEmptySessions, splitHiddenSessions,
  writeHiddenEmptySessions,
} from '../lib/emptySession'
import type { AttachmentRef } from '../components/chat/AttachmentCard'
import type { QuoteRef } from '../components/chat/QuoteBlock'
// 扩展名解析只有一份实现（components/ui/FileBadge），这里引它保持口径一致：
// FileBadge 只依赖 lucide + cn，不会把 UI 依赖带进 store。
import { fileExt } from '../components/ui/FileBadge'
// 本轮产出（turn_end 的 artifacts 字段）：解析与去重都在 stores/artifacts，这里只存状态。
import { NO_ARTIFACTS, parseTurnArtifacts, type TurnArtifact } from './artifacts'

export interface SessionSummary {
  id: string
  title?: string
  preview?: string
  cwd?: string
  updatedAt?: number
  createdAt?: number
  running?: boolean
  provider_id?: string
  model?: string
  /** **本地标记，不是引擎字段**：这一行是「当前会话还没有任何内容」的占位行
   *  （灰色「空会话」，只在列表渲染时补上，见 ListPane）。
   *  引擎给的会话列表里**不会**有这种行 —— 没有内容的会话在 loadSessions 就被滤掉了。 */
  empty?: boolean
}

/** 一次「切换模型」的在途请求。
 *  引擎收到 select_model 后要先做一次上游凭据校验才落盘（web/mod.rs 的 select_model：
 *  validate_provider_activation → verify_provider_credentials → document.save），
 *  这段时间里回读会话/历史拿到的仍是旧模型——所以必须记住「正在切什么」，
 *  否则乐观显示会被引擎回填覆盖，表现为「切完闪一下又变回旧的」。 */
export interface ModelPending {
  providerId: string
  model: string
  /** 发起切换的本地时间（TTL 兜底用）。 */
  at: number
  /** 这次切换的 envelope id：引擎的 ack / error 帧会带着它回来，用来对账。 */
  requestId: string
  /** 切换前的显示值：引擎拒绝时回滚用。 */
  prevProviderId: string
  prevModel: string
}

export interface Approval { callId: string; toolName: string; detail: string }
export interface Question { callId: string; questions: Array<Record<string, any>> }

/** 回答一张提问卡时提交的东西：items 按问题 id 存（选中值 + 自填），skipped = 整卡跳过。 */
export interface AskAnswerPayload {
  items?: Record<string, AskAnswerItem>
  skipped?: boolean
  /** 到点自动收掉的（「提问等待超时」），不是用户主动跳过的。 */
  timedOut?: boolean
}
export type RunState = 'idle' | 'thinking' | 'executing' | 'awaiting_approval' | 'awaiting_question'

/// 最近一轮的执行信息：显示在 AI 消息底部（时间 · 模型 · 首 token · 生成耗时 · 速度）。
/// 耗时只认引擎口径（见 lib/chat.ts 的「本轮耗时的可信口径」），不再用挂钟差值：
/// 排队等待、引擎重启、界面挂起都不该算进「这一轮生了多久」。
export interface TurnMeta {
  /// 本轮结束的挂钟时间，只用来显示「几点几分」。
  endedAt: number
  /** 生成窗口的起点 = endedAt - generationMs。**只是兼容投影**：
       旧消费方（DockUsageTab）用 endedAt - startedAt 算耗时，这里保证差值恒等于
       本轮生成耗时；耗时不可信时给 NaN，fmtDuration 会落到「—」而不是假的 0ms。 */
  startedAt: number
  /// 生成耗时：引擎 turn_end 的耗时，退化时取「首 token → 末 token」窗口；越界为 null。
  generationMs: number | null
  /// 首 token 延迟（引擎给的）；取不到为 null。
  firstTokenMs: number | null
  model: string
  outputTokensPerSecond: number | null
  totalTokens: number | null
}

/// 会话累计统计（来自事件流 + 引擎用量），按会话 id 存在本地，切会话不串号。
export interface SessionStats {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  firstTokenMsSum: number
  firstTokenCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number
  cacheHitRate: number | null
}

const EMPTY_STATS: SessionStats = {
  turns: 0, steps: 0, llmMs: 0, toolMs: 0, firstTokenMsSum: 0, firstTokenCount: 0,
  inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheHitRate: null,
}

function loadStats(id: string): SessionStats {
  try {
    const raw = localStorage.getItem('coomi.stats.v1.' + id)
    return raw ? { ...EMPTY_STATS, ...(JSON.parse(raw) as SessionStats) } : { ...EMPTY_STATS }
  } catch { return { ...EMPTY_STATS } }
}

function saveStats(id: string, stats: SessionStats): void {
  if (!id) return
  try { localStorage.setItem('coomi.stats.v1.' + id, JSON.stringify(stats)) } catch { /* 忽略 */ }
}
const CWD_KEY = 'coomi.workdir.v1'

function readCwd(): string {
  try { return localStorage.getItem(CWD_KEY) ?? '' } catch { return '' }
  }

/* ── 输入区（草稿 / 引用 / 附件）与「最后打开的会话」：都按会话 id 落本地 ──
   新会话的 id 是前端生成的 uuid（引擎接受客户端指定的会话 id），
   此时会话还没落库，但草稿照样按这个 id 存，重启后能原样恢复。
   三个桶的键与规则统一收在 lib/sessionInput.ts（纯逻辑，测试直接跑它）：
   草稿 coomi.draft.v1.<id>、引用 coomi.quotes.v1.<id>、附件 coomi.attachments.v1.<id>。 */
const LAST_SESSION_KEY = 'coomi.lastSession.v1'

/** localStorage 里的三个桶：所有读写都过这里，隐私模式下不抛。 */
const bucketStore: BucketStore = {
  getItem: (key) => { try { return localStorage.getItem(key) } catch { return null } },
  setItem: (key, value) => { try { localStorage.setItem(key, value) } catch { /* 忽略 */ } },
  removeItem: (key) => { try { localStorage.removeItem(key) } catch { /* 忽略 */ } },
}

/** 读取某会话的输入框草稿；没有记录（或隐私模式）时返回空串。 */
export function readDraft(id: string): string {
  return id ? loadInput(bucketStore, id).draft : ''
}

/** 只写草稿那一格：草稿走 350ms 防抖，绝不能顺手把引用 / 附件的桶一起覆盖掉。 */
function writeDraft(id: string, text: string): void {
  if (!id) return
  // 空草稿要删键：否则每次打完再发出去都会留下一个空字符串。
  writeText(bucketStore, DRAFT_PREFIX, id, text)
}

/** 一个会话的整套输入区：切会话 / flush 时的交接单位。 */
type InputSnapshot = ComposerInput<QuoteRef, AttachmentRef>

const inputOf = (state: { draft: string; quotes: QuoteRef[]; attachments: AttachmentRef[] }): InputSnapshot =>
  ({ draft: state.draft, quotes: state.quotes, attachments: state.attachments })

/** 切会话 / 关窗前的 flush：把**这个会话**的草稿、引用、附件整体落盘。 */
function flushInput(id: string, input: InputSnapshot): void {
  if (!id) return
  saveInput(bucketStore, id, input)
}

/** 切会话 / 打开会话后的加载：读**目标会话**的那一份；没有桶（新会话）就是空输入区。 */
function loadInputOf(id: string): InputSnapshot {
  return id ? loadInput<QuoteRef, AttachmentRef>(bucketStore, id) : { draft: '', quotes: [], attachments: [] }
}

/** 还没有会话归属时（引擎就绪 → 打开会话之间的空窗）用户可能已经打了字 / 加了附件：
    把这份「游离输入」按目标会话落盘，否则切走再切回就没了。 */
function adoptUnownedInput(id: string, unowned: InputSnapshot | null, loaded: InputSnapshot): InputSnapshot {
  if (!unowned) return loaded
  const merged: InputSnapshot = {
    draft: unowned.draft || loaded.draft,
    quotes: unowned.quotes.length ? unowned.quotes : loaded.quotes,
    attachments: unowned.attachments.length ? unowned.attachments : loaded.attachments,
  }
  if (merged.draft || merged.quotes.length || merged.attachments.length) saveInput(bucketStore, id, merged)
  return merged
}

/** 上一次 /api/sessions 见过的会话 id：用来发现「这次不在列表里了」的会话（＝被删了）。 */
let knownSessionIds: Set<string> | null = null

/** 清掉已经不存在的会话留下的输入区桶（删会话的兜底：localStorage 不会只涨不跌）。
    第一次拿到列表只登记不清——那时本地还不知道哪些是真没了，别把「刚建、还没落库」的会话误删。
    当前会话永远不动（它可能还没出现在引擎列表里）。 */
function forgetMissingSessions(sessions: SessionSummary[], keepId: string): void {
  const ids = new Set(sessions.map((s) => s.id).filter(Boolean))
  const previous = knownSessionIds
  knownSessionIds = ids
  if (!previous) return
  for (const id of previous) {
    if (ids.has(id) || id === keepId) continue
    dropSessionBuckets(bucketStore, id)
  }
}

/* ── 「新建但还没发第一条消息」的空会话（规则见 lib/emptySession.ts 顶部） ──
   名单落 localStorage（coomi.emptySessions.v1）：重启后引擎那边那条空记录还在，
   没有这份名单它就会以「未命名对话」的样子回到左侧列表里。
   注意：**可见性不只靠这份名单**。名单只管「这次新建、还没发」的那一条，
   老版本留下的空记录（不在名单里、引擎里就是没有内容）由 hasSessionContent 那条判据挡掉，
   两层合起来才是「左侧列表里不会出现空壳」的完整规则（见 loadSessions 与下文的 contentlessSessionIds）。
   一切「没发消息就切走」的善后都在这里收口：名单不动＝这条空会话被丢弃（不会再回到列表），
   而草稿桶（coomi.draft.v1.<id>）一个字都不动，按同一个 id 还能恢复。 */
const hiddenEmptySessions = new Set<string>(readHiddenEmptySessions(bucketStore))

/** 新建时记上：这条会话在用户说出第一句话之前不进列表。 */
function hideEmptySession(id: string): void {
  if (!id || hiddenEmptySessions.has(id)) return
  hiddenEmptySessions.add(id)
  writeHiddenEmptySessions(bucketStore, hiddenEmptySessions)
}

/* ── 引擎侧「没有任何内容」的会话 id ──
   与上面那份本地名单是两回事：名单只知道「这次新建、还没发」的那一条，
   而**老版本留下的空记录**不在名单里（它可能早就发过一次、或者压根不是这份名单建的），
   却同样什么都不该显示。所以可见性以引擎数据为准（lib/emptySession 的 hasSessionContent），
   这份集合只回答另一个问题：**当前会话**是不是「空会话」——是的话列表要为它留一行灰色占位，
   否则用户明明在某条会话里，列表上却找不到自己在哪一行。
   loadSessions 每次用引擎的原始列表重建；首条消息发出时立刻摘掉。 */
let contentlessSessionIds = new Set<string>()

/** 当前会话是不是「引擎里确实存在、但一个字的标题 / 摘要都没有」的空会话。
 *
 *  只给列表用：新建但一个字都没发的会话**不在此列**（它归上面那份名单管，
 *  列表照旧不为它占行 —— 那是已经定下的行为）。这里管的是老版本留下的空记录：
 *  它不进列表，但用户正看着它的时候要有一个明确的「空会话」标识。 */
export function currentSessionIsEmpty(): boolean {
  const id = useSession.getState().sessionId
  if (!id || hiddenEmptySessions.has(id)) return false
  return contentlessSessionIds.has(id)
}

/** 首条消息真的发出去了：从名单里摘掉（列表那一行由 send 本地补上，不等引擎回读）。 */
function unhideEmptySession(id: string): void {
  if (!id || !hiddenEmptySessions.has(id)) return
  hiddenEmptySessions.delete(id)
  writeHiddenEmptySessions(bucketStore, hiddenEmptySessions)
}

/** 清掉这条会话的进程内缓存（会话级的那些 Map / Set）：丢空会话 / 新建换会话时用。 */
function dropSessionMemo(id: string): void {
  if (!id) return
  messagesBySession.delete(id)
  liveTurnSessions.delete(id)
}

/** 上次打开的会话 id：启动时优先恢复它。 */
export function readLastSession(): string {
  try { return localStorage.getItem(LAST_SESSION_KEY) ?? '' } catch { return '' }
}

export function rememberLastSession(id: string): void {
  if (!id) return
  try { localStorage.setItem(LAST_SESSION_KEY, id) } catch { /* 忽略 */ }
}

/* ── 「这条消息带了哪些附件 / 引用」的本地索引 ──
   正文里不再拼「附件：<路径>」与「> 」前缀（改走 WS 的 attachments / quotes 字段），
   但界面还要把它们画成卡片，而引擎那边**未必**把这两个字段写进历史，
   所以要本地留一份索引：
     · 键是**正文**：引擎回读回来的用户消息正文与发送时一字不差，能对上
       （乐观条目连引擎 id 都还没有，只能靠正文认领，见 decorateHistory）；
     · 按会话落 localStorage：刷新 / 重启后消息里的附件卡片与引用块不会凭空消失；
     · 引擎真的把这两个字段落库之后，装饰时以引擎的值为准（见 decorateHistory）。
   同一段正文发过多次时按先后顺序逐条认领（decorateHistory 的 queue），不会互相串。 */
const MSG_META_PREFIX = 'coomi.msgmeta.v1.'
/** 每个会话最多存这么多条：够回溯整个会话，也不会把 localStorage 撑爆。 */
const MSG_META_LIMIT = 200

interface SentMeta {
  /** 正文（索引键） */
  text: string
  at: number
  attachments: AttachmentRef[]
  quotes: QuoteRef[]
}

const sentMetaBySession = new Map<string, SentMeta[]>()

/** 读某会话的索引（进程内缓存；localStorage 读失败按空处理，绝不抛）。 */
function readSentMeta(sessionId: string): SentMeta[] {
  if (!sessionId) return []
  const cached = sentMetaBySession.get(sessionId)
  if (cached) return cached
  let list: SentMeta[] = []
  try {
    const raw = localStorage.getItem(MSG_META_PREFIX + sessionId)
    if (raw) {
      list = (JSON.parse(raw) as SentMeta[]).filter(
        (entry) => entry && typeof entry.text === 'string' && Array.isArray(entry.attachments) && Array.isArray(entry.quotes),
      )
    }
  } catch { list = [] }
  sentMetaBySession.set(sessionId, list)
  return list
}

/** 记一条「这条正文带了什么」。发送成功后调用（没发出去的不记，免得凭空多出卡片）。 */
function rememberSentMeta(sessionId: string, entry: SentMeta): void {
  if (!sessionId) return
  const list = readSentMeta(sessionId).concat(entry).slice(-MSG_META_LIMIT)
  sentMetaBySession.set(sessionId, list)
  try { localStorage.setItem(MSG_META_PREFIX + sessionId, JSON.stringify(list)) } catch { /* 隐私模式忽略 */ }
}

/** 给引擎回读的历史挂上结构化附件 / 引用：
    · 引擎已经给了这两个字段 → 原样保留（引擎是权威）；
    · 只有本地索引有 → 补上，并打 __structured 标记（渲染层据此不做旧格式升级）；
    · 两边都没有 → 原样返回，交给渲染层按旧消息处理（「> 」/「附件：」前缀升级）。
   同正文多条时按历史顺序逐条认领，避免「同一句话配了两份不同附件」时挂错。 */
function decorateHistory(sessionId: string, messages: Array<Record<string, any>>): Array<Record<string, any>> {
  const queue = new Map<string, SentMeta[]>()
  for (const entry of readSentMeta(sessionId)) {
    const list = queue.get(entry.text)
    if (list) list.push(entry)
    else queue.set(entry.text, [entry])
  }
  let changed = false
  const out = messages.map((message) => {
    if (String(message?.role ?? '') !== 'user') return message
    const engineAttachments = Array.isArray(message.attachments) ? message.attachments : null
    const engineQuotes = Array.isArray(message.quotes) ? message.quotes : null
    const text = String(message.content ?? '')
    const hit = queue.get(text)?.shift()
    if (!engineAttachments && !engineQuotes && !hit) return message
    changed = true
    return {
      ...message,
      attachments: engineAttachments ?? hit?.attachments ?? [],
      quotes: engineQuotes ?? hit?.quotes ?? [],
      __structured: true,
    }
  })
  return changed ? out : messages
}

/** 发送时额外带的结构化字段（都在正文之外）：
    附件只有输入框知道（它按会话暂存在组件里），引用缺省取当前芯片。 */
export interface SendExtras {
  attachments?: AttachmentRef[]
  quotes?: QuoteRef[]
}

interface SessionState {
  sessionId: string
  sessions: SessionSummary[]
  /** **单一事实来源**：这一份 `messages: ChatItem[]` 就是对话的全部。
      没有「历史 vs 实时事件 vs 已展示记忆」三套状态 —— 事件就地追加、历史回读合并，
      见 lib/chat.ts 的 applyEventsToMessages / applyHistoryItems。 */
  messages: ChatItem[]
  /** 每个会话的历史是否已经回读完（按会话 id）。
      未加载完时界面一律渲染消息骨架，绝不先闪一下「新对话」空态；切会话时若有旧内容则保留并降透明度。 */
  historyLoaded: Record<string, boolean>
  streaming: boolean
  connected: boolean
  runState: RunState
  approval: Approval | null
  question: Question | null
  /** 提问卡的回答（按引擎 call_id 存）：**答完不删** —— 卡片留在对话流里显示你选了什么。
   *  与 question 的生命周期不同：question 是「当前挂起的那一问」（答完就 null），
   *  这份是会话级的账，只在切会话 / 新建会话时清掉。 */
  askAnswers: Record<string, AskAnswer>
  /// 本轮被用户中断（用于显示「已中断 · 继续生成」）
  interrupted: boolean
  /** 上游抖动、引擎正在自动重试（engine 的 ConnectionRetry）：状态条据此显示
      「正在自动恢复（第 N/M 次）」，而不是让界面干等几十秒什么都不说。 */
  retrying: { attempt: number; max: number; delayMs: number; at: number } | null
  setInterrupted: (v: boolean) => void
  /** 上一轮因**引擎崩溃**而中断（区别于用户手动停止）：显示醒目的「上次任务被中断 · 继续」条。 */
  crashInterrupted: boolean
  /** 引擎重启后正在恢复当前会话（重连 + 回读历史）。 */
  resuming: boolean
  /// 点「继续」：把被中断的那一轮接着跑（清掉提示条再发）。
  resumeInterruptedTurn: () => void
  dismissCrashInterrupted: () => void
  stats: SessionStats
  pendingFirstTokenMs: number
  currentModel: string
  /// 当前模型所属的厂商 id。切换模型后界面要立刻显示「厂商 / 模型」，
  /// 不能等下一次 /api/providers 刷新（那样切完还是旧名字）。
  currentProviderId: string
  /** 在途的模型切换；null 表示显示值可以完全交给引擎回填。 */
  modelPending: ModelPending | null
  resetStats: () => void
  setModel: (label: string, providerId?: string) => void
  draft: string
  pendingCwd: string
  loadSessions: () => Promise<void>
  /// 回读历史。options.replace 只给「引擎侧真的截断过」的路径用（见 lib/chat.ts）。
  loadHistory: (id: string, options?: HistoryMergeOptions) => Promise<void>
  openSession: (id: string) => Promise<void>
  /// 新建会话；传 id 时用它（启动时恢复「还没落库但存了草稿」的新会话）。
  newSession: (id?: string) => Promise<void>
  applyCwd: (dir: string) => Promise<void>
  rememberCwd: (dir: string) => void
  setDraft: (text: string) => void
  sendCommand: (payload: Record<string, unknown>) => void
  scheduleReconnectPublic: () => void
  /** 引用芯片（可多条）：发送时走 quotes 字段，不再把引用文字拼进正文。
      与附件、草稿一样**按会话分桶**（lib/sessionInput）：切会话先 flush 再 load。 */
  quotes: QuoteRef[]
  /** 加一条引用；同一条消息 / 同一段文字已经在列表里就不再重复加。 */
  addQuote: (input: { text: string; msgId?: string; at?: number }) => void
  removeQuote: (id: string) => void
  clearQuotes: () => void
  /** 待发送的附件（同样按会话分桶持久化；输入区只显示这一份，不含历史消息里的附件）。 */
  attachments: AttachmentRef[]
  /** 收下一批附件路径（按路径去重）。大小由调用方 stat 之后用 setAttachmentSize 补。 */
  addAttachments: (paths: string[]) => void
  removeAttachment: (path: string) => void
  setAttachmentSize: (path: string, size: number) => void
  clearAttachments: () => void
  linkError: string
  connecting: boolean
  turnMeta: TurnMeta | null
  /** 本轮产出的文件（turn_end 的 artifacts 字段）：渲染在最后一条有正文的回复下方。
      空产出时**必须**是 stores/artifacts 的 NO_ARTIFACTS 那个常量 —— 渲染层按引用比较，
      每次给一个新数组会让整行白重渲染一遍（见 MessageList 的 ChatRowMemo）。 */
  turnArtifacts: TurnArtifact[]
  reconnect: () => void
  branchFrom: (msgId: string) => Promise<void>
  editAndResend: (msgId: string, text: string) => Promise<void>
  regenerate: (msgId: string) => Promise<void>
  retryLast: () => Promise<void>
  send: (text: string, extras?: SendExtras) => void
  cancel: () => void
  approve: (decision: 'allow' | 'always' | 'deny') => void
  /** 回答 AI 的提问。callId 缺省用当前挂起的那一问；payload 缺省 = 跳过。
   *  回答先落本地（卡片立刻显示你选了什么），再按引擎的 answer_question 命令发出去。 */
  answerQuestion: (payload?: AskAnswerPayload, callId?: string) => void
  selectModel: (providerId: string, model: string) => void
  disconnect: () => void
}

let socket: WebSocket | null = null
let reconnectTimer: number | null = null
let reconnectAttempt = 0
// socket 世代号：旧连接的 close/error 回调不能再改新连接的状态（横幅闪烁的根因）
let socketGeneration = 0
// 会话消息缓存（按会话）：**切走再切回**时，历史里还没有的本地尾部（乐观条目 / 还在流式的
// 回复）就靠它兜住 —— 见 openSession 的 messagesBySession.get(id)。
const messagesBySession = new Map<string, ChatItem[]>()

/** 消息流水账（诊断「我发的消息丢了」用）：每次发送 / 回读 / 切会话记一条，
 *  写进 localStorage（保留最近 200 条，跨重启可查）。
 *  记录：阶段、消息条数、最后一条用户消息正文前 24 字、是否流式中、会话 id 前 8 位。 */
const MSG_JOURNAL_KEY = 'coomi.msgjournal.v1'
function journalMessageEvent(
  phase: string,
  list: readonly ChatItem[],
  extra: Record<string, unknown> = {},
): void {
  try {
    let lastUser = ''
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i]
      if (item.kind === 'user') { lastUser = item.text.trim().slice(0, 24); break }
    }
    const raw = localStorage.getItem(MSG_JOURNAL_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown[]) : []
    arr.push({ at: Date.now(), phase, len: list.length, lastUser, ...extra })
    localStorage.setItem(MSG_JOURNAL_KEY, JSON.stringify(arr.slice(-200)))
  } catch { /* 记账失败绝不影响主流程 */ }
}
/** journalMessageEvent 的穿线版：记一笔再把同一个数组原样返回，便于写在 set(...) 里。 */
function journaled(list: ChatItem[], phase: string, extra: Record<string, unknown> = {}): ChatItem[] {
  journalMessageEvent(phase, list, extra)
  return list
}

/** 换一批消息进 store 前的统一记账：变少记 SHRINK，正常记一笔。 */
function journaledSwap(
  before: readonly ChatItem[],
  after: ChatItem[],
  phase: string,
  extra: Record<string, unknown> = {},
): ChatItem[] {
  // 只有「同一个会话的回读」才把变短当异常：切换会话本来就该换一批条目（长度不同很正常），
  // 那种情况记进来只会把真正的丢消息淹掉。
  if (phase === 'readback') journalShrink(before, after, phase)
  return journaled(after, phase, extra)
}

/** 条目的「可读签名」：notice/ask 没有 text 字段，用提示语顶上。 */
function itemSign(item: ChatItem): string {
  const text = 'text' in item && typeof item.text === 'string' ? item.text : 'prompt' in item ? item.prompt : ''
  return item.kind + '|' + text
}

/** 消息条数变少 == 用户眼里的「消息丢了」。这是最关键的信号，单独高亮记一笔。 */
function journalShrink(before: readonly ChatItem[], after: readonly ChatItem[], phase: string): void {
  if (after.length >= before.length) return
  const kept = new Set(after.map(itemSign))
  const lost = before
    .filter((i) => !kept.has(itemSign(i)))
    .map((i) => itemSign(i).slice(0, 30))
  journalMessageEvent('SHRINK', after, { phase, before: before.length, after: after.length, lost: lost.slice(-6) })
}

// 本地记着「这一轮还没收到 turn_end」的会话：切回一个正在跑的会话时 streaming 要跟着恢复，
// 看门狗也要起搏（引擎的 /api/sessions running=true 是同一件事的权威值）。
const liveTurnSessions = new Set<string>()
// 轮次序号：turn_end 后异步回读历史期间，用户可能已经发了新一轮，
// 那时不能把新一轮的实时事件清掉（异步回调作废判据，见 isTurnCurrent）。
let turnSeq = 0
// 流式事件的就地追加序号：只用来给「新建的那条助手消息」一个稳定且不撞的本地 id。
let streamSeq = 0
// 本轮「首 token → 末 token」的本地打点（只在真的收到 chunk 时打）：
// 引擎没给耗时时的退化口径，天然不含排队、引擎重启与界面挂起。
let turnFirstTokenAt = 0
let turnLastTokenAt = 0

/* ── AI 提问的等待超时 ──
   设置项 capabilities.askUserTimeoutMinutes（0 = 一直等）在这里落地：引擎停下来等用户补信息时，
   到点就按「跳过」把这一问收掉，别让整轮对话干等（引擎侧若也实现了同一个超时，谁先到点谁收）。
   计时器只有一份：同一时刻只可能有一问挂起，新的提问进来直接顶掉旧的。 */
let askTimeoutTimer: number | null = null

function clearAskTimeout(): void {
  if (askTimeoutTimer === null) return
  window.clearTimeout(askTimeoutTimer)
  askTimeoutTimer = null
}

/** 提问挂起时按设置起搏一次超时（0 / 非正数 = 一直等，不起搏）。 */
function scheduleAskTimeout(callId: string): void {
  clearAskTimeout()
  const minutes = useCapabilities.getState().caps.askUserTimeoutMinutes
  if (!Number.isFinite(minutes) || minutes <= 0 || !callId) return
  askTimeoutTimer = window.setTimeout(() => {
    askTimeoutTimer = null
    const state = useSession.getState()
    // 到点时这一问已经答过 / 已经翻篇：什么都不做（超时不是「无条件收卡」）。
    if (state.question?.callId !== callId) return
    state.answerQuestion({ skipped: true, timedOut: true }, callId)
  }, minutes * 60_000)
}

/* ── 富文本渲染信号（Markdown 解析标记 / 语法高亮请求）──
   常规模式：每提交一拍正文就把版本号 +1。渲染侧（Markdown / CodeBlock）按版本号决定要不要
   重解析、要不要对已闭合的围栏块发高亮请求 —— 这是「只在正文真的变了才做重活」的依据。
   精简模式（guard.isLean()）：**不做这件事** —— 版本号不递增（渲染侧因此既不重解析、
   也不发高亮请求），只置一个 lean 标记，渲染侧读到就按纯文本画。
   正文本身照常走事件流、一个字都不丢：省掉的是解析与高亮，不是内容。 */
let richVersion = 0
let richLeanMarked = false
let richSkipped = 0

/** 当前富文本信号：版本号 / 精简标记 / 精简期间被跳过的次数（渲染侧与诊断读它）。 */
export function richSignal(): { version: number; lean: boolean; skipped: number } {
  return { version: richVersion, lean: richLeanMarked, skipped: richSkipped }
}

/** 提交了一拍正文之后置标记：常规递增版本号，精简模式只置标记（不触发解析与高亮）。 */
function noteRichCommit(): void {
  if (isLean()) {
    richLeanMarked = true
    richSkipped += 1
    return
  }
  richVersion += 1
  richLeanMarked = false
}

/* ── 看门狗：AI 明明已经输出完了，界面还挂着「进行中」 ──
   turn_end 是会丢的：引擎进程崩了、WS 断线重连把那一帧吃掉、cancel 分支没走到
   最后的 push_event。丢了以后 streaming / runState 就永远停在「进行中」，
   停止按钮也一直亮着。这里的判据只有两条，都必须是硬证据：
     ① 距最近一次事件超过 STALL_MS（真的没有东西在流了）；
     ② 引擎的 /api/sessions 里这个会话 running=false（引擎才是权威）。
   两条同时成立才强制复位成「完成」；引擎不可达时宁可不动（重连/重启流程会接手）。 */
const STALL_MS = 3_000
/** 看门狗探测节流：每秒醒一次，但最多两秒问一次引擎（避免卡住时狂打 HTTP）。 */
const WATCHDOG_PROBE_MS = 2_000
/** 同一个轮次序号在这么短时间内重复到达的 turn_end 判为重复帧（引擎取消 + 收尾各发一条）。 */
const TURN_END_DUP_MS = 1_500
// 最近一次收到事件的时间（任何事件都算：chunk、工具、用量…）。
let lastEventAt = 0
let watchdogTimer: number | null = null
let watchdogProbeAt = 0
/** 连续几次探测都够不到引擎（HTTP 直接失败）＝ 引擎进程多半已经不在了。
    从这个次数起把界面收成「已中断」，而不是永远停在「进行中」。 */
const ENGINE_DEAD_PROBES = 2
let engineProbeFailures = 0
/** 工具执行期的豁免窗口：引擎忙（HTTP 慢）不等于死，绝不判停。 */
let toolBusyUntil = 0

/* ── 「谁把这一轮收尾了」的流水账（2026-09-28 真机事故的排查设施）──
   现象：任务还在跑，停止键突然变回发送键、右下角「思考中」消失。
   能同时把 streaming 与 runState 收成 idle 的入口有 5 个（error 帧 / session_state /
   心跳 / 看门狗 / 重连复核），没有这份流水账就只能靠猜。
   读法：CDP 里 `__sessionDebug.settleLog()`。 */
const settleLog: Array<{ at: number; reason: string; quietMs: number }> = []
function noteSettle(reason: string): void {
  settleLog.push({ at: Date.now(), reason, quietMs: lastEventAt ? Date.now() - lastEventAt : -1 })
  if (settleLog.length > 20) settleLog.splice(0, settleLog.length - 20)
}
/* turn_end 幂等：记录「上一次按完整流程处理过的**轮次身份** + 时间」。
   身份不能再用本地的 turnSeq：它只在 send() 的**正常分支**里 +1，而插话 / 排队分支会提前
   return（见 useSession 的 send）—— 排队产生的每一轮根本不递增它。于是两条排队消息在 1.5 秒内
   相继结束时，第二条 turn_end 的 endedSeq 与第一条相同，会被误判成重复帧（轮次少计、完成提醒
   丢失）。现在由 markTurnStarted() 在**每一轮真正开始时**递增同一个身份：正常发送、
   queued_message_started、turn_interrupted、life_delivered 四条路径都调它（见各自的调用点）。 */
let turnIdentity = 0
let lastTurnEndToken = -1
let lastTurnEndAt = 0

/** 新一轮真正开始：turn_end 判重的轮次身份 +1（**唯一入口**，所有开轮路径都必须过它）。 */
function markTurnStarted(): void { turnIdentity += 1 }

/* turn_end 之后的历史回读阶梯。
   引擎要先把这一轮的 user/assistant/tool 落库，单次回读常常赶在前面拿到旧快照；
   现在按 0 / 300ms / 1s / 2.5s 重试，每次回读都走 applyHistoryItems ——
   历史覆盖的部分换成权威版本、还没落库的本地尾部原样保留，因此回读滞后不丢任何内容。 */
const TURN_READBACK_STEPS_MS = [0, 300, 1_000, 2_500]
// 引擎重启恢复：崩溃/自愈时这一轮还没跑完，ready 之后据此决定要不要提示「继续」。
let resumeAfterRestart = false

/* ── 模型切换的两个超时 ──
   ① 阶梯回读：引擎要先做上游凭据校验才落盘，单次 400ms 回读常常赶在前面，
      所以 400ms / 1.5s / 3s 各回读一次，命中即停；
   ② TTL 兜底：10s 还没确认就作废这次乐观显示，回到引擎真值，
      免得校验超时或连接抖动时界面永远停在用户点过的那个模型上。 */
const MODEL_READBACK_STEPS_MS = [400, 1_500, 3_000]
const MODEL_PENDING_TTL_MS = 10_000
// 在途的「切换模型」请求 id：用完即删。用它把「切换失败」与「执行出错」分开——
// 连点两次切换时，第一次的失败帧不能变成对话里的一条 agent_error。
const modelRequestIds = new Set<string>()

/// 引擎的 WS 协议是信封格式：{ id?, payload: { command, ... } }。
/// 之前直接发扁平 { command } 会被判成 "unsupported command"，所有操作都静默失效。
function envelope(payload: Record<string, unknown>): string {
  return JSON.stringify({ id: crypto.randomUUID(), payload })
}

/// 需要用**指定 id** 发信的场景（目前只有 select_model：成功后引擎回 ack、
/// 失败回 error，两条帧都带这个 id，前端据此确认或回滚这次切换）。
function envelopeWithId(id: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ id, payload })
}

/* ── event_seq：缺口检测 / 补帧（resync）/ 确认（ack） ──
   引擎给**每个** push_event 事件在事件 payload 里（与 event_type 同级）放了一个单调递增的
   event_seq（从 1 开始），信封是 { type:'event', payload: { event_type, event_seq, … } }，
   ws.onmessage 解包后拿到的就是 payload —— 所以前端里它就挂在事件对象顶层。
   作用：断线 / 弱网时事件可能在引擎侧被丢掉（conn_tx 为空、队列裁剪、重连竞态），
   客户端按 event_seq 认缺口、用 {command:'resync', after_seq} 请引擎补发、
   用 {command:'ack', seq} 让引擎裁掉未确认队列（见 apps/coomi-rs/ui/src/web/mod.rs 的
   push_event / resync_from / acknowledge_through）。
   注意：引擎的 begin_turn 会清空未确认队列，所以**补帧只在同一轮内**有效；跨轮（例如整轮丢在
   断线期间）仍然靠原有的「轮末回读会话历史」路径补齐 —— 那条老路径原样保留。 */
const seqGate = createSeqGate<Record<string, any>>()
/** 新连接上的第一帧：用来识别「引擎重启后 event_seq 从 1 重新计数」（见 handleEvent）。 */
let firstEventOnConnection = true
/** 已经 ack 过的 seq：同一个位置只 ack 一次。 */
let ackedEventSeq = 0
/** 距上次 ack 处理过的事件数：攒够 ACK_EVERY_EVENTS 就 ack 一次，避免每帧都发。 */
let eventsSinceAck = 0
let ackTimer: number | null = null
/** 每处理这么多条事件 ack 一次。 */
const ACK_EVERY_EVENTS = 50
/** ack 的兜底周期：事件稀疏时也把「处理到哪」告诉引擎，未确认队列不会一直涨。 */
const ACK_EVERY_MS = 5_000
/** resync 的最小间隔：缺口可能连着来好几帧，不能每帧都发一条（补帧在途时也无需重复请求）。 */
const RESYNC_MIN_INTERVAL_MS = 500
let resyncRequestedAt = 0

/** 请求补帧：把本地「已按序处理的最后一条」报给引擎，它会按原顺序重发之后的所有未确认事件。
    force=true 用于「刚重连」这一次：必须发，不能被杀平（缺口触发的那几次才需要节流）。 */
function requestResync(force = false): void {
  const last = seqGate.last()
  // last=0 没有可补的基线（引擎的 seq 可能早已涨过），补帧反而会把整段历史再灌一遍。
  if (last <= 0) return
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  const now = Date.now()
  if (!force && now - resyncRequestedAt < RESYNC_MIN_INTERVAL_MS) return
  resyncRequestedAt = now
  socket.send(envelope({ command: 'resync', after_seq: last }))
}

/** 把「已处理到哪」告诉引擎，让它裁掉未确认队列；断开时不发（连接没了，发了也没意义）。 */
function sendSeqAck(): void {
  const last = seqGate.last()
  if (last <= ackedEventSeq) return
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  ackedEventSeq = last
  eventsSinceAck = 0
  socket.send(envelope({ command: 'ack', seq: last }))
}

/** 处理了一批事件之后记账：攒够 ACK_EVERY_EVENTS 条立刻 ack，否则起一个 5 秒兜底定时器。 */
function noteSeqAck(count: number): void {
  if (count <= 0) return
  eventsSinceAck += count
  if (eventsSinceAck >= ACK_EVERY_EVENTS) { sendSeqAck(); return }
  if (ackTimer === null) ackTimer = window.setInterval(sendSeqAck, ACK_EVERY_MS)
}

/** 停掉 ack 兜底定时器（断线 / 切会话 / 主动断开时调用；它只负责「顺便 ack」，停掉不丢内容）。 */
function stopSeqAckTimer(): void {
  if (ackTimer !== null) { window.clearInterval(ackTimer); ackTimer = null }
}

/** 换会话 / 引擎重启：event_seq 的坐标系换了（新的 SessionTask 从 1 重新计数），
    顺序门、ack 记账与 turn_end 判重身份一起复位。重连**不**走这里（last 要留给 resync）。 */
function resetEventStream(): void {
  seqGate.reset()
  ackedEventSeq = 0
  eventsSinceAck = 0
  resyncRequestedAt = 0
  firstEventOnConnection = true
  // 换会话后新会话的第一条 turn_end 不能和上一个会话的判重键撞上。
  lastTurnEndToken = -1
  lastTurnEndAt = 0
  stopSeqAckTimer()
}

/* ── 会话列表后台轮询（2026-09-28 多会话并行）──
   为什么需要：`/api/sessions` 的 running 只在 turn_end / 切会话 / 重连 / 看门狗探测时刷新，
   而这些时机基本都只覆盖**当前**会话 —— 于是「另一个会话还在后台跑」在界面上看不见：
   左侧列表的呼吸点不亮、任务页签也来不及更新，用户就以为「不能同时跑两个会话」。
   引擎那边本来就是并行的（任务锚在会话上、不锚在连接上），所以这里只需要让它可见：
   5 秒一次 /api/sessions（引擎注释里写明这个接口就是给前端轮询用的，很轻）。
   页面不可见时跳过 —— 后台标签页的定时器本来就会被节流，没必要白打。 */
let sessionsPollTimer: number | null = null
function startSessionsPoll(): void {
  if (sessionsPollTimer !== null) return
  sessionsPollTimer = window.setInterval(() => {
    const state = useSession.getState()
    if (!state.connected) return
    if (typeof document !== 'undefined' && document.hidden) return
    void state.loadSessions().catch(() => { /* 引擎忙 / 不可达：下一拍再说 */ })
  }, 5_000)
}

/** 一次 state 补丁：对象（并进 state）或函数（按当前 state 算出来）。 */
type SessionPatch = Partial<SessionState> | ((state: SessionState) => Partial<SessionState>)

export const useSession = create<SessionState>((applyPatch, get) => {
  // 调试出口（排查「最终正文消失」用）：把 messages / 会话 id 暴露到 window，
  // 供 CDP 直接读取对比 DOM —— 定位是「数据没有」还是「数据有但没渲染」。
  ;(window as unknown as { __sessionDebug?: unknown }).__sessionDebug = {
    read: () => {
      const items = get().messages
      const lastAssistant = [...items].reverse().find((it) => it.kind === 'assistant')
      return {
        sessionId: get().sessionId,
        messagesLen: items.length,
        // 最近 10 条（诊断「消息消失」时够看一轮的来龙去脉）
        messagesTail: items.slice(-10),
        streaming: get().streaming,
        // 诊断「正文输出完消失」：最后一条助手正文有多长 / 有没有顺序段。
        lastAssistantTextLen: (lastAssistant?.text ?? '').length,
        lastAssistantSegments: (lastAssistant?.segments ?? []).length,
      }
    },
    /** 消息流水账：`__sessionDebug.journal()` 看最近 200 条，
     *  其中 phase==='SHRINK' 的那几条就是「消息真的被抹掉」的铁证（带着丢了哪些条目）。 */
    /** 「谁把这一轮收尾了」：最近 20 次强制收尾的原因（quietMs = 收尾前静了多久）。 */
    settleLog: () => settleLog.slice(),
    journal: () => {
      try { return JSON.parse(localStorage.getItem(MSG_JOURNAL_KEY) || '[]') as unknown[] }
      catch { return [] }
    },
    clearJournal: () => { try { localStorage.removeItem(MSG_JOURNAL_KEY) } catch { /* 忽略 */ } },
    /** 「看得见吗」自检：列出消息行里**落在可视区却没有被绘制**的那些。
     *  为什么需要它：2026-09-27 的「用户消息消失」根因是 CSS 的 content-visibility:auto
     *  让浏览器把**就在视口里**的行跳过绘制（行在 DOM、高度也正常，屏幕上就是没有）。
     *  状态层一切正常，只有这一项能当场判定「是不是渲染被跳过了」。
     *  正常情况返回 { bad: [] }；有 bad 就是又出现了整行不绘制。 */
    paintCheck: () => {
      const scroller = document.querySelector('[data-msg-scroller]')
      if (!scroller) return { bad: [], note: 'no-scroller' }
      const rect = scroller.getBoundingClientRect()
      const bad: Array<Record<string, unknown>> = []
      const rows = Array.from(document.querySelectorAll('[data-msg-index]'))
      for (const el of rows) {
        const r = el.getBoundingClientRect()
        const overlap = Math.max(0, Math.min(r.bottom, rect.bottom) - Math.max(r.top, rect.top))
        if (overlap < 8) continue
        let painted: boolean | null = null
        try {
          const check = (el as unknown as { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility
          painted = typeof check === 'function'
            ? check.call(el, { contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })
            : null
        } catch { painted = null }
        if (painted === false) {
          bad.push({
            index: el.getAttribute('data-msg-index'),
            overlapPx: Math.round(overlap),
            height: Math.round(r.height),
            text: (el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 40),
          })
        }
      }
      return { rows: rows.length, bad }
    },
  }
  /* ── 提交闸门：所有 state 提交的唯一出口 ──
     以前 60 多处 set() 各写各的，谁也说不清「这一帧到底提交了几次」；现在统一从这里走，
     每次提交都过 lib/guard.ts 的熔断闸门并计数（见 guardStats 的 commit 统计）：
       · 同一帧同一个 store 超过 5 次 → 多出来的**这一帧先不提交**，顺延到下一帧合并成一次。
         注意是顺延不是丢弃：状态一条都不丢，只是少画几帧 —— 界面宁可慢一拍，也不能被
         一个刷 state 的循环拖到整屏不动（那正是「发消息就卡死」的形态）。
       · 关键提交（连接状态、轮次收尾、等待审批）走 commitCritical：这类补丁被挡下会让界面
         永远停在旧状态（停止按钮一直亮着、审批条永远不出现），所以不挡，但照样计数。
      **铁律：任何携带 messages 的补丁都必须是函数补丁**（set((s) => ...)）——值补丁（预先
          算好的数组）一旦被顺延，flush 时就会用旧快照覆盖期间新增的乐观条目（丢消息 +
          列表整段重渲染）。这条由 tests/check-deferred-clobber.mjs 的源码不变量断言看守。 */
  let deferred: SessionPatch[] = []
  let deferTimer: number | null = null

  /** 把本帧被熔断挡下的补丁合成**一次**提交（顺序保持，函数补丁按当时的状态依次求值）。 */
  const flushDeferred = (): void => {
    if (deferTimer !== null) { window.clearTimeout(deferTimer); deferTimer = null }
    if (!deferred.length) return
    const queued = deferred
    deferred = []
    reportCommit('session', true)
    applyPatch((state) => {
      let patch: Partial<SessionState> = {}
      for (const one of queued) {
        const part = typeof one === 'function' ? one({ ...state, ...patch } as SessionState) : one
        patch = { ...patch, ...part }
      }
      return patch
    })
  }

  const set = (patch: SessionPatch): void => {
    if (reportCommit('session')) { applyPatch(patch); return }
    deferred.push(patch)
    if (deferTimer === null) deferTimer = window.setTimeout(flushDeferred, DEFER_MS)
  }

  const commitCritical = (patch: SessionPatch): void => {
    reportCommit('session', true)
    applyPatch(patch)
  }

  /* ── text_chunk / reasoning_chunk 帧内合并 + 提交节流 ──
     一个长回答会推来几百个 text_chunk，逐个 set() 会让整棵消息树重算几百遍。
     这里把 chunk 攒进缓冲，**每 32ms（≈30fps）提交一次**（窗口与合并规则见 lib/streamCommit）：
     窗口内到达的 chunk 合成一次 set()，窗口过了就并到下一帧提交。四条铁律：
     ① 顺序不能乱 —— 任何非 chunk 事件先同步 flushChunks() 再处理，
        否则 tool_start / turn_end 会插到还没提交的正文前面；
     ② 一轮结束前刷干净 —— turn_end 分支先 flush 再落事件，最后一段文本不会丢；
     ③ 切会话/发新消息时要么 flush（写回原会话缓存）要么 drop（丢弃），绝不串号；
     ④ 节流只压「多久画一次」：缓冲里的 chunk 全部原样提交，一个字都不丢。 */
  let chunkBuf: Record<string, any>[] = []
  /** 缓冲里这一拍的**归属会话**：第一片 chunk 到达时记下，提交时按它写回，中途切会话不会串号。 */
  let chunkSession = ''
  /** 待提交的那一拍：可能是 rAF（窗口已过 → 并到下一帧）也可能是定时器（窗口未到 → 到点提交）。 */
  let chunkTimer: number | null = null
  let chunkTimerIsFrame = false
  /** 上一次真的提交的时刻：32ms 节流窗口的基准。 */
  let lastCommitAt = 0
  /// 本轮正文的非空白字符数（后台完成提醒里的「共 N 字」）。
  let turnChars = 0
  /// 本轮被用户主动停止：这种情况下不该再弹「回复已完成」。
  let turnCanceled = false
  /// 下一次 turn_end 不弹「回复已完成」（「打断并重发」时那条 turn_end 只是取消回执）。
  let suppressTurnEndNotify = false
  /// 草稿落盘防抖：每敲一个字就写 localStorage 会明显掉帧。
  let draftTimer: number | null = null
  let draftPending: { id: string; text: string } = { id: '', text: '' }

  /** 取消还没到点的那一拍（rAF 与定时器只能各自取消，所以两种句柄分开记）。 */
  const cancelChunkTimer = (): void => {
    if (chunkTimer === null) return
    if (chunkTimerIsFrame) window.cancelAnimationFrame(chunkTimer)
    else window.clearTimeout(chunkTimer)
    chunkTimer = null
    chunkTimerIsFrame = false
  }

  /** 流式正文的唯一落点：缓冲里那一拍**就地追加**到 messages（顺序 = 到达顺序，一条不少）。
     缓冲属于哪个会话就写哪个会话：切会话的那一帧里还没提交的正文写回原会话缓存，绝不串号。 */
  const flushChunks = (): void => {
    cancelChunkTimer()
    if (!chunkBuf.length) return
    const sid = chunkSession || get().sessionId
    const buffered = chunkBuf
    chunkBuf = []
    chunkSession = ''
    lastCommitAt = Date.now()
    // 正文提交了就置富文本标记：常规递增版本号（渲染侧会重解析 / 发高亮请求），
    // 精简模式只置标记（渲染侧读 richSignal() 后直接按纯文本画）。
    noteRichCommit()
    if (sid === get().sessionId) {
      set((s) => ({ messages: applyEventsToMessages(s.messages, buffered, streamSeq) }))
    } else {
      const base = messagesBySession.get(sid) ?? []
      messagesBySession.set(sid, applyEventsToMessages(base, buffered, streamSeq))
    }
    streamSeq += buffered.length
  }

  /* ── 看门狗 ──
     见文件顶部常量处的说明：只有「超过 3 秒没有新事件」且「引擎说这个会话没在跑」
     两条硬证据同时成立，才把界面强制复位成完成。 */
  const stopWatchdog = (): void => {
    if (watchdogTimer !== null) { window.clearInterval(watchdogTimer); watchdogTimer = null }
  }

  /** 强制把这一轮收成「已完成」：清掉流式光标与进行中状态。
      turn_end 丢了也照样走一次历史回读——引擎落库的内容不能因为丢了一帧就看不见。 */
  const forceSettleTurn = (readback: boolean, reason = 'unknown'): void => {
    const sid = get().sessionId
    noteSettle(reason)
    // 缓冲里还没提交的正文先落地：这一步丢了就是真的丢字（见文件顶部的三条铁律）。
    flushChunks()
    liveTurnSessions.delete(sid)
    // 收尾必须落地：这一次被挡下，界面就永远停在「进行中」。
    commitCritical({ streaming: false, runState: 'idle', approval: null, question: null })
    if (readback && sid) {
      void get().loadHistory(sid).catch(() => { /* 读不到就保持现状 */ })
    }
  }

  /** 看门狗的一次探测：拿引擎的会话列表当权威值复核这一轮到底还在不在跑。 */
  const settleIfEngineIdle = async (): Promise<void> => {
    const sid = get().sessionId
    if (!sid) return
    // 探测期间用户可能已经发了新一轮：收尾与回读只对**启动时那一轮**生效。
    const seq = currentTurnSeq()
    const state = get()
    if (!state.streaming && state.runState === 'idle' && !state.approval && !state.question) return
    if (Date.now() - lastEventAt < STALL_MS) return
    // **正在执行工具时引擎会忙（HTTP 慢/事件堆积），看门狗绝不判停、绝不判死**：
    // 工具可能跑几分钟（大目录递归、慢命令），30 秒豁免窗口不够 —— 之前「工具跑 5 分钟
    // 引擎就没」就是豁免窗口到期后被看门狗误杀。以引擎自己的 runState 为准：只要还在
    // executing，多久都不判停，探测失败也不累计。
    if (state.runState === 'executing') { engineProbeFailures = 0; return }
    if (Date.now() < toolBusyUntil) return
    try {
      await get().loadSessions()
    } catch {
      // 引擎不可达：可能是①进程崩溃，②进程还在但卡死（CPU 0、端口在听、不答话），
      // ③壳正在重启它。三种情况**都不能一直挂着「进行中」**：以前这里直接 return，
      // 于是引擎一出事界面就永远停在生成中，再切会话就「泛白 + 冻结在上一个页面」。
      // 现在的做法：把这一轮收成「已中断」、把原因写清楚，并请壳去做重启（壳侧现在
      // 也会自己判定卡死并强制重启），引擎恢复后自动重连、可一键继续。
      if (engineProbeFailures >= ENGINE_DEAD_PROBES && Date.now() >= toolBusyUntil && get().runState !== 'executing' && isTurnCurrent(seq) && get().sessionId === sid) {
        resumeAfterRestart = true
        forceSettleTurn(false, 'watchdog:engine-dead')
        // messages 只走函数补丁：预先算好的数组一旦被提交闸门顺延，flush 时会用旧快照
        // 覆盖期间新增的乐观条目 / 流式正文（「我发的消息被吞」+ 列表整段重渲染的根因）。
        set((s) => ({
          linkError: '',
          interrupted: true,
          messages: applyEventsToMessages(s.messages, [{
            event_type: 'agent_error',
            // 不再自动重启：引擎只是忙/慢时会被误判成「无响应」而杀掉（长工具、ffmpeg 等在跑时
            // 尤其容易）。真死了壳守护会重启；这里只提示，用户可手动点「重启引擎」。
            message: '引擎暂时无响应（可能正在执行耗时工具），本轮已中断。请稍候自动重连，或点「重启引擎」；已生成内容可「继续生成」。',
            code: 'engine_gone',
          }], streamSeq++),
        }))
      } else {
        engineProbeFailures += 1
      }
      return
    }
    engineProbeFailures = 0
    if (!isTurnCurrent(seq) || get().sessionId !== sid) return
    if (engineSaysRunning(sid)) return
    if (Date.now() - lastEventAt < STALL_MS) return
    forceSettleTurn(true, 'watchdog:idle')
  }

  /** 起搏看门狗（幂等）：只要界面处在「进行中」就让它每秒醒一次。 */
  const ensureWatchdog = (): void => {
    if (watchdogTimer !== null) return
    watchdogTimer = window.setInterval(() => {
      const state = get()
      if (!state.streaming && state.runState === 'idle' && !state.approval && !state.question) { stopWatchdog(); return }
      if (Date.now() - lastEventAt < STALL_MS) return
      if (Date.now() - watchdogProbeAt < WATCHDOG_PROBE_MS) return
      watchdogProbeAt = Date.now()
      void settleIfEngineIdle()
    }, 1_000)
  }

  /** 排下一拍提交：窗口已过就并到下一帧（同一帧内到达的多个 chunk 依旧只 set 一次）；
      还在窗口里就挂个定时器到点提交 —— rAF 在窗口不可见时几乎不跑，光靠它正文会滞留。
      两条路都不攒内容，只是把提交时刻推到窗口之外（见 lib/streamCommit 的 commitDelay）。 */
  const scheduleFlush = (): void => {
    if (chunkTimer !== null) return
    const at = Date.now()
    // 精简模式把窗口放宽到 100ms（常规 32ms，见 lib/guard 的 commitWindowMs）：
    // 少画几帧换主线程喘口气，正文一个字不丢 —— 合并的仍然是一整段原文。
    const wait = isLean() ? Math.max(0, commitWindowMs() - (at - lastCommitAt)) : commitDelay(at, lastCommitAt)
    if (wait === 0) {
      chunkTimerIsFrame = true
      chunkTimer = window.requestAnimationFrame(() => { chunkTimer = null; chunkTimerIsFrame = false; flushChunks() })
      return
    }
    chunkTimerIsFrame = false
    chunkTimer = window.setTimeout(() => { chunkTimer = null; flushChunks() }, wait)
  }

  /** 丢弃没提交的 chunk：发新消息 / 截断重发时用，防止上一轮残文混进新一轮。 */
  const dropChunks = (): void => {
    cancelChunkTimer()
    chunkBuf = []
    chunkSession = ''
  }

  /* ── 轮次序号：异步回调的作废判据 ──
     send() 每发一轮 +1。任何**异步**回调（turn_end 回读、看门狗收尾、重连复核）在动 messages
     之前都要先问一句「我启动时那一轮还是当前这一轮吗」：不是就一律作废。
     没有这道校验，上一轮的回读会去清/改新一轮刚收到的实时事件 —— 那正是「新消息刚发出去
     就被上一轮的收尾逻辑抹掉」的形态。 */
  const currentTurnSeq = (): number => turnSeq

  /** 手上这一轮还算不算数（seq 由回调启动时捕获）。 */
  const isTurnCurrent = (seq: number): boolean => turnSeq === seq

  const flushDraft = (): void => {
    if (draftTimer !== null) { window.clearTimeout(draftTimer); draftTimer = null }
    if (!draftPending.id) return
    writeDraft(draftPending.id, draftPending.text)
    draftPending = { id: '', text: '' }
  }

  /* ── 模型切换：乐观显示 + 引擎确认 ── */

  /** 读在途切换；超过 TTL 直接作废（引擎要么拒绝过、要么这条连接已经不指望它了）。 */
  const activePending = (): ModelPending | null => {
    const pending = get().modelPending
    if (!pending) return null
    if (Date.now() - pending.at > MODEL_PENDING_TTL_MS) {
      set({ modelPending: null })
      return null
    }
    return pending
  }

  /** 引擎的会话列表（/api/sessions）说这个会话还在跑吗——这是权威值：
      切走后任务在后台继续跑时它仍是 true；已经跑完的一轮它立刻变 false。
      「切回时 streaming 该是什么」见 openSession：引擎值 + 本地「还没收到 turn_end」的标记。 */
  const engineSaysRunning = (id: string): boolean => {
    if (!id) return false
    const row = get().sessions.find((s) => s.id === id)
    // 列表里**没有**这个会话 = 「未知」，不是「没在跑」。
    // 以前这里返回 false，于是「刚发出去、列表还没刷新」的那一轮会被判成已结束，
    // 一条心跳或一次重连就能把正在生成的界面收掉（见 settleLog）。
    if (!row) return true
    return row.running === true
  }

  /** 「引擎真的把这一轮收完了吗」——**所有强制收尾路径共用的唯一判据**。
      三条硬条件缺一不可：
        ① 引擎的会话列表说 running=false（调用方负责先拉一份最新的）；
        ② 当前不是「正在执行工具」（runState === 'executing'）；
        ③ 不在工具豁免窗口内（toolBusyUntil）。
      为什么必须共用：看门狗有 ②③ 的豁免（长工具能跑几分钟，注释在 STALL_MS 上方），
      而心跳与 session_state 两条路以前没有 —— 长工具跑着的时候一条心跳就能把这一轮
      收掉，用户看到的就是「停止键变回发送键、思考中消失」。 */
  const engineReallyIdle = (id: string): boolean => {
    if (!id) return false
    if (get().runState === 'executing') return false
    if (Date.now() < toolBusyUntil) return false
    return !engineSaysRunning(id)
  }

  /** 第一条消息真的发出去了：这条「新建」会话从此算落地。
   *  ① 从「未发名单」里摘掉 —— 下次 /api/sessions 回来它就是一个普通会话了；
   *  ② 本地先补一行摘要（标题＝正文第一行），左侧列表立刻出现它，高亮照旧按 sessionId 比对；
   *  ③ 名单里没有它（老会话 / 已经发过）时什么都不做。
   *  引擎回读列表后会用自己的标题覆盖这一行（rename 过的话尤其重要）。 */
  const publishFirstMessage = (id: string, text: string): void => {
    if (!id) return
    // 名单里记着的（新建未发）就此落地：下面摘掉标记后，下次 /api/sessions 回来它就是普通会话。
    unhideEmptySession(id)
    // 引擎那边这条已经不算空了：列表的「空会话」占位跟着撤掉（见 currentSessionIsEmpty）。
    contentlessSessionIds.delete(id)
    const entry = firstMessageSummary(id, text, get().pendingCwd, Date.now())
    set((s) => (s.sessions.some((x) => x.id === id)
      ? { sessions: s.sessions.map((x) => (x.id === id ? { ...x, empty: false, title: x.title || entry.title, preview: x.preview || entry.preview } : x)) }
      : { sessions: [entry, ...s.sessions] }))
  }

  /** 引擎回填模型显示的唯一入口。
   *  在途切换没确认前，引擎给的旧值一律不写入——这正是「切完闪一下又变回去」的根因；
   *  引擎值等于在途值时视为已落盘，清掉在途标记。 */
  const applyEngineModel = (providerId: unknown, model: unknown): void => {
    const pid = typeof providerId === 'string' ? providerId : ''
    const mdl = typeof model === 'string' ? model : ''
    if (!pid && !mdl) return
    const pending = activePending()
    if (pending) {
      const providerHit = !pid || pid === pending.providerId
      const modelHit = !mdl || mdl === pending.model
      if (providerHit && modelHit) set({ modelPending: null })
      return
    }
    if (pid) set({ currentProviderId: pid })
    if (mdl) set({ currentModel: mdl })
  }

  if (typeof window !== 'undefined') {
    // 关窗 / 隐藏到托盘 / 崩溃前把防抖窗口里的最后几个字写盘，
    // 并把还没提交的正文 flush 掉：rAF 在窗口不可见时会被节流到几乎不跑，
    // 只 flush 草稿不 flush 正文，那一段就留在缓冲里随页面一起没了。
    const settleBeforeHide = (): void => {
      flushDraft()
      flushChunks()
      // 被熔断顺延的补丁也要落定：否则关窗那一拍的最后一次状态变更会随页面一起没。
      flushDeferred()
      // 输入区（草稿 / 引用 / 附件）在关窗 / 切到后台时整体落盘：
      // 引用与附件本来就是改一下就写一次，这里是「一次写全三个桶」的兜底。
      const state = get()
      flushInput(state.sessionId, inputOf(state))
    }
    window.addEventListener('beforeunload', settleBeforeHide)
    window.addEventListener('pagehide', settleBeforeHide)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') settleBeforeHide() })
  }

  /* ── 事件处理 ──
     对话内容的唯一落点：除 chunk 走 32ms 合批外，其余事件**就地**落进 messages
     （applyEventsToMessages），state 只放事件之外的元信息（用量 / 状态 / 提问挂起…）。 */
  /** 真正落一个事件（含引擎补帧重发、按序倾倒出来的那些）。
      顺序由入口 handleEvent 的顺序门保证（见 lib/eventSeq.ts）。 */
  const applyEvent = (ev: Record<string, any>): void => {
    const type = String(ev.event_type ?? '')
    // 看门狗据此判断「3 秒内没有新事件」；lastEventAt 由入口 handleEvent 统一打点。
    ensureWatchdog()
    // 事件轨迹（诊断用环形缓冲，≤400 条）：写进 window.__coomiTrace，供自检/排查直接读取。
    try {
      const ring = ((window as unknown as { __coomiTrace?: unknown[] }).__coomiTrace ??= [])
      if (ring.length > 400) ring.splice(0, ring.length - 400)
      ring.push({
        t: type,
        // es = 引擎的 event_seq（事件对象顶层、与 event_type 同级）；seq 是旧的本地字段，保留兼容。
        es: (ev.event_seq ?? 0) as number,
        seq: (ev.seq ?? 0) as number,
        m: String(ev.content ?? ev.message ?? ev.call_id ?? '').slice(0, 48),
        at: Date.now(),
      })
    } catch { /* 诊断缓冲失败不影响主流程 */ }
    // ① 流式文本：只进缓冲，同一帧内的多个 chunk 合并成一次 state 更新。
    //    这里必须直接 return，落到末尾的逐事件 set 就等于「每个 chunk set 一次」。
    if (type === 'text_chunk' || type === 'reasoning_chunk') {
      // 缓冲里压着的是**别的会话**的正文（切会话的那一帧里又来了一个 chunk）：
      // 先把它写回原会话的缓存，绝不让它被算到当前会话头上（串号就是丢文本的另一种形态）。
      if (chunkBuf.length && chunkSession && chunkSession !== get().sessionId) flushChunks()
      // 上游恢复、正文又来了：把「正在自动恢复」的提示收掉。
      if (!get().streaming || get().retrying) set({ streaming: true, retrying: null })
      if (type === 'text_chunk') {
        turnChars += countChars(ev)
      }
      // 本轮耗时的退化口径打点：第一个 chunk = 首 token，最后一个 = 末 token。
      const at = Date.now()
      if (!turnFirstTokenAt) turnFirstTokenAt = at
      turnLastTokenAt = at
      chunkSession = get().sessionId
      chunkBuf.push(ev)
      scheduleFlush()
      return
    }
    // ② 其它事件立刻处理，但先把缓冲刷干净——顺序比省一次渲染更重要。
    flushChunks()
    if (type === 'usage_update') {
      useEngine.getState().applyUsage(ev)
      const u = (ev.usage ?? {}) as Record<string, any>
      set((st) => ({
        stats: {
          ...st.stats,
          inputTokens: u.input_tokens ?? st.stats.inputTokens,
          outputTokens: u.output_tokens ?? st.stats.outputTokens,
          totalTokens: u.total_tokens ?? st.stats.totalTokens,
          cachedInputTokens: u.cached_input_tokens ?? st.stats.cachedInputTokens,
          cacheHitRate: u.cache_hit_rate ?? st.stats.cacheHitRate,
          firstTokenMsSum: st.stats.firstTokenMsSum + st.pendingFirstTokenMs,
          firstTokenCount: st.stats.firstTokenCount + (st.pendingFirstTokenMs > 0 ? 1 : 0),
        },
        pendingFirstTokenMs: 0,
      }))
      return
    }
    if (type === 'tool_approval_request') {
      // 审批卡是弹窗（答完就关），不是对话流条目：只落状态。
      set({
        runState: 'awaiting_approval',
        approval: {
          callId: String(ev.call_id ?? ''),
          toolName: String(ev.tool_name ?? 'tool'),
          detail: String(ev.risk_summary ?? '') || JSON.stringify(ev.arguments ?? {}).slice(0, 300),
        },
      })
      return
    }
    if (type === 'user_question_request') {
      const callId = String(ev.call_id ?? ev.callId ?? ev.id ?? '')
      // 落卡（对话流里一条 ask 条目）+ 挂起状态，必须同一拍落地。
      const nextMessages = applyEventsToMessages(get().messages, [ev], streamSeq++)
      commitCritical({
        runState: 'awaiting_question',
        question: {
          callId,
          questions: (ev.questions ?? []) as Array<Record<string, any>>,
        },
        messages: nextMessages,
      })
      // 设置里关掉了「允许 AI 向你提问」：本地立刻按跳过收掉，不让整轮对话卡在等人上
      // （卡片照常渲染成「已跳过」，用户看得见发生过什么）。
      if (useCapabilities.getState().caps.askUser === false) {
        set((s) => ({
          question: null,
          runState: 'executing',
          askAnswers: callId ? {
            ...s.askAnswers,
            [callId]: { items: {}, skipped: true, at: Date.now() },
          } : s.askAnswers,
        }))
        if (callId) socket?.send(envelope({ command: 'answer_question', call_id: callId, answers: {} }))
        return
      }
      scheduleAskTimeout(callId)
      return
    }
    if (type === 'turn_end') {
      /* turn_end 幂等：**同一轮**在 1.5 秒内重复到达（引擎的取消路径与正常收尾各发一条、
         或补帧把同一帧重发了一遍）只按**完整流程**处理一次，否则轮次统计 +1 两次、
         完成提醒弹两遍。
         判重依据是 turnIdentity（轮次身份），不再是本地自增的 turnSeq：
         turnSeq 只在 send() 的**正常分支**里 +1，而插话 / 排队分支会提前 return（见 send），
         排队产生的每一轮根本不递增它 —— 两条排队消息在 1.5 秒内相继结束时，第二条 turn_end
         的 endedSeq 与第一条相同，就被误判成重复（轮次少计、完成提醒丢失）。
         turnIdentity 由 markTurnStarted() 在**每一轮真正开始**时递增（正常发送、
         queued_message_started、turn_interrupted、life_delivered 四条路径都调它），
         所以不同轮一定拿到不同的键，而同一轮的重复帧仍然落在同一个键上、照旧去重。 */
      const endedToken = turnIdentity
      const atEnd = Date.now()
      const duplicate = lastTurnEndToken === endedToken && atEnd - lastTurnEndAt < TURN_END_DUP_MS
      lastTurnEndToken = endedToken
      lastTurnEndAt = atEnd
      // 「后面还有排队的插话」：这一帧只是为了让界面收尾这一轮，不能闪一下「已完成」。
      const moreQueued = ev.more_queued === true || ev.queued === true
      // 关键：先把缓冲里的正文提交掉，再落 turn_end —— 否则最后一段文本会被丢掉。
      flushChunks()
      /* 本轮产出：引擎在 turn_end 上带 artifacts 时把它换成渲染用的条目清单。
         规则三条：
          · 认不出来（没有这个字段 / 不是数组 / 条目没有路径）→ 空清单，界面一个占位都不画；
          · 走 load-bearing 的 commitCritical 而不是节流的 set：卡片要在这一轮收尾的那一帧
            就跟着正文一起出现，不能等下一个提交窗口；
          · 幂等帧（duplicate）也照样落一次 —— 它同样是「这一轮的产出」，
            重复帧只是不再累加轮次统计 / 不再弹完成提醒，与产出无关。 */
      const producedArtifacts = parseTurnArtifacts(ev.artifacts ?? ev.artifact_paths ?? ev.outputs)
      commitCritical({ turnArtifacts: producedArtifacts.length ? producedArtifacts : NO_ARTIFACTS })
      const usage = useEngine.getState().usage
      // 本轮耗时只认可信口径（见 lib/chat.ts）：引擎在 turn_end 上给的 > 首 token→末 token 窗口。
      // 再也不用 Date.now() - 发送时刻 —— 那个差值把排队、引擎重启、界面挂起都算了进去。
      const engineMs = turnDurationFromEvent(ev)
      const firstTokenMs = firstTokenFromEvent(ev) ?? validTurnMs(usage.firstTokenLatencyMs)
      const generationMs = engineMs ?? tokenWindowMs(turnFirstTokenAt, turnLastTokenAt)
      turnFirstTokenAt = 0
      turnLastTokenAt = 0
      const endedAt = Date.now()
      const stats = duplicate ? get().stats : (() => {
        // llmMs 累计的是各轮的**生成耗时**（不含排队与重启），口径与消息底部那个数字一致。
        const next = {
          ...get().stats,
          turns: get().stats.turns + 1,
          llmMs: get().stats.llmMs + (generationMs ?? 0),
        }
        if (usage.contextWindow) next.cacheHitRate = usage.cacheHitRate ?? next.cacheHitRate
        saveStats(get().sessionId, next)
        return next
      })()
      // 这一轮结束了：本地标记清掉，之后切回这个会话不再恢复流式光标。
      // 后面还有排队消息时不删——下一轮马上要跑，标记留着切走再切回才接得上。
      if (!moreQueued) liveTurnSessions.delete(get().sessionId)
      // turn_end 就地收尾（当前这条助手消息 streaming=false），用量 / 产物 / 状态一起提交。
      const nextMessages = applyEventsToMessages(get().messages, [ev], streamSeq++)
      commitCritical({
        messages: nextMessages,
        // more_queued：引擎的队列里还有用户插话，下一轮马上开始。
        // 这里绝不能收成 idle —— 否则两条消息之间会闪一下「已完成」。
        streaming: moreQueued,
        runState: moreQueued ? 'thinking' : 'idle',
        approval: null,
        question: null,
        // 这一轮结束了：自动重试的提示一并收掉（它只在「等上游」那段时间有意义）。
        retrying: null,
        interrupted: false,
        pendingFirstTokenMs: firstTokenMs ?? 0,
        stats,
        turnMeta: {
          endedAt,
          // 只作差值基点：保证 endedAt - startedAt 恒等于本轮生成耗时；不可信时给 NaN，
          // fmtDuration 会显示「—」，不会把一次挂起后的巨大差值画出来。
          startedAt: generationMs == null ? Number.NaN : endedAt - generationMs,
          generationMs,
          firstTokenMs,
          model: get().currentModel || '默认模型',
          outputTokensPerSecond: usage.outputTokensPerSecond,
          totalTokens: usage.turnTotal,
        },
      })
      // 窗口不在前台时提醒一句：系统通知优先，未授权 / 不支持则退回应用内 toast。
      // 用户自己按下停止的那一轮不提醒——那不是「回复好了」；
      // 重复帧（幂等）与「后面还有排队消息」也不提醒——都不代表整件事做完了。
      const producedChars = turnChars
      const canceled = turnCanceled
      turnChars = 0
      turnCanceled = false
      const suppressed = suppressTurnEndNotify
      suppressTurnEndNotify = false
      if (!canceled && !duplicate && !moreQueued && !suppressed) {
        notifyTurnDone({
          chars: producedChars,
          sessionTitle: get().sessions.find((x) => x.id === get().sessionId)?.title ?? '',
        })
      }
      void get().loadSessions()
      // 一轮结束后引擎会把 user/assistant/tool 落库，这里回读历史拿到真正的消息 id 与工具明细。
      // 回读走 applyHistoryItems：被历史覆盖的部分换成权威版本，历史还没有的本地尾部原样
      // 保留 —— 任何快照（哪怕比本地旧）都不会把已显示的内容清掉，所以不再需要
      // 「历史是否覆盖本轮」的判定，也就不存在「清早了把最终正文剪掉」的竞态。
      // 回读按 0 / 300ms / 1s / 2.5s 阶梯重试：落库比 turn_end 晚几百毫秒是常态。
      const seqAtEnd = turnSeq
      const sessionAtEnd = get().sessionId
      void (async () => {
        for (const delay of TURN_READBACK_STEPS_MS) {
          if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay))
          // 轮次序号校验：这一轮已经过去（用户又发了一轮 / 切会话后重开）就整段作废 ——
          // 异步回调绝不许碰新一轮的内容。
          if (!isTurnCurrent(seqAtEnd)) return
          // 回读期间已经切走会话：历史不属于这一轮，留着本地内容，切回来还看得到。
          if (get().sessionId !== sessionAtEnd) return
          await get().loadHistory(sessionAtEnd)
          if (!isTurnCurrent(seqAtEnd) || get().sessionId !== sessionAtEnd) return
          return
        }
      })()
      return
    }
    if (type === 'session_state' && typeof ev.running === 'boolean') {
      // 引擎的这个字段是**权威值**（每次连上都会先发一条）：running=false 就说明这一轮
      // 确实已经结束，本地那条「还没收到 turn_end」的标记要跟着清掉，免得留下过期缓存。
      const sid = get().sessionId
      if (ev.running) liveTurnSessions.add(sid)
      else liveTurnSessions.delete(sid)
      if (!ev.running) {
        // 引擎说没在跑 —— 但**绝不单凭这一帧收尾**：连上那一刻正好卡在两轮之间
        // （上一轮 turn_end 与下一轮 worker 抢槽的空隙）是这条路上最常见的误判。
        // 先自己拉一份 /api/sessions 复核，并且必须过 engineReallyIdle 的三条硬条件。
        void get().loadSessions().then(() => {
          if (get().sessionId !== sid) return
          if (!(get().streaming || get().runState !== 'idle' || !!get().approval || !!get().question)) return
          if (Date.now() - lastEventAt < STALL_MS) return
          if (!engineReallyIdle(sid)) return
          forceSettleTurn(true, 'session_state:idle')
        }).catch(() => { /* 引擎不可达：交给看门狗 / 重连流程 */ })
        return
      }
      // 引擎说在跑：把流式状态接回来（断线重连后界面要恢复成「生成中」）。
      set({ streaming: true })
      return
    }
    // 心跳（15 秒一条）：引擎顺便报一次 running，是「这一轮还在不在跑」的权威值。
    // 不进对话流（它不是对话内容），只喂给看门狗当证据。
    if (type === 'connection_heartbeat') {
      // 心跳（15 秒一条）顺便报 running，但它**只能作为触发复核的信号，不能直接收尾**：
      // 以前这里查的是本地缓存的 sessions，而 send() 之后从不刷新它 —— 本地那份还停在本轮
      // 开始之前（running=false），于是一个跑了 10 秒的本地长命令会被一条心跳收掉。
      if (ev.running !== true) {
        void get().loadSessions().then(() => {
          const sid = get().sessionId
          if (!sid) return
          if (!(get().streaming || get().runState !== 'idle' || !!get().approval || !!get().question)) return
          if (Date.now() - lastEventAt < STALL_MS) return
          if (!engineReallyIdle(sid)) return
          forceSettleTurn(true, 'heartbeat:idle')
        }).catch(() => { /* 引擎不可达：交给看门狗 */ })
      }
      return
    }
    /* 本轮被中断（上游不可用 / 工具轮次用尽）：引擎发 retry_confirmation。
       以前这里没有分支 —— 事件被丢掉，对话流里一个字都没有，用户只看到「做一半停了」。
       现在：落进对话流（chat.ts 里渲成可操作的卡）+ 标记本轮被中断 + 停掉「正在自动恢复」。 */
    if (type === 'retry_confirmation') {
      commitCritical({
        messages: applyEventsToMessages(get().messages, [ev], streamSeq++),
        interrupted: true,
        retrying: null,
      })
      return
    }
    /* 上游抖动、引擎在自动重试：engine/src/agent.rs 的 ConnectionRetry —— 会连着退避几十秒，
       期间没有任何内容产出，界面必须说一句「正在自动恢复（第 N/M 次）」，否则就是干等。 */
    if (type === 'connection_retry') {
      const attempt = Number(ev.attempt ?? 1)
      const max = Number(ev.max_attempts ?? 1)
      const delayMs = Number(ev.delay_ms ?? 0)
      set({ retrying: { attempt, max, delayMs, at: Date.now() } })
      return
    }
    // 运行中插话：引擎把这条消息排进队列了（界面上的乐观条目已经是「排队中」，
    // 这里只保证标记，不再重复插入一条）。
    if (type === 'message_queued') {
      set((s) => ({ messages: applyEventsToMessages(s.messages, [ev], streamSeq++) }))
      return
    }
    // 排队的那条开始执行了：摘掉它头上的「排队中」标记。
    if (type === 'queued_message_started') {
      // 这是**新一轮真正开始**：先给它一个轮次身份，后面这条 turn_end 才不会被误判成
      // 上一条 turn_end 的重复帧（两条排队消息在 1.5 秒内相继结束时就是这个形态）。
      markTurnStarted()
      set((s) => ({
        messages: applyEventsToMessages(s.messages, [ev], streamSeq++),
        streaming: true,
        runState: 'thinking',
      }))
      return
    }
    // 引擎清空了队列（用户点了停止）：把「排队中」的标记全摘掉。
    if (type === 'queue_cleared') {
      const removed = Number(ev.removed ?? 0)
      set((s) => ({ messages: applyEventsToMessages(s.messages, [ev], streamSeq++) }))
      if (removed > 0) toast.message('已停止：' + removed + ' 条排队消息未执行')
      return
    }
    if (type === 'turn_interrupted') {
      // 「打断并重发」：引擎先取消当前轮再发起新一轮，已生成内容留在草稿里。
      // 打断本身会补一条「取消回执」turn_end，紧接着才是新一轮：先换一个轮次身份，
      // 否则新一轮的 turn_end 会被当成那条回执的重复帧吞掉。
      markTurnStarted()
      set((s) => ({
        messages: applyEventsToMessages(s.messages, [ev], streamSeq++),
        streaming: true,
        runState: 'thinking',
        interrupted: false,
      }))
      return
    }
    if (type === 'agent_cancelled') {
      // 取消路径一定会补一条 turn_end（引擎侧保证），这里只做状态兜底。
      set({ interrupted: true })
      return
    }
    // 引擎主动送达的「生活」回合（life_delivered + 它自己的 turn_end）也是一轮：
    // 先占一个轮次身份，免得它和上一条 turn_end 挤在同一个键上（1.5 秒内）被误判成重复。
    if (type === 'life_delivered') { markTurnStarted(); return }
    if (type === 'tool_start') {
      set(get().retrying ? { runState: 'executing', retrying: null } : { runState: 'executing' })
      toolBusyUntil = Date.now() + 30_000
    }
    if (type === 'tool_running') toolBusyUntil = Date.now() + 30_000
    if (type === 'tool_done') { toolBusyUntil = Date.now() + 5_000 /* 工具刚结束，再留 5 秒余量 */ }
    if (type === 'tool_done') {
      const elapsed = typeof ev.elapsed === 'number' ? Math.round(ev.elapsed * 1000) : 0
      set((st) => ({ stats: { ...st.stats, steps: st.stats.steps + 1, toolMs: st.stats.toolMs + elapsed } }))
    }
    // 工具事件就地写进当前这条助手消息的 tools / segments（不产生新条目）。
    if (type === 'tool_start' || type === 'tool_running' || type === 'tool_done' || type === 'tool_cache_hit') {
      set((s) => ({ messages: applyEventsToMessages(s.messages, [ev], streamSeq++) }))
    }
  }

  /** 事件入口：先过 event_seq 顺序门，再按序落（见 lib/eventSeq.ts 与文件上方的状态说明）。
      · 有 event_seq：缺口帧会被暂存并请求引擎补帧，补回来的帧按序一起放行；
        重发 / 重放的旧帧（seq ≤ 已按序处理到的 last）直接丢，保证同一条不会画两个气泡；
      · 没有 event_seq（老引擎 / 走 send_event 的兼容帧）：按老逻辑直接处理，不报错。 */
  const handleEvent = (ev: Record<string, any>): void => {
    // 任何到达的事件都算「引擎还活着」：重复帧 / 缺口帧也一样证明链路是通的。
    lastEventAt = Date.now()
    const seq = readEventSeq(ev)
    if (seq === null) {
      applyEvent(ev)
      return
    }
    if (firstEventOnConnection) {
      firstEventOnConnection = false
      // 新连接的第一帧比本地记录还小：多半是引擎重启（SessionTask 的 event_seq 从 1 重来），
      // 旧的门继续用会把这一轮所有帧当成重复帧丢掉 —— 按新基线复位。
      if (seq < seqGate.last()) seqGate.reset()
    }
    const outcome = seqGate.push(seq, ev)
    if (outcome.duplicate) return
    if (outcome.gap) { requestResync(); return }
    for (const ready of outcome.ready) applyEvent(ready)
    noteSeqAck(outcome.ready.length)
  }

  const connect = (): void => {
    const { sessionId } = get()
    const engine = useEngine.getState()
    if (!sessionId || !engine.ready) {
      // 可观测：以前这里静默 return，「还没有会话」被界面误报成「与引擎的连接已断开」，
      // 真机上排查时看不出差别（linkError 是空的，而断线一定会写它）。
      if (!sessionId) console.warn('[session] connect 跳过：还没有建立会话（等启动引导建一个）')
      return
    }
    if (socket) {
      // 先摘掉回调再关：否则旧连接的 onclose 会晚一步把新连接的状态改回“已断开”。
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      try { socket.close() } catch { /* 忽略 */ }
    }
    // 自动重连：断线后按 0.5s→1→2→4→8s 退避重试，最多 6 次；
    // 以前断线就静默失效，用户点了发送毫无反应。
    if (reconnectTimer) { window.clearTimeout(reconnectTimer); reconnectTimer = null }
    const generation = ++socketGeneration
    commitCritical({ connecting: true })
    // 传输兜底：直连 WebSocket 打不通（系统代理 / 新版 Chromium 的本地网络访问检查 /
    // 安全软件拦 msedgewebview2.exe）时，4 秒内自动改用壳里的 WS 桥，用户无感。
    // 见 lib/engineSocket.ts 顶部说明。
    const ws = createEngineSocket({
      url: engine.wsUrl(sessionId),
      sessionId,
      port: engine.port,
      token: engine.token,
    })
    socket = ws
    const isCurrent = (): boolean => generation === socketGeneration
    ws.onopen = () => {
      if (!isCurrent()) return
      reconnectAttempt = 0
      /* 新连接（含壳内桥重连）：last 跨重连保留，正好用它请引擎把断线期间漏掉的帧补回来；
         只有换会话 / 引擎重启才会复位（resetEventStream）。首帧还要用来识别「引擎重启后
         event_seq 从 1 重新计数」，见 handleEvent。last=0（首连 / 刚换会话）时 requestResync 内部直接跳过。 */
      firstEventOnConnection = true
      requestResync(true)
      commitCritical({ linkError: '', connecting: false, connected: true })
      // 多会话并行：让所有会话的 running（左侧列表的呼吸点 / 任务页签）保持新鲜。
      startSessionsPoll()
      // 引擎按「连接」保存这两个偏好，新连接必须重新下发，
      // 否则界面上选了「高」但实际还是默认值。
      void import('./agent').then(({ useAgent }) => {
        const { effort, permission } = useAgent.getState()
        ws.send(envelope({ command: 'set_reasoning_effort', effort }))
        ws.send(envelope({ command: 'set_permission_mode', mode: permission }))
      })
      // 重连后按引擎的权威状态刷新一次：断线时丢掉的那条 turn_end 不会自己回来，
      // /api/sessions 的 running 才是「这一轮到底还在不在跑」的真值。
      // 引擎说没在跑、而界面还挂着进行中（且 3 秒内没有新事件）→ 直接收成完成。
      const openSeq = currentTurnSeq()
      void get().loadSessions().then(() => {
        if (!isCurrent() || get().sessionId !== sessionId) return
        if (!isTurnCurrent(openSeq)) return
        if (engineSaysRunning(sessionId)) return
        if (Date.now() - lastEventAt < STALL_MS) return
        if (get().streaming || get().runState !== 'idle' || get().approval || get().question) forceSettleTurn(true, 'reconnect:idle')
      }).catch(() => { /* 引擎还没起来：交给就绪后的恢复流程 */ })
    }
    ws.onclose = () => {
      if (!isCurrent()) return
      // 断线：界面上不能继续挂「进行中」（连接都没了，什么也收不到），
      // 缓冲里已经收到的正文先落地，一行都不能丢。
      flushChunks()
      stopWatchdog()
      // 断线不发 ack（发了也没人收），兜底定时器一起停；last 留着给重连后的 resync 用。
      stopSeqAckTimer()
      commitCritical({ connected: false, streaming: false, connecting: false })
      scheduleReconnect()
    }
    ws.onerror = () => { if (!isCurrent()) return; commitCritical({ connected: false, connecting: false, linkError: '连接异常，正在重连…' }) }
    ws.onmessage = (e) => {
      if (!isCurrent()) return
      try {
        const frame = JSON.parse(e.data) as { id?: string; type?: string; payload?: Record<string, any> }
        // 引擎事件/应答都在 payload 里，不解包的话 event_type 永远是 undefined，
        // 界面就会「收不到任何回复」。
        const payload = frame.payload ?? (frame as Record<string, any>)
        if (frame.type === 'error') {
          const message = String(payload.message ?? '引擎返回错误')
          // 切换模型的失败要认领到具体那一次请求：引擎凭据校验没过时只回 error 帧、
          // 不落盘（web/mod.rs 的 select_model），所以这里回滚显示 + 提示一句，
          // 而不是往对话里塞一条 agent_error（那会让人以为「这轮对话出错了」）。
          const pending = get().modelPending
          const isModelSwitch = !!frame.id && (modelRequestIds.has(frame.id) || pending?.requestId === frame.id)
          if (isModelSwitch) {
            if (frame.id) modelRequestIds.delete(frame.id)
            toast.error('切换模型失败：' + message)
            if (pending && frame.id === pending.requestId) {
              const rollback: Partial<SessionState> = { modelPending: null }
              if (pending.prevProviderId) rollback.currentProviderId = pending.prevProviderId
              if (pending.prevModel) rollback.currentModel = pending.prevModel
              commitCritical(rollback)
              // 切换前没记录过显示值（例如刚启动）：回读一次让引擎填真值。
              if (!pending.prevModel) void get().loadSessions().catch(() => { /* 引擎稍后会回填 */ })
            }
            // 失败的那次切换不进对话流水：它跟这一轮对话的成败无关。
            return
          }
          // **命令级错误绝不收尾这一轮**（2026-09-28 真机事故根因之一）：
          // 引擎对任何命令失败都回 error 帧 —— 连接后前端自动下发的 set_reasoning_effort /
          // set_permission_mode、模型回读都算。以前这里无条件把 streaming/runState 收成
          // idle，表现就是「任务还在跑，停止键突然变回发送键、右下角思考中消失」。
          // 只有本轮确实跑不下去的错误（没配模型之类）才走 agent_error 收尾。
          const fatal = payload.code === 'no_provider' || payload.code === 'no_model'
          if (!fatal) {
            set({ linkError: message })
            toast.error('引擎返回错误：' + message)
            return
          }
          const nextMessages = applyEventsToMessages(get().messages, [
            { event_type: 'agent_error', message, code: payload.code },
          ], streamSeq++)
          noteSettle('error-frame:' + String(payload.code ?? ''))
          commitCritical({ messages: nextMessages, streaming: false, runState: 'idle' })
          return
        }
        if (frame.type === 'ack') {
          // select_model 成功时引擎在**落盘之后**回 ack：这条切换到此确认，
          // 之后引擎回填的就是新值了。
          if (frame.id) modelRequestIds.delete(frame.id)
          const pending = get().modelPending
          if (pending && frame.id === pending.requestId) set({ modelPending: null })
          return
        }
        handleEvent(payload)
      } catch { /* 忽略坏帧 */ }
    }
  }

  const scheduleReconnect = (): void => {
    // 没有会话（还没打开过）就不必重连。
    if (!get().sessionId) return
    // **重连永不放弃**：以前 6 次用尽就 return —— 那一停，界面就永远停在「与引擎的连接已断开」，
    // 用户点「重启引擎」把引擎拉起来后前端也不会自己接上（这正是那轮 bug 的根因）。
    // 现在：前 6 次指数退避（快），之后每 5 秒慢重试一次，直到连上为止；
    // 同时**绝不自动重启引擎**（忙≠死；真死由壳守护拉起），只提示等待。
    const exhausted = reconnectAttempt >= 6
    const delay = exhausted ? 5_000 : 500 * Math.pow(2, reconnectAttempt)
    if (exhausted) {
      if (get().streaming || get().runState !== 'idle') resumeAfterRestart = true
      // 带上端口与底层原因：不然用户只能看到一句「连接已断开」，无从判断是引擎没起来、
      // 端口不对，还是系统拦截了本地回环（后两者在新版 WebView2 / 安全软件下都出现过）。
      const port = useEngine.getState().port
      set({
        linkError: port
          ? '与引擎的连接已断开（端口 ' + port + '）· 正在每 5 秒自动重试，也可手动点「重连」'
          : '还没拿到引擎端口 · 正在重试；若一直如此，请在托盘看引擎状态或重启应用',
      })
    }
    reconnectAttempt += 1
    if (reconnectTimer) window.clearTimeout(reconnectTimer)
    // 重连前**先刷新端口/令牌**：引擎重启会换端口，用旧端口重试一万次也连不上
    // （这正是「重启后一直显示连接已断开」的根因）。
    reconnectTimer = window.setTimeout(() => {
      if (!get().sessionId) return
      void useEngine.getState().refreshInfo().finally(() => { if (get().sessionId) connect() })
    }, delay)
  }

  const writeCwd = async (id: string, dir: string): Promise<void> => {
    const engine = useEngine.getState()
    await engine.api('/api/sessions/' + id + '/cwd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: dir }),
    })
  }

  /** 等 WS 真的连上：引擎刚起来时握手要几百毫秒，直接 send 会静默失败。最多等 10s。 */
  const waitConnected = async (): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      if (get().connected) return true
      await new Promise((r) => setTimeout(r, 250))
    }
    return get().connected
  }

  /* ── 引擎就绪后自动补连 / 重启后恢复会话 ── */
  useEngine.subscribe((state, prev) => {
    if (!state.ready || prev.ready) return
    reconnectAttempt = 0
    const id = get().sessionId
    if (!id) { resumeAfterRestart = false; return }
    // prev.restarting：这次 ready 是从「重启中」恢复过来的，而不是冷启动第一次就绪。
    const afterRestart = prev.restarting || state.restarting
    // 崩溃时还压在跑的那一轮（thinking / executing / 等审批）＝没跑完，恢复后要提示继续。
    const unfinished = resumeAfterRestart || get().streaming || get().runState !== 'idle'
    resumeAfterRestart = false
    if (afterRestart) {
      // 引擎是新进程：SessionTask 重建、event_seq 从 1 重新计数，旧门必须复位，
      // 否则新一轮的帧会因为「seq ≤ last」被当成重复帧丢掉。
      resetEventStream()
      if (unfinished) {
        set({
          crashInterrupted: true,
          resuming: true,
          streaming: false,
          runState: 'idle',
          approval: null,
          question: null,
        })
      } else {
        set({ resuming: true })
      }
    }
    connect()
    if (!afterRestart) return
    // 重新打开当前会话：回读历史（引擎重启后是全新进程），完成前界面显示「正在恢复会话」。
    void (async () => {
      await get().loadHistory(id)
      if (get().sessionId !== id) return
      set({ resuming: false })
      // 「自动继续」档：连接可用后直接接着跑；默认「一键继续」只提示，等用户点。
      if (!unfinished || useUi.getState().prefs.crashRecovery !== 'auto') return
      if (!await waitConnected()) return
      if (get().sessionId !== id || !get().crashInterrupted) return
      get().resumeInterruptedTurn()
    })()
  })

  return {
    sessionId: '',
    sessions: [],
    messages: [],
    streaming: false,
    connected: false,
    runState: 'idle',
    approval: null,
    question: null,
    askAnswers: {},
    interrupted: false,
    retrying: null,
    historyLoaded: {},
    crashInterrupted: false,
    resuming: false,
    turnArtifacts: NO_ARTIFACTS,

    setInterrupted: (v) => set({ interrupted: v }),

    resumeInterruptedTurn: () => {
      if (!get().sessionId) return
      set({ crashInterrupted: false, resuming: false })
      get().send('继续')
    },

    dismissCrashInterrupted: () => set({ crashInterrupted: false }),
    stats: { ...EMPTY_STATS },
    pendingFirstTokenMs: 0,
    currentModel: '',
    currentProviderId: '',
    modelPending: null,

    resetStats: () => set({ stats: { ...EMPTY_STATS } }),
    turnMeta: null,
    draft: '',

    setModel: (label, providerId) => set(providerId ? { currentModel: label, currentProviderId: providerId } : { currentModel: label }),
    pendingCwd: readCwd(),

    loadSessions: async () => {
      const data = await useEngine.getState().api<{ sessions?: SessionSummary[] }>('/api/sessions')
      const sessions = data.sessions ?? []
      // 引擎的会话列表是权威：上次在列表里、这次不在了 = 被删了，把它的输入区桶一起清掉。
      // 对账一律用**原始**列表：可见性过滤只是界面的事，不影响「哪些会话真的没了」的判定。
      forgetMissingSessions(sessions, get().sessionId)
      // 引擎原始列表里「没有任何内容」的那些（title / preview 都空）：老版本留下的空记录就混在其中。
      // 这份集合只用于回答「当前会话是不是空会话」（列表要给它一行灰色占位，见 currentSessionIsEmpty）；
      // 列表本身的可见性判据在下一步，直接落在同一条纯函数上。
      contentlessSessionIds = new Set(sessions.filter((s) => s.id && !hasSessionContent(s)).map((s) => s.id))
      // 空会话不进列表：引擎那边「点新建就先落一条空记录」、「老版本留下的空记录一直挂着」，
      // 显示出来只会是一行「未命名对话」，点进去还是空的（规则见 lib/emptySession.ts 顶部）。
      // ① 标题与摘要都没有的一律挡掉 —— 老版本遗留的那些靠这一条，不再依赖本地名单；
      // ② 本地名单（新建未发）里已经发过消息的（引擎给了 title / preview）由这里自愈放出来。
      const { visible, healed } = splitHiddenSessions(sessions, hiddenEmptySessions)
      if (healed.length) {
        for (const id of healed) hiddenEmptySessions.delete(id)
        writeHiddenEmptySessions(bucketStore, hiddenEmptySessions)
      }
      // 本地已经记着标题 / 摘要的行（典型：第一条消息刚发出去，引擎那边还没把它落库）：
      // 引擎这一拍说它「没有内容」不算数，用本地那一行顶上 —— 否则新会话那一行会被紧随其后的
      // 一次列表刷新抹掉（「第一条消息发出后立刻出现」是既有行为，不能被这条新判据打回去）。
      // 引擎落库之后它自己就带内容了，这里自然不再需要兜底（自愈，不积攒状态）。
      const localTitled = new Map<string, SessionSummary>()
      for (const one of get().sessions) if (one.id && (one.title || one.preview)) localTitled.set(one.id, one)
      const lagging = sessions.filter((one) => !visible.includes(one) && localTitled.has(one.id))
      set(() => ({
        // 快照算出来的数组一律函数补丁：被闸门顺延后 flush 会用旧快照覆盖新的列表。
        sessions: lagging.length
          ? [...visible, ...lagging.map((one) => localTitled.get(one.id) as SessionSummary)]
          : visible,
      }))
      // 模型名以引擎为准：切换/重开会话后立刻回填，不依赖后续事件。
      // 但在途的模型切换没确认前，引擎这里给的还是旧值，不能覆盖（否则就是切完闪回旧模型）。
      // 会话被过滤掉（＝新建未发）时也要照样回填：模型显示跟列表可见性是两件事。
      const current = sessions.find((s) => s.id === get().sessionId)
      if (current) applyEngineModel(current.provider_id, current.model)
    },

    loadHistory: async (id, options) => {
      // 无论成败都要把「已加载」标上：否则界面会永远停在骨架 / 半透明态。
      const settle = (): void => set((s) => ({ historyLoaded: { ...s.historyLoaded, [id]: true } }))
      try {
        const data = await useEngine.getState().api<{ messages?: Array<Record<string, any>> }>('/api/sessions/' + id)
        // 异步回读期间用户可能已经切走：进度落后的响应绝不能覆盖当前会话。
        if (get().sessionId !== id) return
        // 回读回来的用户消息按本地索引补上附件 / 引用（引擎已经返回这两个字段时以引擎为准）：
        // 卡片不该因为「引擎还没把它们落库」或者「换了一次页面」就消失。
        const decorated = decorateHistory(id, data.messages ?? [])
        const incoming = itemsFromHistory(decorated)
        // 单一份消息数组：被历史覆盖的部分**整体换成历史的版本**（引擎是权威），
        // 历史还没有的本地尾部（刚发出去的乐观条目 / 还在流式的回复）原样保留。
        // options.replace 只给「引擎侧真的删过内容」的路径用（截断重发 / 重新生成）。
        // 合并基座：**取本会话「最新/更长」的那一份**。
        //  · 当前就在这个会话 → get().messages 是活的（刚发的用户消息在这里）；
        //  · 已经切走 → messagesBySession 里是切走那一刻的快照。
        // 以前固定优先用缓存：缓存比当前 messages 旧时，会把「刚发出去那条」漏掉 →
        // 回读后又没覆盖它 → 用户消息从界面上消失（这就是「我发的消息没了」）。
        // **并集**（只增不减）：把「当前 messages」与「切走那一刻的快照」按 id/正文去重后合并 ——
        // 之前用「更长的那一份」当基座，缓存整体更长但缺最新一条时，最新那条（刚发的用户消息）
        // 就被甩掉，随后历史还没落库 → 界面上直接消失。并集从结构上不可能丢条目。
        const liveBase = get().sessionId === id ? get().messages : []
        const cachedBase = messagesBySession.get(id) ?? []
        const seen = new Set<string>()
        const keyOf = (item: ChatItem): string =>
          item.kind === 'user'
            ? 'u:' + item.text.trim()
            : item.kind === 'assistant'
              ? 'a:' + (item.msgId ?? item.id) + ':' + item.text.length
              : item.kind + ':' + item.id
        const base: ChatItem[] = []
        for (const item of [...liveBase, ...cachedBase]) {
          const key = keyOf(item)
          if (seen.has(key)) continue
          seen.add(key)
          base.push(item)
        }
        let next = options?.replace ? incoming : applyHistoryItems(base, incoming)
        // 引擎已落库那一轮的本地流式助手副本先剔掉：下面「列表永不缩短」的兜底是按 base 比对的，
        // 不先作废就会把它们当成「被丢掉的条目」又补回来 —— 两条回复 / 乱码回复就是这么活下来的。
        const prunedBase = dropPersistedAssistantCopies(base, incoming)
        // **硬保险**：无论走哪条路径，本地这份会话里「历史尚未覆盖」的用户消息一律补回尾部 ——
        // 用户看到「我发的消息没了」就是这里丢的（引擎落库比界面慢一拍）。
        // **总保险：列表永不缩短**（除非显式 truncate 的 replace 路径）。
        // 引擎压缩后回读会返回很短的一份；合并规则任何一处判断偏差都会让已显示的内容消失。
        // 这里做最后一道闸：合并结果比合并前短，就把缺的条目按原顺序补回来。
        if (!options?.replace) {
          const have = new Set(next.map((it) => it.kind + '|' + it.id))
          const missing = prunedBase.filter((it) => !have.has(it.kind + '|' + it.id))
          if (missing.length && next.length < prunedBase.length) next = [...next, ...missing]
        }
        if (base.length) {
          // 历史里已出现的用户正文（按内容比对；引擎落库后内容一致）
          const histUserTexts = new Set(
            incoming.filter((it) => it.kind === 'user').map((it) => (it.kind === 'user' ? it.text.trim() : '')),
          )
          const nextUserTexts = new Set(
            next.filter((it) => it.kind === 'user').map((it) => (it.kind === 'user' ? it.text.trim() : '')),
          )
          const missingUsers = prunedBase.filter(
            (it): it is Extract<ChatItem, { kind: 'user' }> =>
              it.kind === 'user' && !histUserTexts.has(it.text.trim()) && !nextUserTexts.has(it.text.trim()),
          )
          if (missingUsers.length) next = [...next, ...missingUsers]
        }
        // 回读后收拾「同一条回复画两遍」（实时流式版 vs 引擎落库版），见 collapseAssistantCopies。
        next = collapseAssistantCopies(next)
        set((s) => ({
          messages: journaledSwap(s.messages, next, 'readback', { base: base.length, incoming: incoming.length }),
          historyLoaded: { ...s.historyLoaded, [id]: true },
        }))
        // 会话里的厂商/模型是权威值，顺手对齐（切模型后显示不更新的根因之一）。
        const conversation = data as unknown as Record<string, any>
        const provider = typeof conversation.provider_id === 'string' ? conversation.provider_id : ''
        const model = typeof conversation.model === 'string' ? conversation.model : ''
        applyEngineModel(provider, model)
      } catch {
        // 回读失败**一律不清空已有内容**：一次失败就是「刚发的一问一答全没了」的根因。
        // messages 里有什么就留什么；只有「真的没加载完」的会话才停在骨架态。
        settle()
      }
    },

    openSession: async (id) => {
      if (id === get().sessionId && get().connected) return
      // **同一个会话的「重开」**（断线重连 / 引擎重启后回来）：绝不动 messages ——
      // 那只是把连接接回来，不是换会话。以前这里会用「该会话的缓存」重置 messages，
      // 而没切走过的会话缓存是空的 → 整段对话在 turn_end 那一刻凭空消失。
      const sameSession = id === get().sessionId
      // 换会话＝换一个引擎任务（event_seq 的坐标系变了）：顺序门 / ack 记账 / turn_end 判重身份一起复位。
      // 同一个会话的「重开」（断线重连）**不**复位 —— last 要留着给重连后的 resync 用。
      if (!sameSession) resetEventStream()
      // 切走之前把两件易丢的东西落定：未提交的正文写回原会话缓存，草稿写盘。
      flushChunks()
      flushDraft()
      // 输入区（草稿 / 引用 / 附件）属于会话：先把当前会话的这一份整体落盘，
      // 再把目标会话的那一份读出来——不这么做，A 里加的附件与引用会跟着到 B 去。
      // 草稿另有 350ms 防抖，所以这里的 flush 在切会话时是必须的；引用与附件是改一下就写一次，
      // 这一句对它们是幂等兜底。
      const leaving = get()
      flushInput(leaving.sessionId, inputOf(leaving))
      // 新建后**没发过消息**就切走：这条空会话就此丢弃 —— 名单不动，它不会以「未命名对话」
      // 的样子回到列表；草稿桶一个字都不动，按同一个 id 还能恢复。
      if (leaving.sessionId && leaving.sessionId !== id && hiddenEmptySessions.has(leaving.sessionId)) {
        dropSessionMemo(leaving.sessionId)
      }
      // 缓存当前会话的消息：切走再切回时，历史里还没有的本地尾部（乐观条目 / 还在流式的
      // 回复）就靠它兜住 —— 绝不因为「切走一次」丢掉已经显示出来的内容。
      if (leaving.sessionId) messagesBySession.set(leaving.sessionId, leaving.messages)
      rememberLastSession(id)
      // 引擎就绪与「打开某个会话」之间有一小段空窗（sessionId 还是空串），
      // 那时用户可能已经开始打字 / 加附件了——这段输入没有归属会话，要带着走，不能丢。
      const unowned = leaving.sessionId ? null : inputOf(leaving)
      const nextInput = adoptUnownedInput(id, unowned, loadInputOf(id))
      // 先同步置“连接中”，避免中间出现一帧 connected=false && connecting=false 让横幅闪一下。
      commitCritical({ connecting: true })
      get().disconnect()
      // 目标会话：先取它的缓存（可能是切走时还在跑的那一轮，历史还没落库的尾巴在里面），
      // 历史回读会按 id 把已覆盖的部分换成权威版本。
      const cached = messagesBySession.get(id) ?? []
      // 只有「还在跑」的会话才恢复流式光标：引擎的 running（权威值）或本地
      // 「这一轮还没收到 turn_end」的标记。已经结束的一轮一律是 false。
      const running = engineSaysRunning(id) || liveTurnSessions.has(id)
      // 切会话必须换统计：否则新页面会显示上一个会话的用量（之前的 bug）。
      set((s) => ({
        sessionId: id,
        // 同一会话：原样保留已有消息（只有换会话才用缓存）。
        messages: sameSession ? s.messages : journaledSwap(s.messages, cached, 'open', { id: id.slice(0, 8) }),
        // 切到非运行中的会话时 streaming 必须立刻是 false：留着上一个会话的 true
        // 会让新进来的消息挂上「正在生成」的光标与点阵。
        streaming: running,
        // 关键：这里**不再**把 messages 同步清空。
        // 目标会话的缓存 / 上一个会话的内容保留到新历史回来（界面按 historyLoaded 降透明度渲染），
        // 加载完成前一律渲染骨架——原来清空 + 空态就是「进历史会话先闪一下新对话」的根因。
        // 同一个会话重新打开（例如断线后点回自己）时保留「已加载」，
        // 免得明明是同一个会话还闪一下骨架；换会话才置 false。
        historyLoaded: { ...s.historyLoaded, [id]: s.sessionId === id ? s.historyLoaded[id] === true : false },
        // 输入区按会话：草稿、引用、附件都换成目标会话的那一份（没有桶就是空）。
        draft: nextInput.draft,
        quotes: nextInput.quotes,
        attachments: nextInput.attachments,
        runState: 'idle',
        // 上一个会话挂着的那一问跟着会话走：计时器一起停掉，否则它会在新会话里误收一张卡。
        question: null,
        // 本轮产出同样属于会话：切走就清掉，绝不让上一个会话的产物卡片跟到新会话里
        // （清成那个共享常量，而不是每次一个新数组）。
        turnArtifacts: NO_ARTIFACTS,
        // 提问卡的回答同样是会话级的：切走就清，绝不让上一个会话的问答跟到新会话里。
        askAnswers: {},
        // 在途的模型切换属于上一个会话，切走就作废：否则它会挡住新会话的引擎回填。
        modelPending: null,
        stats: loadStats(id),
        pendingFirstTokenMs: 0,
        turnMeta: null,
        interrupted: false,
        crashInterrupted: false,
        resuming: false,
      }))
      // 上一轮的打点属于上一个会话，切走即作废（引擎那边这一轮也停了）。
      turnFirstTokenAt = 0
      turnLastTokenAt = 0
      // 提问的等待计时同样属于会话：切走就停，别在新会话里凭空收掉一张卡。
      clearAskTimeout()
      // 切到一个正在跑的会话：起搏看门狗（不能永远挂着进行中）。
      if (running) { lastEventAt = Date.now(); ensureWatchdog() } else stopWatchdog()
      await get().loadHistory(id)
      connect()
      // 顺手刷新一次会话列表：running 是「切回时要不要恢复流式光标」的判据之一，
      // 让它跟上引擎的当前状态（失败时保持现有列表，不影响已渲染的内容）。
      // 回来后按引擎的权威值复核一次：引擎说这一轮早就结束了，
      // 就清掉本地那份过期的「还没收到 turn_end」标记并把 streaming 收成 false
      // （切回非运行会话不得还挂着流式光标；标记不清则下次切回还会错挂光标）。
      void get().loadSessions().then(() => {
        if (get().sessionId !== id) return
        if (engineSaysRunning(id) || liveTurnSessions.has(id)) return
        liveTurnSessions.delete(id)
        if (get().streaming) set({ streaming: false })
      }).catch(() => { /* 引擎未就绪时忽略 */ })
    },

    newSession: async (restoredId) => {
      flushChunks()
      flushDraft()
      // 与 openSession 同一条规则：先 flush 当前会话的输入区，再取目标会话的那一份。
      // 全新 uuid 没有桶 → 空输入区（新会话必须是干净的）；按 restoredId 恢复时读回它自己的桶。
      const leaving = get()
      flushInput(leaving.sessionId, inputOf(leaving))
      if (leaving.sessionId) messagesBySession.set(leaving.sessionId, leaving.messages)
      const unowned = leaving.sessionId ? null : inputOf(leaving)
      const nextInput = adoptUnownedInput(restoredId || '', unowned, restoredId ? loadInputOf(restoredId) : { draft: '', quotes: [], attachments: [] })
      commitCritical({ connecting: true })
      get().disconnect()
      // 换会话：event_seq 顺序门 / ack 记账复位（与 openSession 同一条规则）。
      resetEventStream()
      // 引擎接受客户端指定的会话 id（ws/session/{id} 不存在时会建一个空任务），
      // 所以「还没落库的新会话」也能按原 id 恢复，草稿跟着回来。
      const id = restoredId || crypto.randomUUID()
      // 这条会话在用户说出第一句话之前不进列表（规则见 lib/emptySession.ts 顶部）：
      // 它只活在内存与当前会话里 —— 引擎那边即使立刻落了空记录，界面也不为它占一行。
      hideEmptySession(id)
      if (!restoredId) {
        // 新会话是干净的一屏：进程内缓存一起清掉。
        dropSessionMemo(id)
      }
      // 与 openSession 同一条规矩：切走的那条若是「新建未发」的空会话，就此丢弃（草稿桶不动）。
      if (leaving.sessionId && leaving.sessionId !== id && hiddenEmptySessions.has(leaving.sessionId)) {
        dropSessionMemo(leaving.sessionId)
      }
      rememberLastSession(id)
      turnFirstTokenAt = 0
      turnLastTokenAt = 0
      // 提问的等待计时属于会话：换会话就停掉，别在新会话里凭空收掉一张卡。
      clearAskTimeout()
      // 游离输入（还没有会话归属时打的字 / 加的附件）落进这个会话的桶：切走再切回还在。
      if (unowned && (nextInput.draft || nextInput.quotes.length || nextInput.attachments.length)) {
        saveInput(bucketStore, id, nextInput)
      }
      set((s) => ({
        sessionId: id,
        // 新会话从空开始；带 restoredId 恢复时先取它自己的缓存，历史回读跟上后换成权威版本。
        messages: restoredId ? (messagesBySession.get(id) ?? []) : [],
        draft: nextInput.draft,
        quotes: nextInput.quotes,
        attachments: nextInput.attachments,
        streaming: false,
        // 全新会话没有历史可等：直接算作已加载，hero 立即显示。
        historyLoaded: { ...s.historyLoaded, [id]: true },
        runState: 'idle',
        question: null,
        askAnswers: {},
        stats: { ...EMPTY_STATS },
        pendingFirstTokenMs: 0,
        turnMeta: null,
        modelPending: null,
        interrupted: false,
        crashInterrupted: false,
        resuming: false,
      }))
      if (restoredId) {
        await get().loadHistory(id)
      }
      if (get().pendingCwd) {
        try { await writeCwd(id, get().pendingCwd) } catch { /* 引擎未就绪时忽略 */ }
      }
      connect()
    },

    rememberCwd: (dir) => {
      try { localStorage.setItem(CWD_KEY, dir) } catch { /* 隐私模式忽略 */ }
      set({ pendingCwd: dir })
    },

    applyCwd: async (dir) => {
      get().rememberCwd(dir)
      const id = get().sessionId
      if (!id) return
      await writeCwd(id, dir)
      await get().loadSessions()
    },

    /// 输入框内容按会话落本地（防抖 350ms；切会话/关窗另有即时 flush）。
    setDraft: (text) => {
      set({ draft: text })
      draftPending = { id: get().sessionId, text }
      if (draftTimer !== null) window.clearTimeout(draftTimer)
      draftTimer = window.setTimeout(flushDraft, 350)
    },

    /* ── 引用芯片 ──
       以前是 quoted: string：只能存一条，而且发送时是**拼进正文**的（'> ' 前缀）。
       现在改成数组：可以攒多条一起引用，走 WS 的 quotes 字段，正文保持干净。
       同一条消息 / 同一段文字重复引用只留一条（id 用随机 uuid，按 text + msgId 去重）。 */
    quotes: [],
    addQuote: (input) => {
      // 正文上限 4000 字：整条长回答被「引用」时，别把上千行塞进 WS 帧与提示词。
      const text = String(input.text ?? '').slice(0, 4000).trim()
      if (!text) return
      const current = get().quotes
      if (current.some((q) => q.text === text && (q.msgId ?? '') === (input.msgId ?? ''))) return
      const next = [...current, { id: crypto.randomUUID(), text, msgId: input.msgId, at: input.at ?? Date.now() }]
      // 用户输入类变更走 commitCritical：被闸门顺延的值补丁会用旧快照覆盖，
      // 表现是「刚加的引用/附件凭空没了」——和消息被吞是同一类竞态（见 tests/check-deferred-clobber.mjs）。
      commitCritical({ quotes: next })
      // 改一下就写一次盘：切会话 / 关窗 / 刷新都不会把它带到别的会话去。
      writeList(bucketStore, QUOTES_PREFIX, get().sessionId, next)
    },
    removeQuote: (id) => {
      const next = get().quotes.filter((q) => q.id !== id)
      if (next.length === get().quotes.length) return
      commitCritical({ quotes: next })
      writeList(bucketStore, QUOTES_PREFIX, get().sessionId, next)
    },
    clearQuotes: () => {
      if (!get().quotes.length) return
      commitCritical({ quotes: [] })
      writeList(bucketStore, QUOTES_PREFIX, get().sessionId, [])
    },

    /* ── 待发送的附件（按会话分桶）──
       大小由输入框那边 stat 回来之后补；存的是路径 + 名称 + 大小，纯展示与发送用。 */
    attachments: [],
    addAttachments: (paths) => {
      const current = get().attachments
      const known = new Set(current.map((a) => a.path))
      const added = (paths ?? [])
        .map((p) => String(p ?? ''))
        .filter((p) => p && !known.has(p))
        .map((path) => ({ path }) as AttachmentRef)
      if (!added.length) return
      const next = [...current, ...added]
      commitCritical({ attachments: next })
      writeList(bucketStore, ATTACHMENTS_PREFIX, get().sessionId, next)
    },
    removeAttachment: (path) => {
      const next = get().attachments.filter((a) => a.path !== path)
      if (next.length === get().attachments.length) return
      commitCritical({ attachments: next })
      writeList(bucketStore, ATTACHMENTS_PREFIX, get().sessionId, next)
    },
    setAttachmentSize: (path, size) => {
      if (!(size > 0)) return
      const next = get().attachments.map((a) => (a.path === path && a.size !== size ? { ...a, size } : a))
      commitCritical({ attachments: next })
      writeList(bucketStore, ATTACHMENTS_PREFIX, get().sessionId, next)
    },
    clearAttachments: () => {
      if (!get().attachments.length) return
      commitCritical({ attachments: [] })
      writeList(bucketStore, ATTACHMENTS_PREFIX, get().sessionId, [])
    },
    linkError: '',
    connecting: false,

    reconnect: () => {
      reconnectAttempt = 0
      set({ linkError: '' })
      connect()
    },

    /// 从某条消息分支：引擎复制该消息（含）之前的上下文到新会话。
    branchFrom: async (msgId) => {
      const engine = useEngine.getState()
      const data = await engine.api<{ id?: string }>(
        '/api/sessions/' + get().sessionId + '/branch',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ atMsgId: msgId }) },
      )
      if (!data?.id) throw new Error('分支失败：引擎没有返回新会话')
      await get().loadSessions()
      await get().openSession(data.id)
    },

    /// 编辑并重发：先截断到该消息之前，再把新文本作为新一轮发出。
    editAndResend: async (msgId, text) => {
      const engine = useEngine.getState()
      const id = get().sessionId
      // 截断是异步的：回来时若用户已经发了新一轮，就**不作废它**（整体换 messages 只允许
      // 发生在轮次没变时；那一轮的内容照旧留着，宁可多留也不许误清新一轮）。
      const seq = currentTurnSeq()
      await engine.api('/api/sessions/' + id + '/messages/' + msgId + '/truncate', { method: 'POST' })
      // 被截断的那一轮残文不能再提交回来（这一条是「引擎侧真的删掉了」的唯一整体替换路径）。
      dropChunks()
      if (!isTurnCurrent(seq) || get().sessionId !== id) return
      // 引擎侧真的把这条之后的内容删掉了：这里的回读必须**替换**而不是合并，
      // 否则被截断的旧条目会被合并规则当成「引擎还没落库的尾巴」补回来。
      await get().loadHistory(id, { replace: true })
      get().send(text)
    },

    /// 重新生成：把该助手回复之前的内容留下，重发上一条用户消息。
    regenerate: async (msgId) => {
      const messages = get().messages
      const index = messages.findIndex((m) => (m.kind === 'user' || m.kind === 'assistant') && m.msgId === msgId)
      const upto = index >= 0 ? messages.slice(0, index) : messages
      // 跳过还只是界面上的乐观条目（没有引擎 id，拿它去截断重发只会报错）。
      const lastUser = [...upto].reverse().find(
        (m): m is Extract<ChatItem, { kind: 'user' }> => m.kind === 'user' && !!m.msgId,
      )
      if (!lastUser) return
      await get().editAndResend(String(lastUser.msgId ?? ''), lastUser.text)
    },

    /// 出错后重试：截断到最后一个用户消息之前再重发它。
    retryLast: async () => {
      const lastUser = [...get().messages]
        .reverse()
        .find((m): m is Extract<ChatItem, { kind: 'user' }> => m.kind === 'user' && !!m.msgId)
      if (!lastUser) return
      await get().editAndResend(String(lastUser.msgId ?? ''), lastUser.text)
    },

    /// 直接下发一条 WS 命令（思考强度、放行程度这类会话级设置用得到）。
    sendCommand: (payload) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      socket.send(envelope(payload))
    },

    scheduleReconnectPublic: () => scheduleReconnect(),

    send: (text, extras) => {
      const trimmed = text.trim()
      if (!trimmed) return
      // 引用的缺省值取当前芯片（「继续生成」这类非输入框调用方不必自己传）；
      // 附件只有输入框知道（它是组件内的会话级暂存），所以只能由调用方带进来。
      const attachments = extras?.attachments ?? []
      const quotes = extras?.quotes ?? get().quotes
      /* ── 结构化负载：正文里**不再**拼「> 引用」与「附件：<路径>」──
         字段名与引擎的 Attachment / Quote 对齐（crates 侧 parse_attachments / parse_quotes）：
           · attachments: [{ path, name, ext, size? }] —— 引擎按 path 落盘并内联进请求；
           · quotes: [{ message_id?, text, at }]      —— 引用原文由引擎内联，界面只渲染卡片。
         size 只在拿到真值时带：0 会把引擎自己 stat 出来的大小覆盖成 0。 */
      const payload: Record<string, unknown> = { command: 'send_message', text: trimmed }
      if (attachments.length) {
        payload.attachments = attachments.map((a) => ({
          path: a.path,
          name: a.name ?? '',
          ext: fileExt(a.path).slice(1),
          ...(a.size && a.size > 0 ? { size: a.size } : {}),
        }))
      }
      if (quotes.length) {
        payload.quotes = quotes.map((q) => ({ message_id: q.msgId ?? '', text: q.text, at: q.at }))
      }
      /** 乐观条目也带上这两个字段：历史回读跟上之前，卡片照样在。
          本地 id（'u' + 序号）：与引擎真身同正文，回读时被 applyHistoryItems 认领替换。 */
      const optimistic = (queued: boolean): ChatItem => ({
        kind: 'user',
        id: 'u' + (streamSeq++),
        text: trimmed,
        at: Date.now(),
        ...(queued ? { queued: true } : {}),
        ...(attachments.length ? { attachments: attachments as Extract<ChatItem, { kind: 'user' }>['attachments'] } : {}),
        ...(quotes.length ? { quotes: quotes as Extract<ChatItem, { kind: 'user' }>['quotes'] } : {}),
        structured: true,
      })
      // 连不上时曾经是「静默 return」——用户以为发出去了，其实什么都没发生。
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        // 没发出去：草稿留在输入框里，只提示一句，不静默丢弃。
        // messages 只走函数补丁：值补丁被提交闸门顺延后会用旧快照覆盖新增条目（丢消息）。
        set((s) => ({
          messages: applyEventsToMessages(s.messages, [
            { event_type: 'agent_error', message: '连接已断开，消息没有发出。正在自动重连，必要时会自动重启引擎，连上后重发即可。', code: 'link_down' },
          ], streamSeq++),
          linkError: '连接已断开，消息没有发出，正在自动重连',
        }))
        get().scheduleReconnectPublic()
        return
      }
      /* ── 运行中插话 ──
         AI 正在生成时用户又发了消息：**不再拦下来，也不丢**。
         · 排队（默认）：引擎把这条排进会话队列，本轮结束后按顺序作为独立一轮执行；
         · 打断：引擎先取消当前轮（已生成的内容由引擎落成草稿 + 前端会话缓存两边保住），
           再立刻发起新一轮。
         两种模式下前端都不动本轮的 streaming / 消息：插话不打断工具执行，
         界面这一轮该显示什么还显示什么，新消息以独立一条用户消息、带「排队中」标记出现。 */
      if (get().streaming || get().runState !== 'idle') {
        lastEventAt = Date.now()
        ensureWatchdog()
        const interrupt = useUi.getState().prefs.insertMode === 'interrupt'
        socket.send(envelope(interrupt ? { ...payload, interrupt: true } : payload))
        // 发出去了才记：本地索引用来在历史回读时把卡片补回这条消息上。
        rememberSentMeta(get().sessionId, { text: trimmed, at: Date.now(), attachments, quotes })
        // 新建会话的第一条消息：列表里立刻出现它（规则见文件顶部 hiddenEmptySessions）。
        publishFirstMessage(get().sessionId, trimmed)
        // 发出去之后立刻把会话列表拉一份：engineSaysRunning / engineReallyIdle 都读它，
        // 而本地那份还是「本轮开始之前」的快照（running=false）——
        // 不刷新就会让看门狗/心跳把正在跑的这一轮判成已结束。
        void get().loadSessions().catch(() => { /* 列表刷新失败不影响发送 */ })
        if (interrupt) {
          // 打断会产生一条「取消回执」turn_end：那不是「回复好了」，不弹完成提醒。
          suppressTurnEndNotify = true
        }
        // 缓冲里的正文先提交：插话时的切状态/回读都不该把还没提交的文本冲掉。
        flushChunks()
        const sid = get().sessionId
        set((s) => ({
          messages: [...s.messages, optimistic(true)],
          historyLoaded: { ...s.historyLoaded, [sid]: true },
          draft: '',
          quotes: [],
          attachments: [],
        }))
        // 发送成功＝草稿已经变成消息：本地草稿立刻清掉。
        draftPending = { id: sid, text: '' }
        flushDraft()
        // 输入区的那一份已经变成消息了：清掉**当前会话**的桶（别的会话的待发送内容不动）。
        clearInput(bucketStore, sid)
        toast.message(interrupt ? '已打断当前轮，正在按新消息继续（已生成内容已保留）' : '已排队：当前回复结束后立刻执行')
        return
      }
      socket.send(envelope(payload))
      // 发出去了才记：本地索引用来在历史回读时把卡片补回这条消息上。
      rememberSentMeta(get().sessionId, { text: trimmed, at: Date.now(), attachments, quotes })
      // 新建会话的第一条消息：列表里立刻出现它（规则见文件顶部 hiddenEmptySessions）。
      publishFirstMessage(get().sessionId, trimmed)
      // 同上：先让本地会话列表跟上「这一轮已经在跑」，后面所有 running 判据才准。
      void get().loadSessions().catch(() => { /* 列表刷新失败不影响发送 */ })
      // 看门狗的时间基准也要跟着走：刚发出去的一轮不该被当成「3 秒没有动静」。
      // 这里要**主动起搏**：万一这一轮连一个事件都没等到就丢了 turn_end，
      // 没有事件就没有 handleEvent，看门狗不起搏的话界面会永远停在「进行中」。
      lastEventAt = Date.now()
      ensureWatchdog()
      // 这一轮开始了：标记为「未完成」，切走再切回时它才允许恢复流式光标。
      liveTurnSessions.add(get().sessionId)
      // 新一轮开始：上一轮缓冲里还没提交的正文**不能丢**：先写回原会话缓存再开新一轮。
      turnSeq += 1
      // 与 turnSeq 并行：turn_end 判重的轮次身份也在**每一轮真正开始**时递增（唯一入口）。
      markTurnStarted()
      flushChunks()
      // 缓冲已清：这一轮后续的 chunk 从空缓冲开始（上一轮的残文绝不会混进这一轮）。
      dropChunks()
      turnCanceled = false
      draftPending = { id: get().sessionId, text: '' }
      flushDraft()
      // 输入区（草稿 / 引用 / 附件）的那一份已经变成消息：清掉**当前会话**的三个桶。
      clearInput(bucketStore, get().sessionId)
      turnChars = 0
      // 本轮耗时的打点从第一个 chunk 才开始（见 lib/chat.ts），这里先清空。
      turnFirstTokenAt = 0
      turnLastTokenAt = 0
      const sid = get().sessionId
      set((s) => ({
        // 乐观用户消息：先显示出来，历史回读按正文认领成引擎真身（applyHistoryItems）。
        // 以前这条只活在历史里，一次「读回旧快照 / 读回失败」就把它和刚到的回答一起抹掉，
        // 表现就是「发消息后一问一答一起消失，切回来又好了」——现在消息只增不减，回读滞后
        // 由 applyHistoryItems 保留本地尾部，这类竞态从结构上不存在。
        messages: journaled([...s.messages, optimistic(false)], 'send'),
        historyLoaded: { ...s.historyLoaded, [sid]: true },
        streaming: true,
        runState: 'thinking',
        draft: '',
        quotes: [],
        attachments: [],
        turnMeta: null,
        interrupted: false,
        crashInterrupted: false,
      }))
    },

    cancel: () => {
      socket?.send(envelope({ command: 'cancel' }))
      turnCanceled = true
      // 这里**不**清 liveTurnSessions：停止后引擎还会补一条 turn_end（部分回复也要落库），
      // 在那之前切走再切回来，已产出的内容还能从会话缓存里看到。
      // 那条 turn_end 一到，标记自然被清掉。
      // 保留已产出的内容（缓冲里的正文先提交，别等 rAF），并标记「已中断」，让用户能一键继续。
      flushChunks()
      // 用户刚按的「停止」：立刻收成已完成，不能被熔断顺延。
      commitCritical({ streaming: false, runState: 'idle', interrupted: true })
    },

    approve: (decision) => {
      const callId = get().approval?.callId ?? ''
      socket?.send(envelope({ command: 'approve_tool', call_id: callId, decision: decision === 'deny' ? '' : decision }))
      set({ approval: null, runState: 'executing' })
    },

    answerQuestion: (payload, callId) => {
      const fallback = get().question?.callId ?? ''
      const target = callId || fallback
      // 没有 callId 就无从对账（引擎不会认这条回答），但仍然把本地这一问收掉：
      // 用户按下的「跳过」必须立刻生效，不能因为引擎没给 id 就卡住整轮对话。
      const items = payload?.items ?? {}
      const answer: AskAnswer = {
        items,
        skipped: payload?.skipped === true || Object.keys(items).length === 0,
        timedOut: payload?.timedOut === true ? true : undefined,
        at: Date.now(),
      }
      // 发给引擎的 answers 保持旧口径（问题 id → 选中值；多选发数组；「其他」的文本并进去）：
      // 引擎没实现这一版协议时它只当一条普通命令收下，本地那份回答照样留在卡片上。
      const wire: Record<string, string | string[]> = {}
      for (const [id, one] of Object.entries(items)) {
        const picked = (Array.isArray(one?.values) ? one.values : []).filter((v) => typeof v === 'string' && v)
        const custom = typeof one.custom === 'string' ? one.custom.trim() : ''
        if (custom) picked.push(custom)
        if (!picked.length) continue
        wire[id] = picked.length > 1 ? picked : picked[0]
      }
      socket?.send(envelope({ command: 'answer_question', call_id: target, answers: wire }))
      clearAskTimeout()
      // 只有「答的就是当前挂起那一问」才动 question / runState：
      // 回头去补答一张旧卡片时，不能把正在跑的这一轮的状态改掉。
      const isCurrent = !!target && get().question?.callId === target
      set((s) => ({
        ...(isCurrent ? { question: null, runState: 'executing' as const } : {}),
        askAnswers: target ? { ...s.askAnswers, [target]: answer } : s.askAnswers,
      }))
    },

    selectModel: (providerId, model) => {
      const ws = socket
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // 没发出去就别改显示：改了只会「闪一下又变回来」，还让人以为切换生效了。
        toast.error('连接已断开，模型没有切换，请重连后再试')
        return
      }
      const requestId = crypto.randomUUID()
      set({
        modelPending: {
          providerId,
          model,
          at: Date.now(),
          requestId,
          prevProviderId: get().currentProviderId,
          prevModel: get().currentModel,
        },
        // 乐观显示：引擎要先做上游凭据校验才落盘，这期间界面必须显示新值。
        currentModel: model || providerId,
        currentProviderId: providerId,
      })
      modelRequestIds.add(requestId)
      ws.send(envelopeWithId(requestId, { command: 'select_model', provider_id: providerId, model }))
      // 阶梯回读：命中（引擎值 == 在途值）时 applyEngineModel 会清掉在途标记，
      // 后面几阶梯自然跳过；失败则由 error 帧回滚。
      for (const delay of MODEL_READBACK_STEPS_MS) {
        window.setTimeout(() => {
          const pending = activePending()
          if (!pending || pending.requestId !== requestId) return
          void get().loadSessions().catch(() => { /* 读不到就等下一阶梯 */ })
        }, delay)
      }
      // TTL 兜底：10s 还没确认，作废在途标记并回读一次，把显示交还给引擎真值。
      window.setTimeout(() => {
        modelRequestIds.delete(requestId)
        const pending = get().modelPending
        if (!pending || pending.requestId !== requestId) return
        set({ modelPending: null })
        void get().loadSessions().catch(() => { /* 引擎不可用：保持当前显示 */ })
      }, MODEL_PENDING_TTL_MS + 250)
    },

    disconnect: () => {
      socket?.close()
      socket = null
      // 主动断开：停止 ack 兜底定时器（断开连接时不再发 ack）；last 留给下次连接 resync。
      stopSeqAckTimer()
      // 断开前把缓冲与草稿落定：断线不该吞掉已经收到的正文。
      flushChunks()
      flushDraft()
      commitCritical({ connected: false, streaming: false })
    },
  }
})

/** 用户消息条目 + 结构化的附件 / 引用（lib/chat.ts 的 ChatItem 已带这两个字段，
    这里把类型收窄成渲染层认识的形态：附件 / 引用来自发送时的乐观条目或引擎历史）。 */
export type UserChatItem = Extract<ChatItem, { kind: 'user' }> & {
  /** 这条消息带的附件（新协议发出、或引擎历史里带、或本地索引补上） */
  attachments?: AttachmentRef[]
  /** 这条消息带的引用 */
  quotes?: QuoteRef[]
  /** 新协议发出的消息：正文里不会再有「> 」/「附件：」前缀，渲染层不必做旧格式升级 */
  structured?: boolean
}

/** 渲染用条目：用户那条多挂两个字段，其余与 lib/chat.ts 的 ChatItem 完全一致。 */
export type RenderItem = Exclude<ChatItem, { kind: 'user' }> | UserChatItem

/** 把两件只有 store 知道的事认领到提问卡上（lib/chat.ts 只落卡，够不着这两件）：
    · answer —— 用户当时选了什么。答完不删，就是靠它把「你选了什么」留在卡片上；
    · pending —— 全表**最后一张没答的卡**才接管键盘（数字选 / Enter 确认 / Esc 跳过），
      历史里那些早就答过的卡不许跟着抢按键。
    没有提问卡 / 什么都没变时**原样返回同一份数组**：引用不变 = 下游一次提交都不发。 */
function withAskState(items: ChatItem[], answers: Record<string, AskAnswer>): ChatItem[] {
  let lastOpen = -1
  let hasAsk = false
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at]
    if (item.kind !== 'ask') continue
    hasAsk = true
    if (lastOpen < 0 && !answers[item.callId]) lastOpen = at
  }
  if (!hasAsk) return items
  let changed = false
  const out = items.map((item, at) => {
    if (item.kind !== 'ask') return item
    const answer = answers[item.callId] ?? null
    const pending = at === lastOpen
    if (answer === item.answer && pending === item.pending) return item
    changed = true
    return { ...item, answer, pending }
  })
  return changed ? out : items
}

/** 渲染用条目：**直接就是 messages**（唯一事实来源），只补两件 store 才知道的事：
    提问卡的回答与挂起标记。必须 memo 化——直接把 messages 当 zustand 选择器会每次返回
    新数组，触发 React「Maximum update depth exceeded」（错误码 #185）。 */
export function useChatItems(): RenderItem[] {
  const messages = useSession((s) => s.messages)
  /// 提问卡的回答（按会话）：答完不消失，就靠它回填到卡片上。
  const askAnswers = useSession((s) => s.askAnswers)
  return useMemo(() => withAskState(messages, askAnswers) as RenderItem[], [messages, askAnswers])
}




