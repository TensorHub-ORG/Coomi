/**
 * F8 语音陪伴：TTS 朗读入口。
 *
 * 优先走原生桥（CoomiAndroid.speak，Android 侧接管系统 TTS）；
 * 无桥（纯浏览器 / 桌面端 / 调试）时静默降级，只留一行日志便于排查。
 */
export function speak(text: string): boolean {
  const content = text.trim()
  if (!content) return false
  if (window.CoomiAndroid?.speak) {
    window.CoomiAndroid.speak(content)
    return true
  }
  console.info('[tts] 无原生朗读桥，跳过朗读：', content.slice(0, 80))
  return false
}

/** 停止当前朗读（原生侧 QUEUE_FLUSH 打断；无桥时静默忽略）。 */
export function stopSpeaking(): void {
  window.CoomiAndroid?.ttsStop?.()
}

/** 设置语速（0.5–2.0，1.0 为正常）；仅原生桥支持时生效。 */
export function setTtsRate(rate: number): void {
  window.CoomiAndroid?.setTtsRate?.(Math.min(2, Math.max(0.5, rate)))
}

/** 是否有原生 TTS 桥（决定朗读按钮是否可用）。 */
export function hasNativeTts(): boolean {
  return Boolean(window.CoomiAndroid?.speak)
}
