/** 对话渲染管线的**唯一事实来源**：一份 `messages: ChatItem[]`（稳定 id）。
 *
 * 本文件只提供纯函数（不依赖 React / DOM），浏览器与回归脚本（node 直接跑 TS）共用同一份：
 *   · itemsFromHistory      —— 引擎历史（/api/sessions/{id}）→ ChatItem 映射；
 *   · applyEventsToMessages —— 实时事件**就地追加**到当前这条消息（正文 / 思考 / 工具与顺序段）；
 *   · applyHistoryItems     —— 历史回读合并：被历史覆盖的部分整体换成历史的版本，
 *                              历史还没有的本地尾部（乐观条目 / 还在流式的回复）一律保留；
 *   · chatWindowTail        —— 窗口切片：默认最后 60 条 + 顶部「加载更早」每次 +60。
 * 不再有「历史 vs 实时事件 vs 已展示记忆」三套状态的对账：一切合并 / 剪枝 / 覆盖判定都已删除。 */

export interface ToolCall {
  callId: string
  name: string
  args: string
  status: 'queued' | 'running' | 'done' | 'error' | 'denied'
  elapsedMs?: number
  preview?: string
  images?: string[]
  cacheHit?: boolean
}

/** 用户消息附带的结构化附件（与 components/chat/AttachmentCard 的 AttachmentRef 同形）。 */
export interface ItemAttachment {
  path: string
  name?: string
  size?: number
}

/** 用户消息附带的引用（与 components/chat/QuoteBlock 的 QuoteRef 同形）。 */
export interface ItemQuote {
  text: string
  id?: string
  msgId?: string
  at?: number
}

export type ChatItem =
  | {
      kind: 'user'
      id: string
      msgId?: string
      text: string
      at?: number
      /** 「运行中插话」：这条消息已经发给引擎、但本轮还在跑，引擎把它排在队里等这一轮结束。
          引擎开跑（queued_message_started）或队列被清空（queue_cleared）时标记被摘掉。 */
      queued?: boolean
      /** 结构化附件 / 引用：发送时（乐观条目）与引擎历史里都带（见 itemsFromHistory）。 */
      attachments?: ItemAttachment[]
      quotes?: ItemQuote[]
      structured?: boolean
    }
  | {
      kind: 'assistant'
      id: string
      msgId?: string
      text: string
      reasoning: string
      tools: ToolCall[]
      /** 顺序段：正文与工具按**事件先后**交替排列（渲染按它画，工具不再一律沉到正文下面）。
       *  没有它（例如历史条目）时退回「正文在上、工具在下」的老画法。 */
      segments?: Array<{ kind: 'text'; text: string } | { kind: 'tools'; callIds: string[] }>
      streaming: boolean
      /** 只有「思考内容还在流式产出」时才为 true。 */
      reasoningStreaming?: boolean
      at?: number
    }
  | {
    kind: 'notice'
    id: string
    text: string
    tone: 'info' | 'error'
    retryable?: boolean
    /** 这张卡可以「继续这一轮」（本轮被上游中断 / 工具轮次用尽时给）。 */
    resume?: boolean
  }
  /** AI 提问卡：引擎的 user_question_request 落在对话流里的那一条。
   *  与「审批卡」（弹窗、答完就关）不同，这张卡**答完不消失** —— answer 留在卡片上，
   *  用户回头还能看到自己当时选了什么。见 components/chat/AskUserCard.tsx。 */
  | {
      kind: 'ask'
      id: string
      /** 引擎的 call_id：回答时原样带回（answer_question 命令）。 */
      callId: string
      /** 所有问题的纯文本（搜索 / 条目身份键的兜底正文）。 */
      prompt: string
      questions: AskQuestion[]
      /** 用户的回答；null = 还没答。由 stores/session.ts 的 useChatItems 认领到条目上。 */
      answer: AskAnswer | null
      /** 这一张是不是「当前挂起的那一问」：同一时刻只有最后一张没答的卡为 true。
       *  只有它为 true 时卡片才接管键盘（数字选 / Enter 确认 / Esc 跳过），
       *  否则历史里那些早就答过的卡会跟着一起抢按键。 */
      pending: boolean
    }

/** 引擎在 user_question_request 里给的单个问题。
    字段名沿用引擎口径（id / header / question / options[{label,value}]），
    multi 各家叫法不一，两个都认（multi / multiple）。 */
export interface AskQuestion {
  id: string
  header?: string
  question: string
  options: Array<{ label: string; value: string }>
  /** 多选题：选中的值可以有多个。 */
  multi: boolean
}

/** 单个问题的回答：选中的选项值 + 「其他（自己填）」里的文本。 */
export interface AskAnswerItem {
  values: string[]
  custom: string
}

/** 一张提问卡的回答。items 按问题 id 存；skipped = 整卡跳过（没有回答）。 */
export interface AskAnswer {
  items: Record<string, AskAnswerItem>
  skipped: boolean
  /** 到点自动收掉的（「提问等待超时」）：不是用户主动跳过的。 */
  timedOut?: boolean
  at: number
}

/** 引擎的 questions 数组 → 卡片认识的结构。缺 id 的按序号补一个（回答时按同一套键回填）。 */
export function parseAskQuestions(raw: unknown): AskQuestion[] {
  const list = Array.isArray(raw) ? raw : []
  const out: AskQuestion[] = []
  for (let i = 0; i < list.length; i += 1) {
    const one = (list[i] ?? {}) as Record<string, any>
    const options = (Array.isArray(one.options) ? one.options : []).map((o: any) => ({
      label: str(o?.label ?? o?.value ?? o),
      value: str(o?.value ?? o?.label ?? o),
    })).filter((o: { label: string; value: string }) => !!o.value)
    out.push({
      id: str(one.id, 'q' + i) || 'q' + i,
      header: str(one.header) || undefined,
      question: str(one.question ?? one.header ?? one.title, '请选择'),
      options,
      multi: one.multi === true || one.multiple === true || str(one.type).toLowerCase() === 'multiple',
    })
  }
  return out
}

