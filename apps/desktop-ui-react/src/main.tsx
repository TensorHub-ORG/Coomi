import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { applyStoredAppearance } from './stores/ui'
import { forcedSafeMode, installGuard, setSafeMode } from './lib/guard'
import { clearCrashRecord, shouldSelfHeal } from './lib/crashGuard'
import './styles/base.css'
import './styles/desktop.css'

/* ── 界面保险丝（lib/guard.ts）：必须在首帧之前装好 ──
   心跳要从第一帧就开始打点（否则「卡过一回」这件事没人记得住），提示通道也要先接上 ——
   toast 是保险丝唯一的出口，晚接一步，卡顿那次就只剩一条静默的计数。 */
installGuard({
  notify: (notice) => { toast(notice.title, { description: notice.description, duration: 8000 }) },
})

/* 强制安全模式：URL 上加 ?safe=1（也认 true / on），或本地存了 coomi.safe.v1=1。
   这是最后一条退路 —— 界面卡到点不动设置页时，改一下地址栏、或清掉那个键重启就能自救。
   它在 applyStoredAppearance 之前生效，所以第一帧就已经是精简模式，不会再卡一次。 */
if (forcedSafeMode()) setSafeMode(true)

/* 启动自愈（白屏止血的第二跳）：上一次启动崩过、而且短时间内崩了 >= 2 次
   （lib/crashGuard.ts 的账），说明「重启一次」并没有把问题带走 —— 那这一次启动直接
   降级到安全模式，让用户至少能进到一个能用的界面里去收拾。
   顺序在 applyStoredAppearance 之前：第一帧就已经是精简模式。 */
if (shouldSelfHeal()) setSafeMode(true)

// 页面过渡能力探测：老 WebView2 没有 View Transitions，落到 off 后 base.css 会
// 让四个页面用自己的 --motion-page 过渡兜底（App.tsx 里也据此跳过 startViewTransition）。
document.documentElement.dataset.vt =
  typeof (document as unknown as { startViewTransition?: unknown }).startViewTransition === 'function' ? 'on' : 'off'

// 首帧之前落主题/字号：否则重启后会先闪一帧深色，进设置页才跳成浅色。
applyStoredAppearance()

/* 根错误边界：渲染期一抛异常，React 会把整棵树卸载掉 —— 那就是「整屏白」。
   包在最外面之后，任何一层抛出来的异常都会落到这张卡片上（错误摘要 + 重新加载
   + 进入安全模式并重载），**绝不留白屏**；会话区另有自己的一层（见 ChatView）。 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary scope='root' variant='root'>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

/* 跑满 15 秒没崩过 = 这一次启动是好的：把崩溃账清掉，
   免得一次早就过去的故障把后面每一次启动都拖进安全模式。 */
window.setTimeout(() => { clearCrashRecord() }, 15_000)
