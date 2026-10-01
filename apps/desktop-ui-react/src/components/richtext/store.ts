/**
 * 富块登记处：对话里的代码块把自己登记进来，右侧栏「预览」页签跟随最新登记的那一个。
 *
 * 三条规则，别让状态变成一锅粥：
 *   - latest：谁最后登记谁就是「最新」——代码块在挂载时登记，DOM 顺序天然等于消息顺序；
 *   - pinned：用户显式固定后，pinned 永远压过 latest，直到取消固定或固定块被替换；
 *   - artifactTick：存为产物成功后 +1，产物页签监听它自动重取清单（两个页签由此打通）。
 * 这里只存「当前要预览的那一块」，不缓存历史块，避免长会话把内存撑起来。
 */
import { create } from 'zustand'
import type { RichKind } from './detect'

export interface RichBlock {
  /** kind + 代码内容算出来的稳定 id：同一块重挂载时 id 不变，页签不会闪。 */
  id: string
  kind: RichKind
  lang: string
  code: string
  /** 人类可读的来源说明（例如「对话里的 HTML 代码块」），只用于界面展示。 */
  origin: string
  /** 登记序号：越大越新。 */
  at: number
}

interface RichStoreState {
  latest: RichBlock | null
  pinned: RichBlock | null
  /** 存为产物的成功次数：产物页签把它并进刷新依赖。 */
  artifactTick: number
  lastArtifactPath: string
  pin: (block: RichBlock | null) => void
  bumpArtifacts: (path: string) => void
}

let seq = 0

/** 内容哈希（djb2）：够稳、够短，不引第三方库。 */
export function blockId(kind: string, code: string): string {
  let hash = 5381
  const text = kind + '\u0000' + code
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return kind + '-' + (hash >>> 0).toString(36) + '-' + text.length.toString(36)
}

export function makeBlock(kind: RichKind, lang: string, code: string, origin: string): RichBlock {
  return { id: blockId(kind, code), kind, lang, code, origin, at: ++seq }
}

/** 登记一个块：同一块重复挂载（列表重排、滚动回收）不覆盖，避免页签被旧块抢走。 */
export function registerRichBlock(block: RichBlock): void {
  const state = useRichStore.getState()
  if (state.latest?.id === block.id) return
  if (state.pinned?.id === block.id) return
  if (state.latest && state.latest.at > block.at) return
  useRichStore.setState({ latest: block })
}

export const useRichStore = create<RichStoreState>((set) => ({
  latest: null,
  pinned: null,
  artifactTick: 0,
  lastArtifactPath: '',
  pin: (block) => set({ pinned: block }),
  bumpArtifacts: (path) => set((s) => ({ artifactTick: s.artifactTick + 1, lastArtifactPath: path })),
}))

/** 当前该预览哪一块：固定优先，其次最新。 */
export function pickRichBlock(state: { latest: RichBlock | null; pinned: RichBlock | null }): RichBlock | null {
  return state.pinned ?? state.latest
}