/** 一张卡的全部问题文本拼成一段（搜索与条目身份键用）。 */
export function askPromptText(questions: AskQuestion[]): string {
  return questions.map((q) => q.header ? q.header + ' ' + q.question : q.question).join('\n')
}

/** 回答的可读摘要：「选项 A、其他：xxx」/「已跳过」/「已超时」。 */
export function askAnswerSummary(answer: AskAnswer, questions: AskQuestion[]): string {
  if (answer.skipped) return answer.timedOut ? '已超时，自动跳过' : '已跳过'
  const parts: string[] = []
  for (const q of questions) {
    const one = answer.items[q.id]
    if (!one) continue
    const picked = one.values.map((v) => {
      const hit = q.options.find((o) => o.value === v)
      return hit ? hit.label : v
    })
    if (one.custom.trim()) picked.push('其他：' + one.custom.trim())
    if (picked.length) parts.push((questions.length > 1 ? q.question + '：' : '') + picked.join('、'))
  }
  return parts.length ? parts.join('；') : '已提交'
}

type Ev = Record<string, any>

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v)
}

/** 工具参数是对象，展示时统一成 JSON 文本（过长截断，避免一次渲染几十万字符）。 */
function argsText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.slice(0, 4000)
  try { return JSON.stringify(value).slice(0, 4000) } catch { return '' }
}

/** 工具结果最多留这么多字符：历史里的 shell 输出可能上百 KB，全量塞进 DOM 会卡。 */
const PREVIEW_LIMIT = 8000

/* ── 思考内容（reasoning）从历史里读出来 ──
   引擎开始把本轮 reasoning 一起落库，字段名在不同版本/不同上游下叫法不一，
   所以这里按候选顺序取第一个非空字符串，取不到就是空串（不渲染思考框）。 */
const REASONING_KEYS = [
  'reasoning', 'reasoning_content', 'reasoningContent', 'reasoning_text',
  'thinking', 'thinking_content', 'analysis',
]

function reasoningOf(message: Record<string, any>): string {
  for (const key of REASONING_KEYS) {
    const value = message[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  // 兼容「思考作为服务端条目」的形态（provider_items 里的 reasoning item）。
  const items = Array.isArray(message.provider_items) ? message.provider_items : []
  for (const item of items) {
    const type = str(item?.type)
    if (type !== 'reasoning' && type !== 'thinking') continue
    const direct = str(item?.text ?? item?.content)
    if (direct.trim()) return direct
    const summary = Array.isArray(item?.summary) ? item.summary : []
    const joined = summary.map((entry: any) => str(entry?.text ?? entry)).filter(Boolean).join('\n')
    if (joined.trim()) return joined
  }
  return ''
}

/** 两条正文是不是「同一条消息」（保留给外部工具与历史测试用；渲染管线本身不再依赖它做对账）。 */
export function sameMessage(left: string, right: string): boolean {
  const a = left.trim()
  const b = right.trim()
  if (!a || !b) return false
  if (a === b) return true
  if (a.startsWith(b) || b.startsWith(a)) return true
  const head = Math.min(160, a.length, b.length)
  return head >= 40 && a.slice(0, head) === b.slice(0, head)
}

/**
 * 历史消息 → 条目（**历史回读的唯一映射**）。
 *
 * 引擎的会话记录是**有序的完整对话**（user / assistant / tool 交替），
 * assistant 带 tool_calls、tool 用 tool_call_id 回填结果。
 * 条目 id 优先取引擎消息 id（msgId），没有（乐观条目）才退回本地序号。
 * 顺序段：有工具调用的助手消息折成 text/tools 交替段（正文在上、工具在下不再强制）。
 */
export function itemsFromHistory(messages: Array<Record<string, any>> | undefined): ChatItem[] {
  const out: ChatItem[] = []
  const byCallId = new Map<string, ToolCall>()

  for (const m of messages ?? []) {
    const role = str(m.role)
    const text = str(m.content)
    const msgId = str(m.id) || undefined
    const at = typeof m.at_ms === 'number' ? m.at_ms : typeof m.timestamp === 'number' ? m.timestamp : undefined

    if (role === 'user') {
      if (!text) continue
      out.push({
        kind: 'user', id: msgId ?? 'h' + out.length, msgId, text, at,
        ...(m.__queued === true ? { queued: true as const } : {}),
        ...(Array.isArray(m.attachments) ? { attachments: m.attachments as ItemAttachment[] } : {}),
        ...(Array.isArray(m.quotes) ? { quotes: m.quotes as ItemQuote[] } : {}),
        ...(m.__structured === true ? { structured: true as const } : {}),
      })
      continue
    }

    if (role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : []
      const tools: ToolCall[] = calls.map((call: Record<string, any>) => ({
        callId: str(call?.id ?? call?.call_id),
        name: str(call?.name ?? call?.function?.name, 'tool'),
        args: argsText(call?.arguments ?? call?.args ?? call?.function?.arguments),
        status: 'queued' as const,
      }))
      // 引擎把「调用工具的那一步」也存成 assistant 消息，正文往往是几个换行。
      // 这类条目只有工具调用，不该产生空气泡。
      if (!text.trim() && !tools.length) continue
      const item: Extract<ChatItem, { kind: 'assistant' }> = {
        kind: 'assistant', id: msgId ?? 'h' + out.length, msgId,
        text, reasoning: reasoningOf(m), tools, streaming: false, at,
      }
      // 顺序段：正文与工具按历史里的先后交替（一段正文一段工具）。
      if (tools.length) {
        const segments: Extract<ChatItem, { kind: 'assistant' }>['segments'] = []
        if (text.trim()) segments.push({ kind: 'text', text })
        segments.push({ kind: 'tools', callIds: tools.map((t) => t.callId).filter(Boolean) })
        item.segments = segments
      }
      out.push(item)
      for (const tool of tools) if (tool.callId) byCallId.set(tool.callId, tool)
      continue
    }

    if (role === 'tool') {
      const callId = str(m.tool_call_id)
      const call = callId ? byCallId.get(callId) : undefined
      // 引擎把失败写成 "error: ..." 前缀（成功是 "success: ..."）。
      const failed = /^\s*error[:：]/i.test(text)
      if (call) {
        call.status = failed ? 'error' : 'done'
        call.preview = text.slice(0, PREVIEW_LIMIT)
      } else if (text) {
        // 对不上调用记录（历史被截断/外部写入）：单独成条，信息不丢。
        out.push({
          kind: 'assistant', id: 'h' + out.length, text: '', reasoning: '',
          tools: [{
            callId: callId || 'h' + out.length, name: str(m.name, 'tool'), args: '',
            status: failed ? 'error' : 'done', preview: text.slice(0, PREVIEW_LIMIT),
          }],
          streaming: false,
        })
      }
    }
  }
  // 同一轮的多条 assistant 在这里合并成一条（见 mergeAssistantTurns 的说明）。
  return mergeAssistantTurns(out)
}

/**
 * 根治"旧内容跑到新回答下面"：把**同一轮**里的多条 assistant 合并成一条。
 *
 * 为什么必须合并：引擎把「调用工具的每一步」也存成一条 assistant 消息，于是同一轮回复
 *   流式中 = **1 条**（正文与工具按事件先后交替进 segments）
 *   回读后 = **N 条**（每个工具步骤一条，各自带 reasoning 与合成的 [正文, 工具]）
 * 两个模型不一致 → 轮结束切数据源 / 回读时列表重建，旧步骤的思考与正文就被重新画到
 * 新回答附近甚至下面。
 *
 * 合并规则（与流式路径对齐）：
 *   · 正文与工具按**真实先后**交替进 segments（不再固定 [正文, 工具]）
 *   · reasoning 顺序拼接；tools 汇总（供 item.tools.find 反查）
 *   · msgId 取**最后一条有正文的** —— 重新生成 / 从这里分支都挂在它上面
 * 遇到 user / notice 等非 assistant 条目即视为新一轮开始，不跨轮合并。
 */
function mergeAssistantTurns(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = []
  for (const item of items) {
    const prev = out[out.length - 1]
    if (item.kind !== 'assistant' || prev?.kind !== 'assistant') {
      out.push(item)
      continue
    }
    const segments = prev.segments ? prev.segments.slice() : []
    // prev 还没有 segments（它当时没有工具）时，先把它的正文补成第一段。
    if (!segments.length && prev.text.trim()) segments.push({ kind: 'text', text: prev.text })
    if (item.text.trim()) segments.push({ kind: 'text', text: item.text })
    if (item.tools.length) {
      segments.push({ kind: 'tools', callIds: item.tools.map((t) => t.callId).filter(Boolean) })
    }
    out[out.length - 1] = {
      ...prev,
      text: prev.text + item.text,
      reasoning: prev.reasoning + item.reasoning,
      tools: [...prev.tools, ...item.tools],
      segments,
      ...(item.text.trim() && item.msgId ? { msgId: item.msgId } : {}),
      streaming: prev.streaming || item.streaming,
    }
  }
  return out
}

const TOOL_LIKE = new Set(['tool_start', 'tool_running', 'tool_done', 'tool_cache_hit'])

/** 事件里若带着助手消息 id（引擎落库后补发/回放事件时会带），认到当前段落上：
    历史回读后就能按「消息 id 相同」认出这是同一条。 */
function evMsgId(ev: Ev): string {
  return str(ev.message_id ?? ev.msg_id ?? ev.assistant_message_id)
}

/** 找「当前这条助手消息」：从末尾往回找，**跳过**排队中的插话（还没开跑，不算分界）、
    提示条与提问卡；遇到「已开跑的用户消息」就停 —— 那是新一轮的分界，前面的都不是本轮的。 */
function findCurrentAssistant(list: ChatItem[]): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i]
    if (item.kind === 'assistant') return i
    if (item.kind === 'user' && !item.queued) return -1
  }
  return -1
}

