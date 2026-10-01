/** 一轮结束时的「后台完成提醒」。
 *
 *  只有窗口不可见 / 没聚焦时才提醒——前台盯着屏幕时再弹一次纯属打扰。
 *  优先级：系统通知（WebView 已授权 Notification 时）→ 应用内 toast。
 *  未授权时不主动 requestPermission（那是骚扰式弹窗），直接退回 toast。 */
import { toast } from 'sonner'
import { useCapabilities } from '../stores/capabilities'
import { useUi } from '../stores/ui'

/** 「滚到对话底部」的自定义事件：由 MessageList 监听，避免这里直接够到它的 DOM。 */
export const SCROLL_CHAT_BOTTOM_EVENT = 'coomi:scroll-chat-bottom'

/** 窗口是不是「没在前台」：最小化到托盘时 document.hidden 为真，
 *  切到别的应用时 hasFocus 为假，两种都算后台。 */
function isBackground(): boolean {
  if (typeof document === 'undefined') return false
  if (document.hidden) return true
  try { return !document.hasFocus() } catch { return false }
}

/** 回到对话并滚到底部：通知/提醒被点击时调用。
 *  聚焦窗口在 WebView 里只能尽力而为（壳没有暴露系统级聚焦命令），失败也不影响滚动。 */
export function focusChatAndScrollBottom(): void {
  try { window.focus() } catch { /* WebView 可能忽略，忽略即可 */ }
  try { useUi.getState().setView('chat') } catch { /* 忽略 */ }
  // 切页是异步的：要等 React 把对话页挂载出来、MessageList 挂上监听，事件才有人接。
  // （在对话页里本来就挂着，这一小段延迟对体验没有影响。）
  try {
    window.setTimeout(() => {
      try { window.dispatchEvent(new CustomEvent(SCROLL_CHAT_BOTTOM_EVENT)) } catch { /* 忽略 */ }
    }, 0)
  } catch { /* 忽略 */ }
}

function systemNotify(title: string, body: string): boolean {
  try {
    const Ctor = (window as unknown as { Notification?: typeof Notification }).Notification
    if (!Ctor) return false
    // 未授权 / 未询问一律不弹：这里不调 requestPermission（那不是用户手势触发的场景）。
    if (Ctor.permission !== 'granted') return false
    const n = new Ctor(title, { body, tag: 'coomi-turn-done' })
    n.onclick = () => { focusChatAndScrollBottom(); n.close() }
    return true
  } catch { return false }
}

/// 系统通知权限状态：用来解释「为什么这次只走了应用内提醒」。
export function notificationPermission(): 'granted' | 'denied' | 'default' | 'unsupported' {
  try {
    const Ctor = (window as unknown as { Notification?: typeof Notification }).Notification
    if (!Ctor) return 'unsupported'
    return Ctor.permission
  } catch { return 'unsupported' }
}

/** 一轮结束：窗口不在前台时提醒用户「回复好了」。 */
export function notifyTurnDone(options: { chars: number; sessionTitle?: string }): void {
  try {
    if (useCapabilities.getState().caps.backgroundNotify === false) return
    if (!isBackground()) return
    const detail = options.chars > 0 ? '共 ' + options.chars + ' 字' : '回复已结束'
    const title = '回复已完成'
    const from = options.sessionTitle ? ' · ' + options.sessionTitle : ''
    if (systemNotify(title, detail + from)) return
    // 应用内兜底：点「查看」回到对话并滚到底部。
    const notes: string[] = []
    if (options.sessionTitle) notes.push('来自「' + options.sessionTitle + '」')
    const permission = notificationPermission()
    if (permission === 'default') notes.push('系统通知未授权，已改用应用内提醒')
    if (permission === 'denied') notes.push('系统通知已被拒绝，可在系统设置里重新开启')
    toast(title + ' · ' + detail, {
      description: notes.length ? notes.join(' · ') : undefined,
      duration: 8000,
      action: { label: '查看', onClick: () => focusChatAndScrollBottom() },
    })
  } catch { /* 提醒失败绝不能影响事件主流程 */ }
}
