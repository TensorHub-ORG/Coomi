/**
 * 事件流的**唯一写入口**（纯逻辑，浏览器与 node 用的是同一份）。
 *
 * 症状：发消息后「AI 正在回复 / 刚回复完」的那条在界面上直接消失，切走再切回来又好了
 * （引擎里数据一直在）。事件数组被多个路径各写各的，是这类「凭空消失」的温床：
 *   · 32ms 合批里捕获一份旧的 events 再拼缓冲，会把窗口期里其它路径追加的事件整段覆盖；
 *   · turn_end 的异步回读 / 看门狗 / 重连回头清 events 时，忘了校验「我这一轮是不是已经过去了」，
 *     于是新一轮刚收到的事件被上一轮的收尾逻辑抹掉；
 *   · 清空的形态是 events: []，而不是「只过滤掉历史已经确认落库的那部分」。
 *
 * 这里把它收成一台有状态的小机器（createEventPort），规则三条：
 *   ① 所有追加统一走 commit(batch)：**永远基于最新状态**拼新数组，禁止「闭包里的旧 events + 缓冲」；
 *      缓冲只放未提交事件，提交即清空；
 *   ② 整体替换只允许两种：切会话（换缓存）与截断重发（引擎侧真的删了）；
 *      清理一律走 prune（确认制过滤，绝不清空）；
 *      越界（候选变长 / 把非空清成空）**不抛错**：按 current 收敛（超长截掉、清空补回来）
 *      并记进 violations() —— 抛进 React 渲染路径就是整屏白，宁可少落一次写，也不带走界面；
 *   ③ 异步回调动事件之前先问 isCurrent(seq)（轮次序号由 send() 递增），过期的整段作废。
 *
 * 这一层**零依赖**：不 import 任何东西（连 lib/chat 都不 import），所以能直接 node 跑，
 * 也能被 stores/session.ts 内联使用而不用把 DOM / React 拖进来。
 */

export type EventRecord = Record<string, any>

/** 一次写入的记账：runEventPortAudit 用它验收「只有一个写入口」这条规矩。
    id 是**写入序号**（从 1 开始）：审计按序号对账，写入与快照永远一一对应 ——
    少记一次就当场报错，绝不靠「数组下标碰巧对齐」蒙过去。 */
export interface EventWrite {
  id: number
  sessionId: string
  /** append ＝ 统一入口的追加（永远基于最新状态，只增不减）；
      prune ＝ 确认制清理（只减已落库的那部分，绝不清空）；
      replace ＝ 整体替换（只允许「换缓存（切换会话）」与「截断重发」两条路径）。 */
  stage: 'append' | 'prune' | 'replace'
  /** 调用方给的写入标签（诊断用）。 */
  label: string
  /** 这一次写入之后事件数组的长度。 */
  size: number
}

/** 写入口的一次观测：写入之前的长度、之后的长度、以及这次写入本身。 */
export interface EventWriteObservation {
  write: EventWrite
  /** 写入之前的事件数组长度。 */
  before: number
  /** 写入之后的事件数组（快照，按值拷出来）。 */
  after: EventRecord[]
}

/** 越界形态：grow＝候选比当前状态长（会把别处追加的事件覆盖掉）；clear＝把非空数组清成空；
    threw＝updater 自己抛了；invalid＝updater 没返回数组。 */
export type EventPortViolationKind = 'grow' | 'clear' | 'threw' | 'invalid'

/** 一次越界写入的记账。写入口**不抛错**，越界只落在这里（＋可选回调 onViolation）。 */
export interface EventPortViolation {
  kind: EventPortViolationKind
  /** 调用方给的写入标签（诊断用）。 */
  label: string
  sessionId: string
  /** 越界那一刻写入口里的长度（＝唯一真值）。 */
  before: number
  /** 候选数组的长度：越界时它**没被采纳**，实际落库的仍是 before 那一份。 */
  candidate: number
  detail: string
  at: number
}

/** 新建写入口的可选项：onWrite 是唯一写入观测点；onViolation / warn 是越界的两个出口。 */
export interface EventPortOptions {
  /** 写入观测点：测试桩用它记流水（含写入前后的长度），「写了几次」与「记了几条」永远对得上。 */
  onWrite?: (observation: EventWriteObservation) => void
  /** 越界回调（可选）：越界本身就记进 violations()，这里只是给调用方一个主动处理的出口。 */
  onViolation?: (violation: EventPortViolation) => void
  /** 越界日志出口，默认 console.warn（同一个 label 只完整报一次）；传 null 静默。 */
  warn?: ((message: string, violation: EventPortViolation) => void) | null
  /** 越界留存的条数上限（默认 50），只留最近的那些。 */
  violationLimit?: number
  /** 时钟（断言里喂固定值，默认 Date.now）。 */
  now?: () => number
}