/** 新建一条流式助手消息的骨架。 */
function freshAssistant(seq: number): Extract<ChatItem, { kind: 'assistant' }> {
  return {
    kind: 'assistant', id: 'e' + seq, text: '', reasoning: '',
    tools: [], segments: [], streaming: true, reasoningStreaming: false,
  }
}

/**
 * 一条实时事件 → 就地追加到消息数组（**不合并、不剪枝、不覆盖**）：
 *   · text_chunk / reasoning_chunk 直接追加到「当前这条 assistant 消息」；
 *   · tool_start / running / done / cache_hit 写进这条消息的 tools 与 **segments 顺序段**
 *     （正文 / 工具按事件先后交替）；
 *   · compression / agent_error / user_question_request 各落一条 notice / ask 条目；
 *   · turn_end 收尾（streaming=false + reasoningStreaming=false）；
 *   · message_queued / queued_message_started / queue_cleared / turn_interrupted 维护「排队中」标记。
 * 没有任何内容变化时返回**原数组引用**（渲染层靠引用判断要不要重画）。
 */
export function applyEventToMessages(
  messages: readonly ChatItem[],
  ev: Ev,
  ctx: { seq?: number } = {},
): ChatItem[] {
  const type = str(ev.event_type)
  const seq = ctx.seq ?? 0
  const list = messages as ChatItem[]

  /* ── 流式正文 / 思考：就地追加 ── */
  if (type === 'text_chunk' || type === 'reasoning_chunk') {
    const piece = str(ev.content ?? ev.delta ?? ev.text)
    if (!piece) return messages as ChatItem[]
    let idx = findCurrentAssistant(list)
    let copy: ChatItem[]
    if (idx < 0) {
      copy = [...list, freshAssistant(seq)]
      idx = copy.length - 1
    } else {
      copy = list.slice()
    }
    const host = copy[idx] as Extract<ChatItem, { kind: 'assistant' }>
    const mid = evMsgId(ev)
    const next: Extract<ChatItem, { kind: 'assistant' }> = {
      ...host,
      ...(mid && !host.msgId ? { msgId: mid } : {}),
      text: type === 'text_chunk' ? host.text + piece : host.text,
      reasoning: type === 'reasoning_chunk' ? host.reasoning + piece : host.reasoning,
      streaming: true,
      // 正文开始 = 思考阶段结束（思考行前面的圈圈必须立刻停）。
      reasoningStreaming: type === 'reasoning_chunk'
        ? true
        : host.reasoning ? false : host.reasoningStreaming,
    }
    // 顺序段：正文接在当前段上；当前段是工具段就新起一个文本段（工具因此留在正文之间）。
    if (type === 'text_chunk' && next.segments) {
      const lastSeg = next.segments[next.segments.length - 1]
      if (lastSeg && lastSeg.kind === 'text') {
        next.segments = [...next.segments.slice(0, -1), { kind: 'text', text: lastSeg.text + piece }]
      } else {
        next.segments = [...next.segments, { kind: 'text', text: piece }]
      }
    }
    copy[idx] = next
    return copy
  }

  /* ── 工具调用：写进当前这条消息的 tools 与顺序段 ── */
  if (TOOL_LIKE.has(type)) {
    const callId = str(ev.call_id ?? ev.id ?? 'tool-' + seq)
    let idx = findCurrentAssistant(list)
    let copy: ChatItem[]
    if (idx < 0) {
      copy = [...list, freshAssistant(seq)]
      idx = copy.length - 1
    } else {
      copy = list.slice()
    }
    const host = copy[idx] as Extract<ChatItem, { kind: 'assistant' }>
    const mid = evMsgId(ev)
    const tools = host.tools.slice()
    let segments = host.segments
    const at = tools.findIndex((t) => t.callId === callId)
    if (at >= 0) {
      const existing = tools[at]
      const patch: Partial<ToolCall> = {}
      if (type === 'tool_running') patch.status = 'running'
      if (type === 'tool_cache_hit') { patch.cacheHit = true; patch.status = 'running' }
      if (type === 'tool_done') {
        patch.status = ev.is_error ? 'error' : 'done'
        // 引擎给的是 elapsed（秒，浮点），不是 elapsed_ms。
        patch.elapsedMs =
          typeof ev.elapsed === 'number' ? Math.round(ev.elapsed * 1000)
            : typeof ev.elapsed_ms === 'number' ? ev.elapsed_ms
              : existing.elapsedMs
        patch.preview = str(ev.result_preview, existing.preview ?? '').slice(0, PREVIEW_LIMIT) || undefined
        if (Array.isArray(ev.images)) patch.images = ev.images.map((i: unknown) => str(i))
      }
      tools[at] = { ...existing, ...patch }
    } else {
      const added: ToolCall = {
        callId,
        name: str(ev.tool_name ?? ev.name, 'tool'),
        args: argsText(ev.arguments ?? ev.args ?? {}),
        status: type === 'tool_start' ? 'running' : type === 'tool_done' ? (ev.is_error ? 'error' : 'done') : 'running',
        elapsedMs: typeof ev.elapsed === 'number' ? Math.round(ev.elapsed * 1000) : undefined,
        preview: str(ev.result_preview).slice(0, PREVIEW_LIMIT) || undefined,
        cacheHit: type === 'tool_cache_hit' || undefined,
      }
      tools.push(added)
      // 顺序段：连续的工具调用并进同一个「工具段」，正文一来就自然接在它后面。
      if (segments) {
        segments = segments.slice()
        const lastSeg = segments[segments.length - 1]
        if (lastSeg && lastSeg.kind === 'tools') {
          segments = [...segments.slice(0, -1), { kind: 'tools', callIds: [...lastSeg.callIds, callId] }]
        } else {
          segments = [...segments, { kind: 'tools', callIds: [callId] }]
        }
      }
    }
    copy[idx] = {
      ...host,
      ...(mid && !host.msgId ? { msgId: mid } : {}),
      tools,
      ...(segments ? { segments } : {}),
      streaming: true,
      // 调工具 = 思考阶段结束。
      ...(host.reasoning ? { reasoningStreaming: false } : {}),
    }
    return copy
  }

  /* ── 提示条 ── */
  if (type === 'compression') {
    return [...list, {
      kind: 'notice', id: 'n' + seq,
      text: '上下文已压缩 ' + str(ev.before, '?') + ' → ' + str(ev.after, '?'),
      tone: 'info',
    }]
  }
  if (type === 'agent_error') {
    return [...list, {
      kind: 'notice', id: 'n' + seq,
      text: str(ev.message, '执行出错'),
      tone: 'error',
      // 没配模型属于「先配置再用」，重试没意义；其它错误允许重试。
      retryable: ev.code !== 'no_provider',
    }]
  }

  /* ── AI 提问：对话流里的一张卡（答完不消失）。条目 id 用 call_id（重发不重复画卡）。 ── */
  if (type === 'user_question_request') {
    const callId = str(ev.call_id ?? ev.callId ?? ev.id)
    const questions = parseAskQuestions(ev.questions ?? ev.items)
    return [...list, {
      kind: 'ask', id: 'ask:' + (callId || 'q' + seq), callId,
      prompt: askPromptText(questions), questions, answer: null, pending: false,
    }]
  }

  /* ── 本轮被中断（上游不可用 / 工具轮次用尽）：引擎发 retry_confirmation ──
     2026-09-29 真机事故：前端以前**完全不认这个事件**（全仓库零处理），而引擎在这种
     情况下不发 agent_error —— 于是「任务做一半停了」在对话流里一个字都没有，
     用户看到的就是「它不回我了」。现在落成一张可操作的卡。 */
  if (type === 'retry_confirmation') {
    const used = typeof ev.rounds_used === 'number' ? ev.rounds_used : null
    const limit = typeof ev.rounds_limit === 'number' ? ev.rounds_limit : null
    const rounds = used !== null && limit !== null ? '（已用 ' + used + '/' + limit + ' 轮工具）' : ''
    const tool = str(ev.last_tool) ? '，最后在跑 ' + str(ev.last_tool) : ''
    const detail = str(ev.detail).split('\n')[0].slice(0, 220)
    return [...list, {
      kind: 'notice', id: 'n' + seq,
      text: str(ev.message, '本轮被中断') + rounds + tool + (detail ? '：' + detail : ''),
      tone: 'error',
      retryable: true,
      resume: true,
    }]
  }

  /* ── turn_end 收尾：当前这条助手消息的流式光标停掉。 ── */
  if (type === 'turn_end') {
    const idx = findCurrentAssistant(list)
    if (idx < 0) return messages as ChatItem[]
    const copy = list.slice()
    const host = copy[idx] as Extract<ChatItem, { kind: 'assistant' }>
    copy[idx] = { ...host, streaming: false, reasoningStreaming: false }
    return copy
  }

  /* ── 引擎重发 / 截断：当前这条清空重来。 ── */
  if (type === 'stream_reset') {
    const idx = findCurrentAssistant(list)
    if (idx < 0) return messages as ChatItem[]
    const copy = list.slice()
    const host = copy[idx] as Extract<ChatItem, { kind: 'assistant' }>
    copy[idx] = { ...host, text: '', reasoning: '', reasoningStreaming: false }
    return copy
  }

  /* ── 排队中的插话标记 ── */
  if (type === 'message_queued') {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i]
      if (item.kind !== 'user') continue
      if (item.queued) return messages as ChatItem[]
      const copy = list.slice()
      copy[i] = { ...item, queued: true }
      return copy
    }
    return messages as ChatItem[]
  }
  if (type === 'queued_message_started') {
    return clearQueuedUserItems(list, str(ev.text) || undefined)
  }
  if (type === 'queue_cleared' || type === 'turn_interrupted') {
    return clearQueuedUserItems(list)
  }

  // 其它事件（usage_update / session_state / heartbeat / tool_approval_request / agent_cancelled…）
  // 不产生对话内容：原样返回（同一个引用）。
  return messages as ChatItem[]
}

