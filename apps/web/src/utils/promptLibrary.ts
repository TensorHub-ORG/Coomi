export interface SavedPrompt { id: string; title: string; content: string; tags: string[] }
export const PROMPT_STORAGE_KEY = 'coomi.prompts.v1'
export const BUILTIN_PROMPTS: SavedPrompt[] = [
  { id: 'builtin:explain', title: '解释代码', tags: ['理解'], content: '请解释这段代码的作用、执行流程和关键设计，并用一个简单例子说明。' },
  { id: 'builtin:review', title: '审查改动', tags: ['开发'], content: '请审查当前工作区的改动，重点检查正确性、边界条件和回归风险，按严重程度列出问题及文件位置。' },
  { id: 'builtin:debug', title: '排查问题', tags: ['开发'], content: '请先复现问题并追踪根因，提出最小修复，再运行有针对性的验证。问题描述：' },
  { id: 'builtin:plan', title: '拆解任务', tags: ['规划'], content: '请将下面的目标拆解成可执行步骤，说明依赖关系、验收条件和需要确认的信息。目标：' },
  { id: 'builtin:summary', title: '总结进展', tags: ['整理'], content: '请总结当前会话的目标、已完成工作、关键决策、待办事项和验证结果。' },
  { id: 'builtin:translate', title: '翻译润色', tags: ['写作'], content: '请翻译并润色以下内容，保留原意、专业术语和格式，使表达自然简洁：' },
]

export function savePrompt(items: SavedPrompt[], draft: SavedPrompt): SavedPrompt[] {
  const title = draft.title.trim(), content = draft.content.trim()
  if (!title || !content) throw new Error('请填写名称和提示词内容')
  if (!draft.id || draft.id.startsWith('builtin:')) throw new Error('内置提示词请另存为自定义提示词')
  const entry = { id: draft.id, title, content, tags: [...new Set(draft.tags.map(t => t.trim()).filter(Boolean))] }
  const found = items.some(item => item.id === entry.id)
  return found ? items.map(item => item.id === entry.id ? entry : item) : [...items, entry]
}

export function parsePrompts(raw: string | null): SavedPrompt[] {
  try {
    const entries: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(entries)) return []
    const seen = new Set<string>()
    return entries.filter((p): p is SavedPrompt => {
      if (!p || typeof p.id !== 'string' || !p.id || p.id.startsWith('builtin:') || seen.has(p.id)
        || typeof p.title !== 'string' || !p.title.trim() || typeof p.content !== 'string' || !p.content.trim()
        || !Array.isArray(p.tags) || !p.tags.every((t: unknown) => typeof t === 'string')) return false
      seen.add(p.id)
      return true
    })
  } catch { return [] }
}
