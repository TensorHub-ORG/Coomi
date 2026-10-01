/** 名称/描述的批量中译层：POST /api/catalog/translate（引擎侧先查内置词表、再查本地缓存、
 *  最后才走免费翻译 API），本模块负责分批（≤20/批）、结果落到 localStorage 缓存、
 *  接口失败一律回原名 —— 纯显示偏好，任何一步出错都不阻塞浏览。
 *
 *  与 capabilities.ts 里「远程条目自动翻译」的约定一致：translateRemote 关闭时
 *  fetchTranslation 直接返回空表（调用方继续用原文）。 */

import { useEngine } from '../../stores/engine'
import { useCapabilities } from '../../stores/capabilities'

export interface SkillTranslation {
  name: string
  description: string
}

/** 单批上限：引擎侧 MAX_IDS_PER_REQUEST 是 300，前端按 20/批控制请求体与缓存粒度。 */
const BATCH_SIZE = 20
const CACHE_KEY = 'coomi.skillTranslations.v1'

function readCache(): Record<string, SkillTranslation> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, SkillTranslation>
  } catch {
    return {}
  }
}

function writeCache(cache: Record<string, SkillTranslation>): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)) } catch { /* 隐私模式忽略 */ }
}

function lowerKey(id: string): string {
  return id.trim().toLowerCase()
}

/**
 * 批量翻译条目名称/描述。
 * @returns id（原样键）→ { name, description }；未命中/失败/关闭开关时该 id 不在表里。
 */
export async function fetchTranslation(ids: string[]): Promise<Record<string, SkillTranslation>> {
  const caps = useCapabilities.getState().caps
  if (!caps.translateRemote) return {}
  const unique = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)))
  if (!unique.length) return {}

  const cache = readCache()
  const found: Record<string, SkillTranslation> = {}
  const missing: string[] = []
  for (const id of unique) {
    const hit = cache[lowerKey(id)]
    if (hit) found[id] = hit
    else missing.push(id)
  }
  if (!missing.length) return found

  const reply: Record<string, SkillTranslation> = {}
  for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
    const chunk = missing.slice(offset, offset + BATCH_SIZE)
    try {
      const data = await useEngine.getState().api<Record<string, SkillTranslation>>('/api/catalog/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: chunk, target: 'zh-CN' }),
      })
      if (data) {
        for (const [id, value] of Object.entries(data)) {
          if (value && typeof value.name === 'string' && value.name.trim()) {
            reply[id] = { name: value.name, description: value.description ?? '' }
            cache[lowerKey(id)] = reply[id]
          }
        }
      }
    } catch { /* 接口失败：这一批回原名，不重试 */ }
  }
  writeCache(cache)
  return reply
}