/** 一批事件按到达顺序就地追加（32ms 合批提交用；seq 由调用方递增，保证条目 id 不撞）。 */
export function applyEventsToMessages(
  messages: readonly ChatItem[],
  events: readonly Ev[],
  startSeq = 0,
): ChatItem[] {
  let out: ChatItem[] = messages as ChatItem[]
  for (let i = 0; i < events.length; i += 1) {
    out = applyEventToMessages(out, events[i], { seq: startSeq + i })
  }
  return out
}

/** 折叠「同一条助手回复被画两遍」：连续两条 assistant 之间没有用户消息，
    且去空白后一份是另一份的前缀（实时流式版往往是引擎落库版的中间态），
    就当成同一条 —— 保留更长的那份。两份正文完全不同则原样保留（那是两条真回复）。
    典型现场：界面出现两条「我是 Coomi」，其中一份还停在乱序的中间态。 */
export function collapseAssistantCopies(messages: readonly ChatItem[]): ChatItem[] {
  const out: ChatItem[] = []
  let changed = false
  for (const item of messages) {
    const prev = out[out.length - 1]
    if (item.kind === 'assistant' && prev && prev.kind === 'assistant') {
      const x = prev.text.replace(/\s+/g, '')
      const y = item.text.replace(/\s+/g, '')
      const sameMsg = prev.msgId && item.msgId ? prev.msgId === item.msgId : true
      const nested = Boolean(x) && Boolean(y) && (x.startsWith(y) || y.startsWith(x))
      if (sameMsg && nested) {
        // 保留更长的那份；顺序段/工具调用并集（短的可能是还没接到工具段的那一份）。
        const longer = prev.text.length >= item.text.length ? prev : item
        const shorter = longer === prev ? item : prev
        changed = true
        out[out.length - 1] = {
          ...longer,
          msgId: longer.msgId ?? shorter.msgId,
          // 思考也要并集：以前只取"更长那份"的字段，若它没有思考，思考就凭空消失了。
          reasoning: longer.reasoning || shorter.reasoning,
          tools: longer.tools.length ? longer.tools : shorter.tools,
          segments: longer.segments?.length ? longer.segments : shorter.segments,
          streaming: false,
        }
        continue
      }
    }
    out.push(item)
  }
  return changed ? out : (messages as ChatItem[])
}

