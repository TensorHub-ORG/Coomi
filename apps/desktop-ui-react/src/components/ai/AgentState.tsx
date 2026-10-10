/**
 * AI 原生状态语言：主实现是 thinking-orbs，自研 CSS 点阵保留为兜底。
 *
 * 三件事分清楚：
 *   1) 对外接口一个字没改 —— <AgentState state size tone label className />，
 *      调用方（MessageList / Subagents / RecoveryBars / Dialogs / StatsBar）不用动。
 *   2) 语义态 → 库状态 的映射表在下面 ORB：11 个语义态落 9 个库状态，
 *      两处复用（reconnecting / idle）用 speed、paused 拉开差别，不是「随便挑一个」。
 *   3) 兜底：环境没有 2D canvas、库渲染抛错、或用户关了动效（[data-motion=off] /
 *      系统 prefers-reduced-motion）时，切回自研 CSS 点阵（styles/base.css 的 .ai-state 一组规则）。
 *      data-engine 会写明当前用的是哪一套，便于在开发者面板里核对。
 *
 * 颜色仍走语义令牌：CSS 兜底吃 currentColor；canvas 不吃 currentColor，
 * 所以 orb 那条路由这里把 --primary / --warn … 解析成具体色值再当 tint 传进去（见 useOrbTint）。
 */
