import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, Check, Copy, RotateCcw, ShieldAlert } from 'lucide-react'
import { Button } from './ui/Button'
import { isLean, setSafeMode, setSafeOverride } from '../lib/guard'
import { describeComponentStack, describeError, recordCrash, type CrashSummary } from '../lib/crashGuard'

/**
 * 错误边界：把「渲染期异常」就地接住，**绝不整屏白**。
 *
 * 症状（P0）：切换会话后整屏白，重启无效。React 里渲染期一抛异常，如果没人接，
 * 它会把**整棵树**卸载掉 —— 页面上什么都不剩，而且这个异常不会再被第二个人接住；
 * 重启只是把同一份数据再放一遍，所以「重启无效」。止血的办法只有一条：有人在树上接住它。
 *
 * 两层，各管各的：
 *   · variant='root'（main.tsx 包在 <App/> 外）：整屏兜底。画「界面出错了」+ 错误摘要，
 *     给三个出口 —— 重新加载 / 进入安全模式并重载 / 复制错误信息。
 *   · variant='section'（ChatView 包在 <MessageList/> 外）：**局部**失效。
 *     会话区崩了只让消息区换成一张小卡片 + 重试按钮，外壳（导航 / 列表 / 输入区）照常能用，
 *     换个会话（resetKey 变）自动复位。
 *
 * 两条纪律：
 *   ① 没崩的时候 render 直接返回 children —— **不额外套一层 DOM**，布局与包之前一字不差
 *      （这个外壳对滚动与虚拟化很敏感，多一层就多一处对不上）；
 *   ② 副作用只在 componentDidCatch 里做（记账 + 控制台留痕）。记账进 lib/crashGuard.ts，
 *      同一个错误短时间内连崩两次，下一次启动会自己进安全模式。
 */

export interface ErrorBoundaryProps {
  children: ReactNode
  /** 这一层边界的名字：也是崩溃账里的 scope（诊断用）。 */
  scope: string
  /** root ＝ 整屏兜底（带安全模式与重载出口）；section ＝ 局部失效（带重试）。默认 root。 */
  variant?: 'root' | 'section'
  /** 局部边界显示的「哪一块」出错（例如「对话内容」）。 */
  label?: string
  /** 值一变就自动复位：换会话时把上一次的崩溃一起翻篇。 */
  resetKey?: unknown
  onError?: (error: unknown, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  error: unknown
  summary: CrashSummary
  /** React 的组件栈（头几行）：定位「是哪一段界面崩的」，用户截图报障时最有用。 */
  where: string
  copied: boolean
}

function healthy(): ErrorBoundaryState {
  return { error: null, summary: { title: '', detail: '' }, where: '', copied: false }
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = healthy()

  /** 渲染期异常的第一步：只把错误存进 state（这一步不做任何副作用，React 随后画 fallback）。 */
  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { ...healthy(), error, summary: describeError(error) }
  }

