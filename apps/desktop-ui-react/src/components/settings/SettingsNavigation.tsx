import { useState } from 'react'
import { Search, SlidersHorizontal, Palette, Cpu, Folder, Sparkles, Heart, Terminal, Info } from 'lucide-react'

const META = {
  general: { icon: SlidersHorizontal, words: '启动 发送 排队 插队 确认 安全 权限 托盘 开机' },
  appearance: { icon: Palette, words: '主题 亮色 深色 字体 字号 标语 初始会话 国风 默认 密度 极简 消息 宽度 动效 性能' },
  models: { icon: Cpu, words: '模型 厂商 provider API 密钥 key 思考 工具 上限' },
  workspace: { icon: Folder, words: '目录 文件 路径 工作区 最近' },
  ai: { icon: Sparkles, words: '记忆 上下文 压缩 经验 轨迹 语音 联网 通知 能力' },
  life: { icon: Heart, words: '数字生命体 主动 时段 频率 限额' },
  engine: { icon: Terminal, words: '引擎 诊断 日志 下载 镜像 存储 缓存 重启 开发者' },
  about: { icon: Info, words: '关于 版本 更新 隐私 使用说明' },
}

export function SettingsNavigation<K extends keyof typeof META>({ groups, value, onChange }: {
  groups: ReadonlyArray<{ key: K; label: string }>; value: K; onChange: (key: K) => void
}) {
  const [query, setQuery] = useState('')
  const matches = groups.filter((g) => (g.label + ' ' + META[g.key].words).toLowerCase().includes(query.trim().toLowerCase()))
  return <aside className='settings-navigation'>
    <h1>设置</h1>
    <label className='settings-search'><Search size={15} /><input aria-label='搜索设置分类' placeholder='搜索设置' value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) onChange(matches[0].key) }} /></label>
    <nav aria-label='设置分类'>
      {matches.map((g) => { const Icon = META[g.key].icon; return <button type='button' key={g.key} aria-current={value === g.key ? 'page' : undefined} data-settings-group={g.key} onClick={() => onChange(g.key)}><Icon size={17} strokeWidth={1.7} /><span>{g.label}</span></button> })}
      {!matches.length && <p className='settings-no-results'>未找到分类，换个关键词试试。</p>}
    </nav>
  </aside>
}