import { Component, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { ThinkingOrb, type OrbSize, type OrbState } from 'thinking-orbs'
import { cn } from '../../lib/cn'

/** 状态枚举：每个状态在 ORB 表里都有一条映射，兜底时在 base.css 里各有一套动效。 */
export type AgentStateKind =
  | 'thinking'      // 模型在思考（整团向心呼吸）
  | 'reasoning'     // 推理链在产出（环匀速转 + 相位尾迹）
  | 'searching'     // 检索 / 抓取（快速环绕 + 半径向外荡开）
  | 'reading'       // 读文件 / 读上下文（亮点顺着点阵扫过去）
  | 'writing'       // 写文件 / 改文件（点一个个被「写」出来）
  | 'running'       // 工具执行中 / 高速运转（环快转 + 点阵收紧放开）
  | 'awaiting'      // 等待用户授权 / 回答（静止 + 慢心跳）
  | 'compacting'    // 压缩上下文（向心收拢再弹开）
  | 'subagents'     // 子智能体在跑（内外两层反向绕行）
  | 'reconnecting'  // 引擎重启 / 断线重连（断续闪烁，带明显停顿）
  | 'idle'          // 空闲 / 已结束（静置的暗点阵）

/** 状态中文名：aria-label 与并排文案都取这里，避免各处各写一份。 */
export const AGENT_STATE_LABELS: Record<AgentStateKind, string> = {
  thinking: '思考中',
  reasoning: '推理中',
  searching: '检索中',
  reading: '读取中',
  writing: '写入中',
  running: '执行中',
  awaiting: '等待你的确认',
  compacting: '正在压缩上下文',
  subagents: '子智能体运行中',
  reconnecting: '正在重新连接引擎',
  idle: '空闲',
}

/** 四档尺寸：小（14 / 20）、中（28）、大（48）—— 尺寸由 .ai-state 的 --ai-size 定死。 */
export type AgentStateSize = 'xs' | 'sm' | 'md' | 'lg'

export type AgentStateTone = 'inherit' | 'primary' | 'ok' | 'warn' | 'danger' | 'muted'

const TONE: Record<AgentStateTone, string> = {
  inherit: '',
  primary: 'text-primary',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-ink-4',
}

/* ── 语义态 → thinking-orbs 状态（映射表）──

   | 语义态        | 库状态      | 为什么是它                                   |
   |--------------|------------|---------------------------------------------|
   | thinking     | composing  | 起伏的多带条幅：思绪正在铺开                  |
   | reasoning    | solving    | 分带错位再归位：一步接一步地推导              |
   | searching    | searching  | 同名：扫描子午线扫过点阵球                    |
   | reading      | listening  | 波形沿纬度环滚过：一行一行读过去              |
   | writing      | weaving    | 三股线编织：一处接一处写下去                  |
   | running      | working    | 倾斜轨道上的粒子持续运转：工具在跑            |
   | awaiting     | breathing  | 正对视角的环缓慢形变：静止等你                |
   | compacting   | shaping    | 轮廓在圆→三角→方之间收拢：上下文被压实        |
   | subagents    | connecting | 星座自连、包沿边跑：多个子智能体在协作        |
   | reconnecting | connecting | 复用：同为「连线」语义，speed 0.5 读作断线重试 |
   | idle         | breathing  | 复用：同一个形变 paused 定格住 = 空置         |
*/
const ORB: Record<AgentStateKind, { state: OrbState; speed?: number; paused?: boolean }> = {
  thinking: { state: 'composing' },
  reasoning: { state: 'solving' },
  searching: { state: 'searching' },
  reading: { state: 'listening' },
  writing: { state: 'weaving' },
  running: { state: 'working' },
  awaiting: { state: 'breathing' },
  compacting: { state: 'shaping' },
  subagents: { state: 'connecting' },
  reconnecting: { state: 'connecting', speed: 0.5 },
  idle: { state: 'breathing', paused: true },
}

/** 四档尺寸 → 库的三种预设（20 / 32 / 64）。
    库的预设是「手调过的点密度与点径」，不是缩放系数，所以只挑最接近的一档，
    再用 .ai-state 的容器尺寸把画布缩到 14 / 20 / 28 / 48：缩放只改渲染尺寸，不改画面节奏。 */
const ORB_SIZE: Record<AgentStateSize, OrbSize> = { xs: 20, sm: 20, md: 32, lg: 64 }

/** 语气 → CSS 令牌名：canvas 里没有 currentColor，只能把令牌解析成色值。 */
const TONE_VAR: Record<AgentStateTone, string | null> = {
  inherit: null,   // 库自带的墨色（浅色深墨 / 暗色浅墨），本来就跟主题一致
  primary: '--primary',
  ok: '--ok',
  warn: '--warn',
  danger: '--danger',
  muted: null,     // rgba 令牌的 alpha 会被 tint 丢掉，见 TONE_DIM
}

/** muted 用透明度表达「弱」：tint 只吃 rgb，--ink-4 的 0.38 alpha 传进去会变成实心墨色。 */
const TONE_DIM: Partial<Record<AgentStateTone, string>> = { muted: 'opacity-60' }

/** 画布铺满 .ai-state（尺寸仍然由 CSS 的 --ai-size 决定，这里不重复写 px）。 */
const FILL: CSSProperties = { width: '100%', height: '100%' }

/* ── 环境探测：下面任何一条命中，就切回自研 CSS 点阵 ── */

let canvasProbe: boolean | null = null
/** 拿不到 2D 上下文时库会静默什么都不画（画布全透明），先探一次，直接兜底。 */
function hasCanvas2d(): boolean {
  if (canvasProbe == null) {
    try {
      canvasProbe = typeof document !== 'undefined' && !!document.createElement('canvas').getContext('2d')
    } catch { canvasProbe = false }
  }
  return canvasProbe
}

/** documentElement 上 data-theme / data-motion 的版本号：换主题要重算 tint，关动效要切兜底。
    全模块只挂一个 MutationObserver，实例再多也不会每个组件各挂一个。 */
let docRev = 0
const docListeners = new Set<() => void>()
let docObserver: MutationObserver | null = null

function subscribeDoc(fn: () => void): () => void {
  docListeners.add(fn)
  if (!docObserver && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    docObserver = new MutationObserver(() => {
      docRev += 1
      for (const listener of [...docListeners]) listener()
    })
    // data-perf 也要盯：省电档下 canvas orb 要换成 CSS 点阵（见 useFallbackEngine）。
    docObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion', 'data-perf'] })
  }
  return () => { docListeners.delete(fn) }
}

function useDocRev(): number {
  return useSyncExternalStore(subscribeDoc, () => docRev, () => 0)
}

/** 系统级「减少动态效果」：跟着 MediaQueryList 走，用户在系统设置里一改就切。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** 是否降级到自研 CSS 点阵。
    减动效时也走兜底：库停下来画的是一帧静态 canvas，而自研点阵在减动效下会收成一个
    静态点（base.css 末尾那段），后者更「安静」，也更省一个 canvas 常驻。 */
function useFallbackEngine(): boolean {
  const rev = useDocRev()
  const reduced = usePrefersReducedMotion()
  const motionOff = useMemo(
    () => typeof document !== 'undefined' && document.documentElement.dataset.motion === 'off',
    [rev],
  )
  const noCanvas = useMemo(() => !hasCanvas2d(), [])
  // 省电档（html[data-perf=low]）也走 CSS 兜底：canvas orb 是生成期间常驻的每帧重绘，
  // 弱 GPU 的机器上流式输出时它就是那份额外的负载（用户报的「流式卡顿」来源之一）。
  const lowPerf = useMemo(
    () => typeof document !== 'undefined' && document.documentElement.dataset.perf === 'low',
    [rev],
  )
  return reduced || motionOff || noCanvas || lowPerf
}

/** 语气色解析：只在语气或主题变化时读一次 getComputedStyle，不在每帧里读。 */
function useOrbTint(tone: AgentStateTone): string | undefined {
  const rev = useDocRev()
  const varName = TONE_VAR[tone]
  const [tint, setTint] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!varName || typeof window === 'undefined') { setTint(undefined); return }
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
    setTint(value || undefined)
  }, [varName, rev])
  return tint
}

