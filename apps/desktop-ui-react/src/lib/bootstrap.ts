/**
 * 启动引导：决定「进入界面时打开哪一个会话」。
 *
 * 抽成纯函数是为了能回归测试 —— 这个判断原来写在 App.tsx 的 useEffect 里，
 * 而它漏了一个分支，造成了真机上最难查的一次故障：
 *
 *   全新安装的机器上，引擎里没有任何**有内容**的会话（无内容会话会被 loadSessions
 *   过滤掉）→ 原来的四个分支一个都不进 → sessionId 一直是空串 →
 *   connect() 的第一行 `if (!sessionId || !engine.ready) return` 直接返回 →
 *   界面显示「与引擎的连接已断开」，而引擎、端口、IPC 全部正常。
 *
 *   开发机上永远有会话（list.length > 0），所以这个洞一直没被发现。
 *   结论：**空列表也必须落到一条明确的动作上**（新建空会话），不能什么都不做。
 */

export interface StartupSessionInput {
  /** 当前 store 里的会话 id（空串表示还没有会话）。 */
  sessionId: string
  /** 引擎返回的**可见**会话列表（无内容会话已被过滤，见 lib/emptySession）。 */
  sessions: Array<{ id: string }>
  /** 上次打开过的会话 id（localStorage）。 */
  remembered: string | null
  /** 该会话是否还留着没发出去的草稿。 */
  hasDraft: (id: string) => boolean
}

export type StartupAction =
  /** 已经有会话了：什么都不用做。 */
  | { kind: 'keep' }
  /** 打开指定会话。 */
  | { kind: 'open'; id: string }
  /** 按原 id 恢复「新建但还没落库」的草稿会话。 */
  | { kind: 'resume'; id: string }
  /** 全新状态：建一个空会话（空会话不进列表，界面仍是首页）。 */
  | { kind: 'new' }

export function pickStartupSession(input: StartupSessionInput): StartupAction {
  if (input.sessionId) return { kind: 'keep' }
  const remembered = input.remembered
  if (remembered && input.sessions.some((s) => s.id === remembered)) {
    return { kind: 'open', id: remembered }
  }
  if (remembered && input.hasDraft(remembered)) {
    return { kind: 'resume', id: remembered }
  }
  if (input.sessions.length) {
    return { kind: 'open', id: input.sessions[0].id }
  }
  // **全新机器**：没有任何可见会话 —— 必须建一个，否则连接永远不会建立。
  return { kind: 'new' }
}
