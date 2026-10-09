/**
 * 子智能体列表的数据来源（全部来自引擎，没有任何造出来的条目）：
 * 1. GET /api/settings/subagents —— 已配置的子智能体（id / providerId / model / description），
 *    用来把 spawn_agent 的 sub_agent_id 还原成可读名称与模型。
 * 2. 当前对话里的工具调用：spawn_agent / wait_agent / close_agent
 *    （引擎实现见 apps/coomi-rs/tools/src/lib.rs，调度器见 tools/src/agents.rs）。
 *    wait_agent / close_agent 的结果就是引擎 AgentSnapshot 的 JSON：
 *    { id, status, task, output, elapsed_ms }，状态词表 running / completed / failed
 *    由引擎给出，前端只做映射，不自己编状态。
 */
import type { ChatItem } from '../../lib/chat'

/** GET /api/settings/subagents 的一项（SubAgentSettings.agents，引擎用 camelCase 序列化）。 */
export interface ConfiguredSubagent {
  id?: string
  providerId?: string
  model?: string
  description?: string
}

/* ── 子智能体对话详情（GET /api/agents/{id}/messages）──
   引擎侧已实现的只读接口：返回某个子智能体的完整对话记录。
   详情视图只在用户点开某条时按 id 拉取；面板概览仍走上面的 deriveSubagents
   （派生数据拿不到完整对话，只有快照里的 task / output / elapsed_ms）。 */

/** assistant 消息里的一条工具调用（tools 字段的项）。 */
export interface SubagentMessageTool {
  /** 引擎给的工具调用 id（渲染 key 用）。 */
  id: string
  /** 工具名（如 read_file / spawn_agent）。 */
  name: string
  /** 调用参数：引擎序列化好的 JSON 字符串，原样展示、不做二次解析。 */
  arguments: string
}

/** 一条消息的角色：引擎按对话顺序给出，前端只按角色映射渲染、不改顺序。 */
export type SubagentMessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** 详情接口里的一条消息。 */
export interface SubagentMessage {
  role: SubagentMessageRole
  /** 正文（user / assistant / tool 都有；system 一般是提示词等元信息）。 */
  content: string
  /** 思考内容：引擎只在非空时给这个字段（没有就是 undefined，不渲染折叠块）。 */
  reasoning?: string
  /** 该轮的工具调用列表：引擎只在非空时给（没有就是 undefined，不渲染工具行）。 */
  tools?: SubagentMessageTool[]
}

/** GET /api/agents/{id}/messages 的 200 响应体（字段名沿用引擎口径，snake_case）。 */
export interface SubagentDetail {
  id: string
  status: string
  task: string
  /** 最终输出：非空时在对话末尾单独展示。 */
  output: string
  /** 引擎计时的耗时（毫秒，数字；没跑完时可能不准确，展示时以它为准）。 */
  elapsed_ms: number
  /** 完整对话流：按顺序渲染，详情视图不改顺序。 */
  messages: SubagentMessage[]
}

export type SubagentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'closed'

export interface SubagentEntry {
  /** 引擎给的 agent id（spawn_agent 的返回值）；还没拿到时用工具调用 id 占位。 */
  id: string
  name: string
  /** spawn_agent 参数里的 sub_agent_id，对应 /api/settings/subagents 的配置项。 */
  configuredId: string
  /** 配置里的「providerId / model」，没配就是空串。 */
  model: string
  task: string
  status: SubagentStatus
  /** 引擎快照里的 elapsed_ms；拿不到就是 null（不猜耗时）。 */
  elapsedMs: number | null
  /** 最近输出：优先引擎快照的 output，其次工具结果预览。 */
  output: string
  /** 观测到的派发时间（本地时钟，只用于「运行中」的计时）。 */
  startedAt: number | null
  /** 该条目的状态是否已被引擎快照确认过（快照权威，不再被 spawn 的调用状态改写）。 */
  fromSnapshot: boolean
}

/** spawn_agent 的常见别名（引擎在 tools/src/lib.rs 里归一化，这里按原样认）。 */
const SPAWN_TOOLS = new Set(['spawn_agent', 'start_agent', 'run_agent', 'delegate', 'delegate_agent', 'spawn_subagent', 'agent', 'subagent'])
const WAIT_TOOLS = new Set(['wait_agent', 'wait_subagent'])
const CLOSE_TOOLS = new Set(['close_agent', 'close_subagent', 'kill_agent'])
/** 单条输出最多留这么多字符：子智能体的输出可能是几万字，全塞进 DOM 会卡。 */
const MAX_OUTPUT = 4000

function parseJsonObject(text: string): Record<string, any> {
  if (!text) return {}
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
  } catch { return {} }
}

/** 从工具结果里取引擎的 AgentSnapshot（wait_agent 是数组，close_agent 是单个对象）。 */
function snapshotsFrom(text: string): Array<Record<string, any>> {
  if (!text) return []
  const candidates: string[] = []
  const arrayStart = text.indexOf('[')
  const arrayEnd = text.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(text.slice(arrayStart, arrayEnd + 1))
  const objStart = text.indexOf('{')
  const objEnd = text.lastIndexOf('}')
  if (objStart >= 0 && objEnd > objStart) candidates.push('[' + text.slice(objStart, objEnd + 1) + ']')
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is Record<string, any> => !!item && typeof item === 'object')
      }
    } catch { /* 不是 JSON（错误信息或普通文本）就换下一种，全都不行就当没有快照 */ }
  }
  return []
}