/** 事件流的写入口：store 与测试桩共用同一份实现。 */
export interface EventPort {
  /** 当前事件数组（最新状态，永远读这里，不做闭包快照）。 */
  events(): EventRecord[]
  /** 追加一批事件：**永远基于最新状态**拼新数组（禁止「闭包里的旧 events + 缓冲」）。 */
  commit(batch: readonly EventRecord[], sessionId?: string, label?: string): EventRecord[]
  /** 确认制清理：把**当前状态**交给 updater 算出下一份，**只允许更短、绝不允许清空**。
      越界（更长 / 清空 / updater 抛错 / 没返回数组）**不抛错**：按 current 收敛 ——
      超长的截掉、清空的补回来，实际落库的仍是 current，并记进 violations()。 */
  commitWith(updater: (current: readonly EventRecord[]) => readonly EventRecord[], sessionId?: string, label?: string): EventRecord[]
  /** 整体替换（只给「换缓存（切换会话）」与「截断重发」两条路径用）。 */
  replace(next: readonly EventRecord[], sessionId: string, label: string): EventRecord[]
  /** 这台写入口现在跟的是哪个会话（切换会话＝replace 换缓存；别的会话的尾巴只写它自己的缓存）。 */
  sessionId(): string
  /** 写入记账（按写入顺序）。 */
  writes(): EventWrite[]
  /** 越界记账（最近 violationLimit 条）。它是**诊断**，不是错误队列：越界已经被安全收敛掉了。 */
  violations(): readonly EventPortViolation[]
  reset(): void
}

/** 新建一台写入口。同一会话的事件数组只能由它改写（切会话时用 replace 换一份）。
    options.onWrite 是**唯一**的写入观测点：测试桩用它记流水（含写入前后的长度），
    所以「写了几次」与「记了几条」永远对得上。 */
export function createEventPort(
  initial: readonly EventRecord[] = [],
  sessionId = '',
  options: EventPortOptions = {},
): EventPort {
  let current: EventRecord[] = [...initial]
  let sid = sessionId
  let log: EventWrite[] = []
  const violationLog: EventPortViolation[] = []
  const violationLimit = options.violationLimit && options.violationLimit > 0 ? options.violationLimit : 50
  const clock = options.now ?? (() => Date.now())
  const defaultWarn = (message: string, violation: EventPortViolation): void => {
    if (typeof console === 'undefined' || typeof console.warn !== 'function') return
    console.warn(message, violation)
  }
  const warn = options.warn === undefined ? defaultWarn : options.warn
  /** 已经完整报过的 label：越界若是高频（比如每次切会话都撞一次），日志本身也会变成雪崩。 */
  const warned = new Set<string>()

  /** 记一次越界：只记账 + 记日志，**绝不抛错**（这一层抛出去就是整屏白）。 */
  const overflow = (kind: EventPortViolationKind, label: string, before: number, candidate: number, detail: string): void => {
    let at = 0
    try { at = clock() } catch { at = 0 }
    const violation: EventPortViolation = { kind, label, sessionId: sid, before, candidate, detail, at }
    violationLog.push(violation)
    if (violationLog.length > violationLimit) violationLog.splice(0, violationLog.length - violationLimit)
    try { options.onViolation?.(violation) } catch { /* 回调失败不影响收敛 */ }
    if (warn && !warned.has(label)) {
      warned.add(label)
      try {
        warn('[eventPort] 越界写入已按当前状态收敛（' + kind + '·' + label + '）：' + detail, violation)
      } catch { /* 日志失败不影响主流程 */ }
    }
  }

  /** 把抛出物摘成一行可读文本（它自己抛错也不能影响收敛）。 */
  const reasonOf = (error: unknown): string => {
    try {
      if (error instanceof Error) return error.name + ': ' + error.message
      return String(error)
    } catch { return '无法读取的异常' }
  }

  const land = (next: readonly EventRecord[], stage: EventWrite['stage'], label: string): EventRecord[] => {
    const before = current.length
    current = [...next]
    const write: EventWrite = { id: log.length + 1, sessionId: sid, stage, label, size: current.length }
    log.push(write)
    options.onWrite?.({ write, before, after: current.map((e) => ({ ...e })) })
    return current
  }

  return {
    events: () => current,
    commit: (batch, nextSid, label) => {
      if (nextSid !== undefined) sid = nextSid
      if (!batch.length) return current
      // ① 永远基于最新状态：current 在这一刻读、下一刻换掉，中间没有第二次写入的机会。
      return land([...current, ...batch], 'append', label ?? '追加')
    },
    commitWith: (updater, nextSid, label) => {
      if (nextSid !== undefined) sid = nextSid
      const name = label ?? '确认制清理'
      let next: readonly EventRecord[]
      try {
        next = updater(current)
      } catch (error) {
        // updater 自己炸了（历史折叠 / 清理函数抛错）：保持当前状态不变、记账即可。
        // 以前这里会把异常一路甩进 React 渲染路径 —— 那就是整屏白。
        overflow('threw', name, current.length, current.length, 'updater 抛异常：' + reasonOf(error))
        return current
      }
      if (next === current) return current
      if (!Array.isArray(next)) {
        overflow('invalid', name, current.length, current.length, 'updater 没有返回数组（' + typeof next + '）')
        return current
      }
      /* 钳制在 current 上（确认制清理只允许更短、绝不允许清空）：
         · 候选更长 → 它是在拿一份过期/别人的快照覆盖当前状态，**按 current 截断**：
           越界的那一截不落库（写入口是唯一真值，谁也不能凭猜测往前加事件）；
         · 候选清空 → 内容不足，**按 current 补回来**，仍是原来那一份。
         两种情况都不抛错：少落一次写是小事，把界面带走是大事。 */
      if (next.length > current.length) {
        overflow('grow', name, current.length, next.length,
          '候选比当前状态长 ' + (next.length - current.length) + ' 条（' + current.length + ' → ' + next.length + '），越界部分不落库')
        return current
      }
      if (!next.length && current.length) {
        overflow('clear', name, current.length, 0, '候选把 ' + current.length + ' 条事件清成了空数组，按 current 补回')
        return current
      }
      return land(next, 'prune', name)
    },
    replace: (next, nextSid, label) => {
      sid = nextSid
      return land(next, 'replace', label)
    },
    sessionId: () => sid,
    writes: () => log,
    violations: () => violationLog,
    reset: () => { log = []; violationLog.length = 0; warned.clear() },
  }
}