/** 摘掉「排队中」标记：
    · text 给定 → 优先摘正文一致的那一条（引擎报告某条排队消息开始执行）；
    · text 省略 → 全部摘掉（引擎清空了队列）。

    **2026-09-28 修复（真机事故：用户消息与回复错位 / 思考「消失」）**：
    以前 text 只是"完全相等"才摘——只要正文有一字之差（技能前缀、引用改写、空白差异），
    标记就永远摘不掉。而 findCurrentAssistant 会**跳过**带排队标记的用户条目，
    于是新一轮的正文与思考被追加到**上一轮的助手条目**上：界面表现为
    「我发的问题和它的回答对不上」，思考也看着像丢了。
    现在：正文匹配不上时**按队列顺序摘最早那一条**（引擎的语义就是"下一条排队消息开跑了"）。
    只复制被改动的那几条，没标记的条目原样返回（保持引用稳定，少一次重渲染）。 */
export function clearQueuedUserItems(messages: readonly ChatItem[], text?: string): ChatItem[] {
  const list = messages as ChatItem[]
  const key = text?.trim()
  // 先按正文找：命中了就摘它。
  let target = -1
  if (key) {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i]
      if (item.kind === 'user' && item.queued && item.text.trim() === key) { target = i; break }
    }
  }
  // 正文对不上（或没给正文）：摘**最早**的那条排队消息 —— 它就是引擎说的"这一条开始执行了"。
  if (target < 0 && key) {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i]
      if (item.kind === 'user' && item.queued) { target = i; break }
    }
  }
  if (!key) return clearAllQueued(list)
  if (target < 0) return list
  const out = list.slice()
  const item = out[target] as Extract<ChatItem, { kind: 'user' }>
  out[target] = { ...item, queued: false }
  return out
}

/** 全部摘掉排队标记（引擎清空队列 / 打断时用）。 */
function clearAllQueued(list: ChatItem[]): ChatItem[] {
  let changed = false
  const out = list.map((item) => {
    if (item.kind !== 'user' || !item.queued) return item
    changed = true
    return { ...item, queued: false }
  })
  return changed ? out : list
}

