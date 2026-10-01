/**
 * 「本轮产出」：turn_end 事件的 artifacts 字段 → 对话末尾那排生成物卡片的数据源。
 *
 * 这个文件是**解析层**，只做一件事：把引擎给的原始形状（数组 / 对象 / 纯路径字符串都认）
 * 折成渲染可直接用的条目，字段口径与产物清单 GET /api/sessions/{id}/artifacts 对齐
 * （path / name / size / modified / kind），两处因此能共用同一套图标与格式化。
 *
 * 为什么解析层独立成文件、而状态放在 stores/session 的 turnArtifacts 字段：
 *  · 卡片挂在**最后一条有正文的回复**下面，而 turn_end 之后引擎会回读历史（条目对象整批重折），
 *    所以产出不能挂在条目对象上；它属于「这个会话刚跑完的这一轮」，是会话级状态；
 *  · 放在 zustand 的字段里（而不是模块级 Map + 选择器读），是因为选择器一旦返回新对象就会
 *    让 useSyncExternalStore 每次都判「变了」——空产出必须是**同一个**空数组常量；
 *  · 引擎可以不发这个字段（版本较旧、或这一轮确实没产出文件）：解析不出来就是空清单，
 *    界面上一个占位都不画。
 *
 * 字段口径：
 *  · path     必填；没有路径的条目直接丢掉（没路径就没法预览 / 打开 / 另存）
 *  · name     缺省取 path 的文件名段
 *  · size     字节数，认不出来记 0（界面据此说「大小未知」）
 *  · modified 毫秒时间戳；引擎给秒级（< 10^11）时按 ×1000 归一，0 = 未知
 *  · kind     image / text / code / other，未知一律 other
 */
import type { ArtifactKind } from '../components/shell/dockApi'
import { basename } from '../components/shell/dockShared'

/** 某一轮产出的一个文件（渲染用，字段都已经是「可直接显示」的形态）。 */
export interface TurnArtifact {
  path: string
  name: string
  /** 字节数；0 = 引擎没给或认不出来（界面显示「大小未知」）。 */
  size: number
  /** 毫秒时间戳；0 = 未知（界面不显示时间）。 */
  modified: number
  kind: ArtifactKind
}

/** 没有产出时**永远是这一个**：它的引用要稳，卡片不出现时不许因此重渲染任何一行。 */
export const NO_ARTIFACTS: TurnArtifact[] = []

const ARTIFACT_KINDS: readonly string[] = ['image', 'text', 'code', 'other']

function kindOf(raw: unknown): ArtifactKind {
  const value = String(raw ?? '').trim().toLowerCase()
  return (ARTIFACT_KINDS as readonly string[]).includes(value) ? (value as ArtifactKind) : 'other'
}

/** 秒级时间戳归一成毫秒：引擎的清单接口给的是秒，前端一律按毫秒渲染。 */
function toMs(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value)
}

/** 一条原始条目 → 渲染用条目；没有路径就返回 null（宁可少一张卡，也不画一张点不开的）。 */
function normalizeOne(raw: unknown): TurnArtifact | null {
  // 引擎的另一种形态：直接给一串路径。
  if (typeof raw === 'string') {
    const path = raw.trim()
    return path ? { path, name: basename(path), size: 0, modified: 0, kind: 'other' } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const path = String(entry.path ?? entry.file ?? entry.file_path ?? entry.filePath ?? '').trim()
  if (!path) return null
  const name = String(entry.name ?? '').trim() || basename(path)
  const size = Number(entry.size)
  return {
    path,
    name,
    size: Number.isFinite(size) && size > 0 ? Math.round(size) : 0,
    modified: toMs(entry.modified ?? entry.mtime ?? entry.updatedAt ?? entry.at),
    kind: kindOf(entry.kind),
  }
}

/** 字段缺失 / 不是数组 → 空清单（**不猜、不补占位**）。 */
export function parseTurnArtifacts(raw: unknown): TurnArtifact[] {
  if (!Array.isArray(raw)) return NO_ARTIFACTS
  const out: TurnArtifact[] = []
  for (const item of raw) {
    const one = normalizeOne(item)
    if (one) out.push(one)
  }
  return out
}

/** 文件扩展名（小写、不带点）；没有扩展名返回空串（卡片那一行就不显示它）。 */
export function artifactExt(name: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(name.trim())
  return match ? match[1].toLowerCase() : ''
}

/** 同一路径只留一条（引擎可能同时从产物清单与工具参数里给到同一个文件）。 */
export function dedupeArtifacts(list: readonly TurnArtifact[]): TurnArtifact[] {
  const seen = new Set<string>()
  const out: TurnArtifact[] = []
  for (const item of list) {
    const key = item.path.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
