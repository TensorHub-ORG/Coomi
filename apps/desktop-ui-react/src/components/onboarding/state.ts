/** 引导「已同意」的落盘与判定 —— 只做这一件事，所以它没有 React、没有 store，
 *  任何地方（含将来的引导内容升级逻辑）都能直接读。
 *
 *  键与格式：localStorage 的 coomi.onboarding.v1 =
 *    { "version": <内容版本号>, "acceptedAt": "<ISO 时间>" }
 *  · version 是**内容版本**（src/content/privacy.tsx 的 GUIDE_CONTENT_VERSION），
 *    不是应用版本：文案有实质变化时把它 +1，已同意过的用户就会再看到一次引导；
 *  · acceptedAt 只为了「什么时候同意的」这件事有据可查，界面用不到它。
 *
 *  读取一律防御式：localStorage 在隐私模式 / 被策略禁用时会抛异常，JSON 也可能是手改坏的。
 *  任何异常都按「没同意过」处理 —— 宁可多问一次，也不要因为读不出来就当作用户已经知情。
 */
import { GUIDE_CONTENT_VERSION } from '../../content/privacy'

/** 存放同意记录的键（版本号写在值里，键名固定，将来不轻易改）。 */
export const CONSENT_KEY = 'coomi.onboarding.v1'

export interface Consent {
  /** 同意时的内容版本号。 */
  version: number
  /** ISO 时间戳。 */
  acceptedAt: string
}

/** 读同意记录：没有 / 读不动 / 格式不对，一律返回 null。 */
export function readConsent(): Consent | null {
  try {
    const raw = window.localStorage.getItem(CONSENT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const version = (parsed as { version?: unknown }).version
    const acceptedAt = (parsed as { acceptedAt?: unknown }).acceptedAt
    if (typeof version !== 'number' || !Number.isFinite(version)) return null
    return { version, acceptedAt: typeof acceptedAt === 'string' ? acceptedAt : '' }
  } catch {
    return null
  }
}

/** 现在这一版内容是否已经被同意过（版本号 >= 当前内容版本才算数）。 */
export function hasAccepted(): boolean {
  const consent = readConsent()
  return consent !== null && consent.version >= GUIDE_CONTENT_VERSION
}

/** 首次启动（或内容升级后）是否还要弹引导。 */
export function needsOnboarding(): boolean {
  return !hasAccepted()
}

/** 写入同意记录并返回它（写不进去也不抛错：这一拍已经点过「进入」了，不该把人卡在门口）。 */
export function acceptOnboarding(): Consent {
  const consent: Consent = { version: GUIDE_CONTENT_VERSION, acceptedAt: new Date().toISOString() }
  try { window.localStorage.setItem(CONSENT_KEY, JSON.stringify(consent)) } catch { /* 隐私模式：本次会话内仍按已同意走 */ }
  return consent
}