/** 一条本地条目，历史里有没有「同一条逻辑消息」覆盖它：
    · id 相同（引擎消息 id 认领过）→ 覆盖；
    · 用户消息：正文完全一致 → 覆盖（乐观条目与引擎真身是同一句）；
    · 助手消息：正文一致，或历史那份**不短**且以本地这份开头（历史更长＝更完整）→ 覆盖；
    · notice / ask 历史里没有对应物，一律不算覆盖（本地保留）。 */
function findCover(incoming: ChatItem[], item: ChatItem): ChatItem | undefined {
  for (const h of incoming) {
    if (h.id && h.id === item.id) return h
    if (h.kind === 'user' && item.kind === 'user') {
      if (h.text === item.text) return h
      continue
    }
    if (h.kind === 'assistant' && item.kind === 'assistant') {
      const ht = h.text.trim()
      const it = item.text.trim()
      if (!it || !ht) continue
      if (ht === it) return h
      // 前缀规则**只在两家是同一条消息（msgId 相同）时**才作数。
      // 以前不要求同 id：历史里任何一条更长的、恰好以本地正文开头的消息（压缩摘要就是这样）
      // 都会把本地这条判成「已被覆盖」→ 丢掉 —— 用户看到的就是「我发的消息没了」。
      if (h.msgId && item.msgId && h.msgId === item.msgId && ht.length >= it.length && ht.startsWith(it)) return h
      continue
    }
  }
  return undefined
}


export interface HistoryMergeOptions {
  /** true = 完全以引擎这次回读的结果为准，不保留任何旧条目（截断重发 / 重新生成）。 */
  replace?: boolean
}

/**
 * 历史回读合并（**唯一**入口；打开 / 切换会话与一轮结束后的回读都走它）。
 *
 * 规则只有两条：
 *   · **历史是权威**：被它覆盖的本地条目**整体换成历史的版本**（消息 id / 工具结果 / 思考
 *     以引擎为准 —— 这就是「同 id 元数据补齐」，不做任何正文合并）；
 *   · **历史还没有的本地条目一律保留**：刚发出去还没落库的用户消息、还在流式的回复、
 *     本地提示条 / 提问卡，都跟在历史后面 —— 回读滞后绝不丢字。
 * 边界兜底：历史只落了「最后一条助手正文的前一半」（回读赶在落库之前）时，
 * 用本地更长的正文补上（不重复成条、一个字不丢）。
 * `replace` 只给「引擎侧真的删过内容」（截断重发 / 重新生成）用：完全以回读结果为准。
 */
export function applyHistoryItems(
  local: readonly ChatItem[],
  incoming: readonly ChatItem[],
  options?: { replace?: boolean },
): ChatItem[] {
  const cur = local as ChatItem[]
  const next = incoming as ChatItem[]
  if (options?.replace) return next
  if (!cur.length) return next
  if (!next.length) return cur   // 读回空 / 失败：绝不清空已有内容

  // 先把「引擎已落库那一轮」的本地流式助手副本作废（根治两条回复 / 乱码回复），
  // 同时收下它给出的「作废副本 → 接管它的历史条目」id 转移表（见下）。
  const claimedId = new Map<string, string>()
  const live = dropPersistedAssistantCopies(cur, next, claimedId)
  const out = next.slice()
  const tail: ChatItem[] = []
  /* 认领时**保留本地条目的 id**：把命中它的那条历史条目的 id 换成本地 id（引擎 id 记进 msgId）。
     为什么要这么做 —— 这是「回复变暗淡 / 我发的消息消失 / 切回旧会话像又输出了一遍」的根因：
       · 历史回读把本地临时 id（u7 / e8）换成引擎 msgId 时，React 的 key 变了 → **整行卸载重挂**；
       · 重挂会重新播入场动画（initial: opacity 0），动画没跑完就停在半透明甚至全透明上 ——
         用户看到的就是「我的消息不见了（opacity 0）」「回复暗淡（停在半路）」，切一下会话重挂一次
         动画正好跑完，于是「切会话就好了」；
       · id 稳定之后 markItemsSeen 也认得它，入场动画根本不会再播。
     只换 id，正文 / 工具 / 思考 / msgId 依旧以历史（引擎）为准。 */
  const claimedTargets = new Set<string>(claimedId.keys())
  /* 思考补位：历史那条助手**没有思考**、而本地那条有（引擎有时只在流式里给、落库没带）时，
     把本地这份思考补给历史条目。以前换过去就没了 —— 用户看到的是「思考过程消失」。 */
  const rescuedReasoning = new Map<string, string>()
  for (const item of live) {
    const cover = findCover(next, item)
    if (cover) {
      if (cover.id !== item.id && !claimedTargets.has(cover.id)) {
        claimedTargets.add(cover.id)
        claimedId.set(cover.id, item.id)
      }
      if (cover.kind === 'assistant' && item.kind === 'assistant') {
        const from = (item.reasoning ?? '').trim()
        const to = (cover.reasoning ?? '').trim()
        if (from.length > to.length) rescuedReasoning.set(cover.id, item.reasoning ?? '')
      }
      continue
    }
    tail.push(item)
  }
  // 「回合级对账」作废掉的那份流式副本可能也带着思考（引擎落库有时不带）：
  // claimedId 记的正是「历史条目 ← 本地副本」，照着反查一遍把思考救回来。
  for (const [targetId, localId] of claimedId) {
    const source = cur.find((it) => it.id === localId)
    const target = next.find((it) => it.id === targetId)
    if (!source || !target || source.kind !== 'assistant' || target.kind !== 'assistant') continue
    const from = (source.reasoning ?? '').trim()
    const to = (target.reasoning ?? '').trim()
    if (from.length > to.length) rescuedReasoning.set(targetId, source.reasoning ?? '')
  }
  if (claimedId.size || rescuedReasoning.size) {
    for (let i = 0; i < out.length; i += 1) {
      const key = out[i].id
      const transfer = claimedId.get(key)
      const reasoning = rescuedReasoning.get(key)
      if (!transfer && !reasoning) continue
      out[i] = {
        ...out[i],
        ...(transfer ? { id: transfer } : {}),
        ...(reasoning ? { reasoning } : {}),
      }
    }
  }

  // 边界兜底：历史最后一条助手只落了前半段正文 → 本地更长的补上去。
  const lastHist = out[out.length - 1]
  const lastLocal = tail[tail.length - 1]
  if (lastHist && lastLocal && lastHist.kind === 'assistant' && lastLocal.kind === 'assistant') {
    const histText = lastHist.text.trim()
    const localText = lastLocal.text.trim()
    if (histText && localText.length > histText.length && localText.startsWith(histText)) {
      out[out.length - 1] = {
        ...lastHist,
        text: lastLocal.text,
        segments: lastHist.segments ?? lastLocal.segments,
      }
      tail.pop()
    }
  }

  // 空正文救援：历史把这一轮落了库，但落成了一条**空助手**（没有工具、没有正文），
  // 而本地还留着这一轮唯一的正文副本 —— 那就把本地正文认领到历史那一条上（保留引擎 id），
  // 而不是让「一条空的 + 一条本地的」两条并存。仅在这三条同时成立时动手：
  //   · 历史最后一条是助手、正文为空、且**没有工具调用**（有工具的是工具步骤，不能塞正文）；
  //   · 本地尾部恰好只有一条有正文、且还没被引擎认领（无 msgId）的助手条目。
  const lastHistIdx = out.length - 1
  const emptyHist = out[lastHistIdx]
  if (emptyHist && emptyHist.kind === 'assistant' && !emptyHist.text.trim() && !emptyHist.tools.length) {
    const cands = tail.filter((it) => it.kind === 'assistant' && it.text.trim() && !it.msgId)
    const rescue = cands.length === 1 ? cands[0] : null
    if (rescue && rescue.kind === 'assistant') {
      out[lastHistIdx] = {
        ...emptyHist,
        text: rescue.text,
        reasoning: emptyHist.reasoning || rescue.reasoning,
        segments: emptyHist.segments?.length ? emptyHist.segments : rescue.segments,
      }
      tail.splice(tail.indexOf(rescue), 1)
    }
  }

  if (!tail.length) return out
  return [...out, ...tail]
}

