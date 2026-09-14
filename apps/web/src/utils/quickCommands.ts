export const QUICK_COMMAND_STORAGE_KEY = 'coomi.quickCommands.v1'
export const QUICK_COMMAND_CHANGED_EVENT = 'coomi:quick-commands-changed'

export interface QuickCommand {
  id: string
  icon: string
  name: string
  content: string
  guide?: 'newbie' | 'extension'
}

export interface QuickCommandSet {
  id: string
  name: string
  commands: QuickCommand[]
}

export interface QuickCommandConfig {
  activeSetId: string
  sets: QuickCommandSet[]
}

export const QUICK_COMMAND_ICONS = [
  'phone', 'globe', 'sparkle', 'cube', 'terminal', 'git',
  'folder', 'chat', 'memory', 'target', 'bolt', 'shield',
] as const

const DEFAULT_COMMANDS: QuickCommand[] = [
  { id: 'default-phone', icon: 'phone', name: '查看手机系统信息与型号信息', content: '查看手机系统信息与型号信息' },
  { id: 'default-news', icon: 'globe', name: '今日科技圈热点话题', content: '今日科技圈热点话题' },
  { id: 'default-newbie', icon: 'sparkle', name: 'Coomi 新手使用指南', content: 'Coomi 新手使用指南', guide: 'newbie' },
  { id: 'default-extension', icon: 'cube', name: '自定义拓展进化指南', content: '自定义拓展进化指南', guide: 'extension' },
]

export const DEFAULT_QUICK_COMMAND_CONFIG: QuickCommandConfig = {
  activeSetId: 'default',
  sets: [{ id: 'default', name: '默认指令', commands: DEFAULT_COMMANDS }],
}

let sequence = 0
function uniqueId(prefix: string): string {
  sequence += 1
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `${Date.now().toString(36)}-${sequence}`
  return `${prefix}-${random}`
}

function cloneConfig(config: QuickCommandConfig): QuickCommandConfig {
  return {
    activeSetId: config.activeSetId,
    sets: config.sets.map(set => ({ ...set, commands: set.commands.map(command => ({ ...command })) })),
  }
}

function cleanText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === 'string' ? value.trim().slice(0, max) : ''
  return text || fallback
}

export function normalizeQuickCommandConfig(value: unknown): QuickCommandConfig {
  if (!value || typeof value !== 'object') return cloneConfig(DEFAULT_QUICK_COMMAND_CONFIG)
  const input = value as Partial<QuickCommandConfig>
  const rawSets = Array.isArray(input.sets) ? input.sets.slice(0, 12) : []
  const usedSetIds = new Set<string>()
  const sets: QuickCommandSet[] = []

  for (const rawSet of rawSets) {
    if (!rawSet || typeof rawSet !== 'object') continue
    const source = rawSet as Partial<QuickCommandSet>
    let setId = cleanText(source.id, uniqueId('set'), 80)
    if (usedSetIds.has(setId)) setId = uniqueId('set')
    usedSetIds.add(setId)
    const rawCommands = Array.isArray(source.commands) ? source.commands : []
    const commands: QuickCommand[] = []
    for (let index = 0; index < 4; index += 1) {
      const fallback = DEFAULT_COMMANDS[index]
      const raw = rawCommands[index] && typeof rawCommands[index] === 'object'
        ? rawCommands[index] as Partial<QuickCommand>
        : {}
      const guide = raw.guide === 'newbie' || raw.guide === 'extension' ? raw.guide : undefined
      commands.push({
        id: cleanText(raw.id, `${setId}-${index + 1}`, 100),
        icon: QUICK_COMMAND_ICONS.includes(raw.icon as typeof QUICK_COMMAND_ICONS[number]) ? raw.icon! : fallback.icon,
        name: cleanText(raw.name, fallback.name, 40),
        content: cleanText(raw.content, fallback.content, 4000),
        ...(guide ? { guide } : {}),
      })
    }
    sets.push({ id: setId, name: cleanText(source.name, `指令方案 ${sets.length + 1}`, 30), commands })
  }

  if (!sets.length) return cloneConfig(DEFAULT_QUICK_COMMAND_CONFIG)
  const activeSetId = sets.some(set => set.id === input.activeSetId) ? input.activeSetId! : sets[0].id
  return { activeSetId, sets }
}

export function loadQuickCommandConfig(): QuickCommandConfig {
  try {
    const native = typeof window !== 'undefined' ? window.CoomiAndroid?.getQuickCommands?.() : ''
    const raw = native || localStorage.getItem(QUICK_COMMAND_STORAGE_KEY)
    return normalizeQuickCommandConfig(raw ? JSON.parse(raw) : null)
  } catch {
    return cloneConfig(DEFAULT_QUICK_COMMAND_CONFIG)
  }
}

export function saveQuickCommandConfig(value: QuickCommandConfig): QuickCommandConfig {
  const config = normalizeQuickCommandConfig(value)
  const serialized = JSON.stringify(config)
  if (typeof window !== 'undefined' && window.CoomiAndroid?.setQuickCommands) {
    const saved = window.CoomiAndroid.setQuickCommands(serialized)
    if (!saved) throw new Error('native quick-command persistence failed')
  }
  try { localStorage.setItem(QUICK_COMMAND_STORAGE_KEY, serialized) } catch { /* storage can be unavailable */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(QUICK_COMMAND_CHANGED_EVENT))
  return config
}

export function createQuickCommandSet(value: QuickCommandConfig, name: string): QuickCommandConfig {
  const config = normalizeQuickCommandConfig(value)
  const source = config.sets.find(set => set.id === config.activeSetId) ?? config.sets[0]
  const id = uniqueId('set')
  const commands = source.commands.map((command, index) => ({ ...command, id: `${id}-${index + 1}` }))
  const created = { id, name: cleanText(name, `指令方案 ${config.sets.length + 1}`, 30), commands }
  return { activeSetId: id, sets: [...config.sets, created] }
}

export function resetQuickCommandConfig(): QuickCommandConfig {
  return cloneConfig(DEFAULT_QUICK_COMMAND_CONFIG)
}
