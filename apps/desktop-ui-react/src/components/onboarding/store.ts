/** 引导弹窗的开关状态：一个进程内的小 store，只回答两件事 ——
 *  ① 现在开不开；② 这一轮是不是**阻断式**（首次启动：不勾选就进不去）。
 *
 *  为什么用 store 而不是 props：入口不止一个。首次启动由 OnboardingGate 自己开着，
 *  而「设置 → 关于 → 隐私与使用说明」是另一个页面里的一句 openOnboarding()——
 *  走 store 才不用把开关状态一路透传到外壳。向导正文本身是懒加载 chunk（见 OnboardingGate），
 *  所以这里只留一个布尔量，不会把文案与组件拖进首屏主包。
 *
 *  初值在模块加载时（也就是 App 被 import 的那一拍）就读好：首次启动的第一帧就已经是
 *  「引导盖在界面上」，不会先闪一下主界面再弹出来。
 */
import { create } from 'zustand'
import { hasAccepted, needsOnboarding } from './state'

interface OnboardingState {
  /** 弹窗是否显示。 */
  open: boolean
  /** 阻断式：没有关闭按钮，Esc / 点遮罩都关不掉，必须勾选后点「进入」。 */
  blocking: boolean
  /** 打开弹窗；blocking 省略时按「是不是还没同意过」自动判断。 */
  show: (blocking?: boolean) => void
  /** 关闭弹窗（只对非阻断式有效；阻断式下界面不给关闭入口）。 */
  hide: () => void
}

/** 首次启动判定只算一次：它决定第一帧画什么，之后再算没有意义。 */
const firstRun = needsOnboarding()

export const useOnboarding = create<OnboardingState>((set) => ({
  open: firstRun,
  blocking: firstRun,
  show: (blocking) => set({ open: true, blocking: blocking ?? !hasAccepted() }),
  hide: () => set({ open: false }),
}))

/** 「再看一次」入口（设置页 / 帮助处调用）：没同意过就是阻断式，同意过就是普通回看。 */
export function openOnboarding(): void {
  useOnboarding.getState().show(!hasAccepted())
}

/** 关闭引导（测试与程序化收起用；界面上的关闭走按钮自己的回调）。 */
export function closeOnboarding(): void {
  useOnboarding.getState().hide()
}

/** 这一刻是否还需要引导（供别处做「首次启动」判断，不订阅任何状态）。 */
export function onboardingPending(): boolean {
  return needsOnboarding()
}
