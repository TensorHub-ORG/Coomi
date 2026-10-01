/**
 * 富内容的安全阀：长度上限、单次时间预算、空闲调度。
 *
 * 为什么要有这个文件（「整屏无响应」的第三类嫌疑，与消息条数无关）：
 *   1) 识别层的老正则用了 `[\s\S]*` / 贪婪 `.*` + 锚点的组合 —— 在长文本上回溯是指数级的，
 *      一次 exec 就能把主线程按死，且只要**一条**超长消息就够触发；
 *   2) 高亮 / 公式 / 图表是同步重活，跑在渲染函数或 effect 里都会挡住出帧；
 *   3) 不可见的预览若还挂在 DOM 上，同样在后台烧主线程。
 *
 * 三条约束（本文件提供前两条的工具，第三条见 RichPreview 的 useInView）：
 *   - **识别前先卡长度**：超过 RICH_RECOGNIZE_MAX_CHARS 就不做任何形态判断，直接按纯文本渲染；
 *   - **单次重活给 200ms 预算**：超了就丢掉产物、降级成纯文本 / 源码视图。同步任务无法被中途抢占，
 *     所以预算的语义是「跑完立刻判定、超了就不用」——真正防卡死的是前面的长度上限；
 *   - **重活一律延后到 idle**（effect 里调度），并且返回可取消的句柄，卸载 / 参数变化即刻取消。
 */

/** 识别上限：超过它就不再做富块形态判断（也意味着不再跑任何识别正则）。 */
export const RICH_RECOGNIZE_MAX_CHARS = 100_000

/** 单次重活的时间预算（毫秒）：高亮 / KaTeX / Mermaid 都用它。 */
export const RICH_BUDGET_MS = 200

/** 形态判断只看开头这么多字符：所有「像什么」的判断都落在这段里，天然有界。 */
export const SNIFF_HEAD_CHARS = 4_096

/** 高亮的长度 / 行数上限：超过就只出纯文本，绝不让 shiki 吃下整块巨型代码。 */
export const HIGHLIGHT_MAX_CHARS = 30_000
export const HIGHLIGHT_MAX_LINES = 2_000

/** 公式渲染上限：超长输入容易让 KaTeX 的解析器长时间同步占用主线程。 */
export const MATH_MAX_CHARS = 20_000

/** 图表渲染上限：Mermaid 的布局是同步重活，超长源码一律降级为源码视图。 */
export const MERMAID_MAX_CHARS = 20_000

/** 识别被跳过的轻量标记（界面上就显示这一句）。 */
export const OVERSIZED_NOTE = '内容超过 10 万字符：已跳过富块识别，按纯文本渲染'

/** 是否超过识别上限。 */
export function isOversized(text: string, max = RICH_RECOGNIZE_MAX_CHARS): boolean {
  return text.length > max
}

/** 这一块还值不值得做语法高亮（长度与行数双上限）。 */
export function highlightAllowed(code: string, lines: number): boolean {
  return code.length <= HIGHLIGHT_MAX_CHARS && lines <= HIGHLIGHT_MAX_LINES
}

export type BudgetOutcome<T> =
  | { ok: true; value: T; ms: number }
  | { ok: false; ms: number }

/** 单调时钟（毫秒）：只用来量耗时，不参与业务判定。 */
export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

/**
 * 跑一次重活并计时：超过预算就**丢弃产物**（返回 ok:false），调用方据此降级。
 * 注意它不能抢占正在跑的同步任务 —— 这是 JS 单线程的硬限制，所以长度上限必须在前。
 */
export function runWithBudget<T>(task: () => T, budgetMs: number = RICH_BUDGET_MS): BudgetOutcome<T> {
  const start = nowMs()
  const value = task()
  const ms = nowMs() - start
  return ms > budgetMs ? { ok: false, ms } : { ok: true, value, ms }
}

interface IdleHost {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

/**
 * 把重活挪出渲染 / effect 的同步路径：返回取消函数。
 * 没有 requestIdleCallback 的环境（旧 WebView、Node 冒烟）退化成 setTimeout(0)，语义相同：不在本帧做。
 */
export function scheduleIdle(task: () => void, timeoutMs = 500): () => void {
  let cancelled = false
  const run = (): void => { if (!cancelled) task() }
  const host = globalThis as IdleHost
  if (typeof host.requestIdleCallback === 'function') {
    const handle = host.requestIdleCallback(run, { timeout: timeoutMs })
    return () => {
      cancelled = true
      if (typeof host.cancelIdleCallback === 'function') host.cancelIdleCallback(handle)
    }
  }
  const timer = setTimeout(run, 0)
  return () => { cancelled = true; clearTimeout(timer) }
}