/** spawn_agent 的结果是 "success: agent_id: <uuid>"。 */
function agentIdFrom(text: string): string {
  const hit = /agent_id[:：]\s*([A-Za-z0-9_-]+)/.exec(text ?? '')
  return hit ? hit[1] : ''
}

/** 引擎 elapsed_ms 是字符串形式的毫秒。 */
function toMs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

function mapStatus(raw: string): SubagentStatus {
  switch (raw) {
    case 'completed': case 'done': case 'success': return 'completed'
    case 'failed': case 'error': return 'failed'
    case 'closed': case 'cancelled': case 'canceled': return 'closed'
    // 引擎目前只发 running/completed/failed；未知状态按「还活着」显示，等下一次快照修正。
    default: return 'running'
  }
}

function shortId(id: string): string {
  const raw = id.startsWith('call:') ? id.slice(5) : id
  return raw.length > 8 ? raw.slice(0, 8) : raw
}

function assign(entry: SubagentEntry, patch: Partial<SubagentEntry>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (entry as unknown as Record<string, unknown>)[key] = value
  }
}

/** 把对话条目折成子智能体列表（按首次出现顺序）。没有子智能体时返回空数组，界面整块隐藏。
 *  `observedAt` 由调用方提供并自己记住返回值：每次渲染都会重折一遍，
 *  计时起点必须放在组件那边（useRef）才稳定，否则「已运行」永远显示 0 秒。 */
export function deriveSubagents(
  items: ChatItem[],
  configured: ConfiguredSubagent[],
  observedAt: (id: string) => number,
): SubagentEntry[] {
  const configById = new Map<string, ConfiguredSubagent>()
  for (const entry of configured ?? []) {
    if (entry?.id) configById.set(String(entry.id), entry)
  }
  const byId = new Map<string, SubagentEntry>()
  const order: string[] = []

  const ensure = (id: string, patch?: Partial<SubagentEntry>): SubagentEntry => {
    let entry = byId.get(id)
    if (!entry) {
      entry = {
        id, name: '', configuredId: '', model: '', task: '', status: 'starting',
        elapsedMs: null, output: '', startedAt: null, fromSnapshot: false,
      }
      byId.set(id, entry)
      order.push(id)
    }
    if (patch) assign(entry, patch)
    // 名称/模型每次都按最新配置解析（配置是异步取回来的，可能晚于第一条条目）。
    const config = entry.configuredId ? configById.get(entry.configuredId) : undefined
    entry.name = config?.description?.trim() || config?.id || ('子智能体 ' + shortId(entry.id))
    entry.model = config ? [config.providerId, config.model].filter(Boolean).join(' / ') : ''
    return entry
  }

  for (const item of items) {
    if (item.kind !== 'assistant') continue
    const at = typeof item.at === 'number' ? item.at : null
    for (const tool of item.tools) {
      const name = String(tool.name ?? '').toLowerCase()
      if (SPAWN_TOOLS.has(name)) {
        const args = parseJsonObject(tool.args)
        const configuredId = typeof args.sub_agent_id === 'string' ? args.sub_agent_id
          : typeof args.subAgentId === 'string' ? args.subAgentId : ''
        const task = typeof args.task === 'string' ? args.task.trim() : ''
        const resolved = agentIdFrom(tool.preview ?? '')
        const agentId = resolved || ('call:' + tool.callId)
        // 同一个派发调用先以占位 key 出现、拿到 agent_id 后再以真实 id 出现时，
        // 占位条目要被真实条目取代，不能两条都留在列表里。
        if (resolved) byId.delete('call:' + tool.callId)
        const entry = ensure(agentId, {
          configuredId: configuredId || undefined,
          task: task || undefined,
        })
        // 历史消息带 at_ms，能拿到真实派发时间；实时事件没有时间戳，
        // 就用「第一次在界面上看到它」的时刻起算（诚实：这是观测时间，不是引擎时间）。
        if (entry.startedAt === null) entry.startedAt = at ?? observedAt(agentId)
        // 快照（wait_agent / close_agent）是权威状态，晚到的 spawn 调用状态不能覆盖它。
        if (!entry.fromSnapshot) {
          const status: SubagentStatus =
            tool.status === 'error' || tool.status === 'denied' ? 'failed'
              : tool.status === 'running' || tool.status === 'queued' ? 'starting'
                : 'running'
          entry.status = status
        }
        continue
      }
      if (WAIT_TOOLS.has(name) || CLOSE_TOOLS.has(name)) {
        const snapshots = snapshotsFrom(tool.preview ?? '')
        for (const snapshot of snapshots) {
          const id = typeof snapshot.id === 'string' ? snapshot.id : ''
          if (!id) continue
          const entry = ensure(id)
          const fromEngine = typeof snapshot.status === 'string' ? mapStatus(snapshot.status) : entry.status
          assign(entry, {
            task: typeof snapshot.task === 'string' ? snapshot.task : undefined,
            output: typeof snapshot.output === 'string' ? snapshot.output.slice(-MAX_OUTPUT) : undefined,
            elapsedMs: toMs(snapshot.elapsed_ms) ?? undefined,
            status: CLOSE_TOOLS.has(name) && tool.status === 'done' ? 'closed' : fromEngine,
            fromSnapshot: true,
          })
          if (entry.startedAt === null) entry.startedAt = at ?? observedAt(id)
        }
      }
    }
  }

  const entries: SubagentEntry[] = []
  for (const id of order) {
    const entry = byId.get(id)
    if (entry) entries.push(entry)
  }
  return entries
}

/** 是否还在跑（用于计数与实时计时）。 */
export function isLive(entry: SubagentEntry): boolean {
  return entry.status === 'running' || entry.status === 'starting'
}