/** 回合级对账：引擎已经把「最后一轮」落库了，本地那一轮还没落库（没有 msgId）的助手副本一律作废。
 *
 *  为什么必须在这里做：流式过程中的本地副本是**中间态** —— 可能错序、可能只到一半（实测出现过
 *  「收到 ✓ 输入法。测试 484 已送达」，而引擎落库的是「收到 ✓ 输入法测试 484 已送达。」）。
 *  正文比对（isCoveredByHistory）在这种错序面前必然对不上，于是两份都留在列表里：
 *  界面上就是「同一条回复画两遍 / 出现乱码回复」，而且那份乱码永远不会被替换掉。
 *
 *  安全边界（三者同时满足才作废）：
 *   ① 历史里有**同正文**的用户消息（＝这一轮引擎确实收到了）；
 *   ② 历史里这条用户消息**之后有非空助手正文**（＝引擎确实把这一轮写完了）；
 *   ③ 本地尾部里**没有**带 msgId 的助手条目（带 id 的交给正常覆盖规则，不在这里动）。
 *  只作废助手副本：提问卡 / 提示条 / 排队中的用户消息一律保留（它们可能是引擎还没落库的东西）。
 */
export /** 两份助手正文是不是「同一句话」——按字符多重集比对，允许错序但内容基本一致。
 *
 *  为什么需要它：错序副本（「收到 ✓ 输入法。测试 484 已送达」vs「…输入法测试 484 已送达。」）
 *  用前缀/相等都比不出来，但它们**用的是同一批字符**，重合度极高（实测 >0.9）。
 *  反过来，用户重复发同一句话时（「继续」「好的」），历史里能匹配到**上一轮**那句同样的用户消息，
 *  而这一轮刚流出来的回复与上一轮的回复内容毫无重合 —— 这一道闸门就不会误删它。
 */
function similarAssistantText(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, '')
  const y = b.replace(/\s+/g, '')
  if (!x || !y) return false
  if (Math.max(x.length, y.length) > Math.min(x.length, y.length) * 1.6 + 6) return false
  const pool = new Map<string, number>()
  for (const ch of y) pool.set(ch, (pool.get(ch) ?? 0) + 1)
  let hit = 0
  for (const ch of x) {
    const n = pool.get(ch) ?? 0
    if (n > 0) { pool.set(ch, n - 1); hit += 1 }
  }
  return hit / x.length >= 0.8
}

export function reconcilePersistedTurn(
  local: ChatItem[],
  history: ChatItem[],
): { live: ChatItem[]; transfers: Map<string, string> } {
  const transfers = new Map<string, string>()
  const live = dropPersistedAssistantCopies(local, history, transfers)
  return { live, transfers }
}

