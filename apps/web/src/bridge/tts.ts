/**
 * F8 语音陪伴：TTS 朗读入口。
 *
 * 优先走原生桥（CoomiAndroid.speak，Android 侧接管系统 TTS）；
 * 无桥（纯浏览器 / 桌面端 / 调试）时静默降级，只留一行日志便于排查。
 */
export function speak(text: string): void {
  const content = text.trim()
  if (!content) return
  if (window.CoomiAndroid?.speak) {
    window.CoomiAndroid.speak(content)
    return
  }
  console.info('[tts] 无原生朗读桥，跳过朗读：', content.slice(0, 80))
}