/**
 * 写入口的验收：每次都必须是「基于最新状态的一次整体提交」。
 *
 * 输入是 onWrite 记下的**流水**（写入序号 + 写入前后）：
 *   · 流水必须连续无缺口（第 k 次写入的 id 就是 k）—— 少记一条说明有写入绕开了唯一入口；
 *   · append 只能让数组变长（或不变）—— 少了内容就说明某次提交拿着旧快照把别人的事件覆盖了；
 *   · prune（确认制清理）只能变短、且绝不清空；
 *   · replace 只允许出现在换缓存（会话切换）/ 截断重发这两条路径上；
 *   · before 必须等于上一条的 after —— 每次写入都接在最新状态上，中间没有第三方插入。
 */
export function runEventPortAudit(
  observations: readonly EventWriteObservation[],
  allowedReplaces = Number.POSITIVE_INFINITY,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  let replaces = 0
  let previous: EventRecord[] | null = null
  for (let i = 0; i < observations.length; i += 1) {
    const { write, before, after } = observations[i]
    if (write.id !== i + 1) reasons.push('写入流水有缺口：第 ' + (i + 1) + ' 条记的是 id=' + write.id)
    if (previous && before !== previous.length) {
      reasons.push('第 ' + write.id + ' 次写入没有接在上一次的结果上：' + before + ' ≠ ' + previous.length)
    }
    if (write.size !== after.length) reasons.push('第 ' + write.id + ' 次写入的长度记账对不上：' + write.size + ' ≠ ' + after.length)
    if (write.stage === 'append' && after.length < before) {
      reasons.push('append 让事件变少了：' + before + ' → ' + after.length)
    }
    if (write.stage === 'prune') {
      if (after.length > before) reasons.push('确认制清理让事件变多了：' + before + ' → ' + after.length)
      if (!after.length && before) reasons.push('确认制清理把事件清成了空数组')
    }
    if (write.stage === 'replace') {
      replaces += 1
      // 整体替换只允许两条路径：换缓存（切换会话）与截断重发（引擎侧真的删了）。
      const allowed = write.label === '换缓存' || write.label === '截断重发'
      if (!allowed) reasons.push('中途整体替换了 events：' + write.label)
      if (!after.length && before && !allowed) reasons.push('整体替换把事件清成了空数组：' + write.label)
    }
    previous = after
  }
  if (replaces > allowedReplaces) reasons.push('整体替换次数 ' + replaces + ' > 允许的 ' + allowedReplaces)
  return { ok: !reasons.length, reasons }
}
