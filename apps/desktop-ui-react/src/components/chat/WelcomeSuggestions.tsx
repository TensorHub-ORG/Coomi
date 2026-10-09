import { ArrowUpRight, Code2, FileText, Lightbulb, Search } from 'lucide-react'
import { useSession } from '../../stores/session'
import { useUi } from '../../stores/ui'

const suggestions = [
  { icon: Code2, title: '一起写代码', detail: '从一个想法，到运行起来', prompt: '我想实现一个功能，请先帮我梳理需求和实现方案。' },
  { icon: FileText, title: '读懂一份文档', detail: '提炼重点，理清脉络', prompt: '请帮我分析接下来提供的文档，提炼关键信息和行动建议。' },
  { icon: Search, title: '探索一个问题', detail: '多一点好奇，多一种可能', prompt: '我想深入了解一个主题，请帮我制定调研思路，并区分事实与推测。' },
  { icon: Lightbulb, title: '让灵感落地', detail: '把模糊的想法变成计划', prompt: '我有一个新想法，请和我一起把它拆解成可执行的计划。' },
]

export function WelcomeSuggestions() {
  const choose = (prompt: string) => {
    const { draft, setDraft } = useSession.getState()
    setDraft(draft.trim() ? `${draft}\n${prompt}` : prompt)
    useUi.getState().focusComposer()
  }
  return (
    <div className='welcome-suggestions' aria-label='从一个灵感开始'>
      {suggestions.map(({ icon: Icon, title, detail, prompt }) => (
        <button type='button' key={title} className='welcome-suggestion' onClick={() => choose(prompt)}>
          <span className='suggestion-icon'><Icon size={18} strokeWidth={1.6} /></span>
          <span className='suggestion-copy'><strong>{title}</strong><span>{detail}</span></span>
          <ArrowUpRight size={14} className='suggestion-arrow' />
        </button>
      ))}
    </div>
  )
}