export function dropPersistedAssistantCopies(
  local: ChatItem[],
  history: ChatItem[],
  transfers: Map<string, string> = new Map(),
): ChatItem[] {
  if (!local.length || !history.length) return local
  let lastUser = -1
  for (let i = local.length - 1; i >= 0; i -= 1) {
    if (local[i].kind === 'user') { lastUser = i; break }
  }
  if (lastUser < 0) return local
  const anchor = local[lastUser]
  if (anchor.kind !== 'user') return local
  const text = anchor.text.trim()
  if (!text) return local
  let histUser = -1
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i]
    if (h.kind === 'user' && h.text.trim() === text) { histUser = i; break }
  }
  if (histUser < 0) return local
  const turnAssistants = history
    .slice(histUser + 1)
    .filter((h): h is Extract<ChatItem, { kind: 'assistant' }> => h.kind === 'assistant' && h.text.trim().length > 0)
  if (!turnAssistants.length) return local
  const tail = local.slice(lastUser + 1)
  if (!tail.length) return local
  if (tail.some((it) => it.kind === 'assistant' && it.msgId)) return local
  if (!tail.some((it) => it.kind === 'assistant')) return local
  // 只作废「与引擎那一条同内容但错序/残缺」的副本：正文毫无重合的（例如用户重复问同一句话时，
  // 匹配到的是上一轮那句同样的用户消息）一律保留 —— 宁可多留一条，绝不误删新一轮的回复。
  let dropped = false
  const kept = tail.filter((it) => {
    if (it.kind !== 'assistant') return true
    const match = turnAssistants.find((h) => similarAssistantText(it.text, h.text))
    if (match) {
      // 作废的是内容，**不是身份**：把这条本地副本的 id 交给接管它的历史条目，
      // 否则 React 的 key 会从本地临时 id（e8）换成引擎 id（uuid）→ 整行重挂 →
      // 入场动画又从 opacity:0 开始（用户看到的「消息不见了 / 回复暗淡」就是这个）。
      if (match.id !== it.id) transfers.set(match.id, it.id)
      dropped = true
      return false
    }
    return true
  })
  return dropped ? [...local.slice(0, lastUser + 1), ...kept] : local
}

/** 窗口切片：消息列表只渲染最后 `size` 条；「加载更早」把 size 增大一档（每次 +60）。 */
export function chatWindowTail(items: readonly ChatItem[], size: number): ChatItem[] {
  const list = items as ChatItem[]
  if (list.length <= size) return list
  return list.slice(list.length - size)
}

/* ── 入场动画的「已见」登记 ──
   条目 id 与工具调用 id 各占一个命名空间：**已见**的条目重新挂载时（切会话、
   窗口切片换内容）一律不播入场，只有真正新增的条目 / 新增的工具行才播。 */

/** 工具行在「已见」集合里的键（与消息 id 分开命名空间，避免撞号）。 */
export function toolSeenKey(callId: string): string { return 'tool:' + callId }

/** 把这一屏条目连同它们的工具调用一起登记为已见。 */
export function markItemsSeen(seen: Set<string>, items: ChatItem[]): void {
  for (const item of items) {
    seen.add(item.id)
    if (item.kind !== 'assistant') continue
    for (const tool of item.tools) if (tool.callId) seen.add(toolSeenKey(tool.callId))
  }
}

/** 分组键（会话 id + 该会话历史是否回读完成）一变＝切了会话，或切过去之后历史到位：
    把当前这一屏全部登记为已见。返回新的分组键（没变就原样返回，不重复登记）。 */
export function markGroupSeen(seen: Set<string>, prevGroup: string, nextGroup: string, items: ChatItem[]): string {
  if (prevGroup === nextGroup) return prevGroup
  markItemsSeen(seen, items)
  return nextGroup
}

/* ── 本轮耗时的可信口径 ──
   只承认两种口径：
   ① 引擎在 turn_end 里给的本轮耗时（以及它给的首 token 延迟）；
   ② 退化口径：本轮「首 token → 末 token」的本地窗口（不含排队与重启）。
   越界（<0 或 >1 小时）一律判为 null，界面显示「—」。 */

/** 耗时的上限：超过一小时的一轮必然走了「挂起 / 重启」之类的路径，不可信。 */
export const TURN_MS_MAX = 3_600_000

/** 把任意来源的毫秒耗时裁到合法区间；越界 / 非数字一律 null。 */
export function validTurnMs(value: unknown): number | null {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value)
      : Number.NaN
  if (!Number.isFinite(n) || n < 0 || n > TURN_MS_MAX) return null
  return Math.round(n)
}

/** 「首 token → 末 token」窗口：两个打点都在、顺序正确才有意义。 */
export function tokenWindowMs(firstAt: number, lastAt: number): number | null {
  if (!firstAt || !lastAt) return null
  return validTurnMs(lastAt - firstAt)
}

type TimedField = readonly [key: string, scale: number]

/** 引擎字段候选：不同版本 / 不同上游叫法不一。带 _ms 的是毫秒，
    裸 elapsed / duration 按秒（与工具事件的同一套约定）。 */
const DURATION_FIELDS: readonly TimedField[] = [
  ['elapsed_ms', 1], ['duration_ms', 1], ['turn_ms', 1], ['turn_elapsed_ms', 1], ['total_ms', 1],
  ['elapsed', 1_000], ['duration', 1_000], ['elapsed_s', 1_000], ['elapsed_seconds', 1_000],
]

const FIRST_TOKEN_FIELDS: readonly TimedField[] = [
  ['first_token_latency_ms', 1], ['first_token_ms', 1],
  ['first_token_latency', 1_000], ['first_token_latency_s', 1_000],
]

function pickTimed(source: Record<string, any> | undefined, fields: readonly TimedField[]): number | null {
  if (!source) return null
  for (const [key, scale] of fields) {
    const raw = source[key]
    if (typeof raw !== 'number' && typeof raw !== 'string') continue
    const hit = validTurnMs((typeof raw === 'number' ? raw : Number(raw)) * scale)
    if (hit != null) return hit
  }
  return null
}

/** 引擎在 turn_end（或它带上的 usage）里给的本轮耗时。 */
export function turnDurationFromEvent(ev: Record<string, any> | null | undefined): number | null {
  return pickTimed(ev ?? undefined, DURATION_FIELDS) ?? pickTimed(ev?.usage, DURATION_FIELDS)
}

/** 引擎在 turn_end（或它带上的 usage）里给的首 token 延迟。 */
export function firstTokenFromEvent(ev: Record<string, any> | null | undefined): number | null {
  return pickTimed(ev ?? undefined, FIRST_TOKEN_FIELDS) ?? pickTimed(ev?.usage, FIRST_TOKEN_FIELDS)
}

/** 会话标题：优先手动标题，其次首条用户消息，最后兜底。 */
export function deriveTitle(items: ChatItem[], fallback = '新对话'): string {
  const first = items.find((i) => i.kind === 'user')
  if (!first || first.kind !== 'user') return fallback
  const line = first.text.split('\n')[0].trim()
  return line.length > 24 ? line.slice(0, 24) + '…' : line || fallback
}
