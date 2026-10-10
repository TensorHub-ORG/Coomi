/** 引导的挂载点：App 根部挂这一个组件，别处不用管。
 *
 *  三件小事，都在这里收口：
 *  ① **懒加载**：向导正文（三步文案 + 免责声明，十来 KB）单独成一个 chunk。
 *     已经同意过的日常启动只会走到这个组件的 return null —— 那份文案一个字节都不会下载，
 *     所以它不占首屏主包，也不占启动请求。首帧判断走 store 的初值（同步读一次 localStorage）。
 *  ② **挂载一次、之后常驻**：Radix 的退场动画要靠「关闭时组件还在」才播得出来，
 *     所以第一次打开之后就保持挂着，只用 open 控制显示（关掉再把 DOM 摘掉就等于没有退场）。
 *  ③ **勾选状态放在这里**：每次要求确认时默认不勾选，必须由用户主动确认；
 *     「进入」的落盘与关闭是一件事，所以 onAccept 一并写在这里。
 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { acceptOnboarding } from './state'
import { useOnboarding } from './store'

/** 只有真的要显示引导时才会被请求到（见上面第 ① 条）。 */
const OnboardingGuide = lazy(() => import('./OnboardingGuide').then((m) => ({ default: m.OnboardingGuide })))

export function OnboardingGate() {
  const open = useOnboarding((s) => s.open)
  const blocking = useOnboarding((s) => s.blocking)
  const hide = useOnboarding((s) => s.hide)
  /// 需要确认时默认未勾选；普通回看不会显示确认框。
  const [agreed, setAgreed] = useState(false)
  /// 打开过就常驻（见上面第 ② 条）；没打开过则是纯 null，连 chunk 都不请求。
  const [loaded, setLoaded] = useState(open)
  useEffect(() => {
    if (open) { setLoaded(true); if (blocking) setAgreed(false) }
  }, [open, blocking])

  if (!loaded) return null
  return (
    <Suspense fallback={null}>
      <OnboardingGuide
        open={open}
        blocking={blocking}
        agreed={agreed}
        onAgreedChange={setAgreed}
        // 落盘与关闭是一件事：写 localStorage（coomi.onboarding.v1）之后再收起来，
        // 顺序反了的话，下一帧重挂会先读到「还没同意」。
        onAccept={() => { acceptOnboarding(); setAgreed(true); hide() }}
        onClose={hide}
      />
    </Suspense>
  )
}