  /** 副作用都在这里：记账（启动自愈的判据）+ 控制台留痕（带组件栈）。自己抛错也不行。 */
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const where = describeComponentStack(info)
    try {
      recordCrash(this.props.scope, error)
    } catch { /* 记账失败不影响止血 */ }
    try {
      console.error('[ErrorBoundary:' + this.props.scope + '] 渲染期异常（已就地接住，界面不白屏）', error, where)
    } catch { /* 控制台不可用也无所谓 */ }
    this.setState({ where })
    this.props.onError?.(error, info)
  }

  /** resetKey 变了（换了会话 / 换了页面）＝ 上一次的崩溃已经翻篇：自动复位，重新挂子节点。 */
  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.reset()
  }

  /** 就地重试：清掉错误状态重新挂子节点（会话区那一层用它恢复，不整页刷新）。 */
  reset = (): void => { this.setState(healthy()) }

  /** 重新加载 = 最笨也最有效的出口（数据都在引擎里，重放一遍就好）。 */
  private reload = (): void => {
    try { window.location.reload() } catch { /* WebView 不给重载时只能靠安全模式那一步 */ }
  }

  /** 进入安全模式并重载：本地开关 + 当前这一份判定一起置上，重载后第一帧就是精简模式。 */
  private safeReload = (): void => {
    try {
      setSafeMode(true)
      setSafeOverride(true)
    } catch { /* 写不进 localStorage 也照样重载一次 */ }
    this.reload()
  }

  private copyReport = (): void => {
    const { summary, where } = this.state
    const text = ['[coomi] 界面出错：' + this.props.scope, summary.title, summary.detail, where ? '组件栈：' + where : '']
      .filter(Boolean).join('\n')
    const done = (): void => { this.setState({ copied: true }) }
    try {
      void navigator.clipboard.writeText(text).then(done, () => { /* 剪贴板不给用就算了 */ })
    } catch { /* 同上 */ }
  }

  /** 没崩：原样返回子节点（不额外加 DOM 层，布局与包之前一模一样）。 */
  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return this.props.variant === 'section' ? this.renderSection() : this.renderRoot()
  }

  /** 局部失效：会话区自己的小卡片 + 重试。外壳一帧都不动，用户还能切会话 / 换页面。 */
  private renderSection(): ReactNode {
    const { summary } = this.state
    return (
      <div
        data-error-boundary={this.props.scope}
        className='flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center'
      >
        <div className='flex items-center gap-1.5 text-danger'>
          <AlertTriangle size={14} />
          <span className='text-13 font-medium'>{(this.props.label ?? '这块内容') + '出错了'}</span>
        </div>
        <p className='max-w-[520px] break-words text-12 text-ink-3'>{summary.title}</p>
        <Button variant='secondary' size='sm' className='mt-1' onClick={this.reset}>
          <RotateCcw />
          重试
        </Button>
        <p className='text-11 text-ink-4'>其它部分还能用；换个会话或切个页面也会自动重来一次。</p>
      </div>
    )
  }

  /** 整屏兜底：一句人话 + 错误摘要 + 三个出口。**任何情况下都不留白屏**。 */
  private renderRoot(): ReactNode {
    const { summary, where, copied } = this.state
    return (
      <div
        data-error-boundary={this.props.scope}
        data-error-screen='1'
        className='flex h-full min-h-0 w-full flex-col items-center justify-center overflow-auto bg-canvas p-6'
      >
        <div className='w-full max-w-[600px] rounded-xl border border-line bg-surface p-5 shadow-menu'>
          <div className='flex items-center gap-2 text-danger'>
            <AlertTriangle size={16} />
            <h1 className='text-15 font-semibold text-ink'>界面出错了</h1>
          </div>
          <p className='mt-2 text-12 leading-relaxed text-ink-3'>
            这一段界面没能画出来，已经就地停住（不会再往下渲染、也不会继续报错）。
            你的会话和文件都保存在引擎里，<strong className='font-medium text-ink'>没有丢</strong>：重载之后就能继续用。
          </p>
          <p className='mt-3 rounded-lg bg-muted px-3 py-2 text-12 break-words text-ink'>{summary.title}</p>
          <pre className='mt-2 max-h-40 overflow-auto rounded-lg border border-line-soft bg-surface px-3 py-2 text-11 leading-[1.6] text-ink-3'>
            {summary.detail}
            {where ? '\n组件栈：' + where : ''}
          </pre>
          <div className='mt-4 flex flex-wrap items-center gap-2'>
            <Button variant='primary' size='md' onClick={this.reload}>
              <RotateCcw />
              重新加载
            </Button>
            {isLean() ? (
              <span className='text-12 text-ink-3'>已处于安全模式</span>
            ) : (
              <Button variant='secondary' size='md' onClick={this.safeReload}>
                <ShieldAlert />
                进入安全模式并重载
              </Button>
            )}
            <Button variant='ghost' size='md' onClick={this.copyReport}>
              {copied ? <Check /> : <Copy />}
              {copied ? '已复制' : '复制错误信息'}
            </Button>
          </div>
          <p className='mt-3 text-11 leading-relaxed text-ink-4'>
            安全模式：关掉动效、富预览、语法高亮与长列表虚拟化，只画纯文本，先把界面救回来。
            地址栏加 ?safe=1 也能打开；要关掉它，去设置页把「安全模式」关掉即可（会顺手清掉启动开关）。
          </p>
        </div>
      </div>
    )
  }
}