/** 库渲染抛错（极端环境、被策略拦掉的 canvas）时接住，换成同一份 CSS 兜底，不让整条消息挂掉。 */
class OrbBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  render(): ReactNode { return this.state.failed ? this.props.fallback : this.props.children }
}

/** 自研 CSS 点阵：DOM 固定为「1 个环 + 6 个点」，每个状态一套关键帧（styles/base.css）。 */
const DOTS = [0, 1, 2, 3, 4, 5]

function CssDots() {
  return (
    <span className='ai-ring' aria-hidden='true' data-loop-anim>
      {DOTS.map((i) => (
        <span key={i} className='ai-dot' data-loop-anim style={{ '--i': String(i) } as CSSProperties} />
      ))}
    </span>
  )
}

export function AgentState({ state, size = 'sm', tone = 'inherit', label, className }: {
  state: AgentStateKind
  size?: AgentStateSize
  tone?: AgentStateTone
  /** 覆盖默认中文状态名（同一个状态在不同语境下的说法可能不同）。 */
  label?: string
  className?: string
}) {
  const orb = ORB[state]
  const tint = useOrbTint(tone)
  const css = useFallbackEngine()

  return (
    <span
      // 用 img 而不是 status：点阵本身是装饰，状态文字通常就在旁边，
      // 挂成 live region 会让读屏在流式期间不停打断用户。
      role='img'
      aria-label={label ?? AGENT_STATE_LABELS[state]}
      data-state={state}
      data-size={size}
      // 当前渲染引擎：orb = thinking-orbs，css = 自研点阵兜底。
      data-engine={css ? 'css' : 'orb'}
      className={cn('ai-state', TONE[tone], className)}
    >
      {css ? (
        <CssDots />
      ) : (
        <OrbBoundary fallback={<CssDots />}>
          <ThinkingOrb
            state={orb.state}
            size={ORB_SIZE[size]}
            speed={orb.speed ?? 1}
            paused={orb.paused ?? false}
            color={tint}
            // 画布自己带 role=img 与英文 aria-label，这里让位给外层的中文标签，避免读两遍。
            aria-hidden
            className={TONE_DIM[tone]}
            style={FILL}
          />
        </OrbBoundary>
      )}
    </span>
  )
}
