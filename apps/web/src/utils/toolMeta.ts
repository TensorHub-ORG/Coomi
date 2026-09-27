/**
 * 工具的显示身份：图标 + 中文动词 + 主要目标。
 * 工具卡和授权弹层共用一份，避免两处各写一套映射后慢慢漂移。
 */

export interface ToolMeta { icon: string; verb: string }

const TOOLS: Record<string, ToolMeta> = {
  bash: { icon: 'terminal', verb: '运行命令' },
  read: { icon: 'fileRead', verb: '读取文件' },
  write: { icon: 'fileWrite', verb: '写入文件' },
  edit: { icon: 'fileEdit', verb: '编辑文件' },
  multiedit: { icon: 'fileEdit', verb: '批量编辑' },
  notebookedit: { icon: 'fileEdit', verb: '编辑 Notebook' },
  glob: { icon: 'folder', verb: '查找文件' },
  ls: { icon: 'folder', verb: '列出目录' },
  grep: { icon: 'grep', verb: '搜索内容' },
  webfetch: { icon: 'globe', verb: '抓取网页' },
  websearch: { icon: 'globe', verb: '联网搜索' },
  web_search: { icon: 'globe', verb: '联网搜索' },
  request_file_import: { icon: 'fileRead', verb: '选择手机文件' },
  request_file_export: { icon: 'fileWrite', verb: '导出到手机' },
  task: { icon: 'subtask', verb: '子任务' },
  todowrite: { icon: 'todo', verb: '更新计划' },
  askuserquestion: { icon: 'user', verb: '向你提问' },
}

/** 参数里挑一个最能说明「对什么下手」的字段。 */
const TARGET_KEYS = ['command', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'description']

export function toolMeta(name: string): ToolMeta {
  return TOOLS[name.toLowerCase()] ?? { icon: 'wrench', verb: name }
}

export function toolTarget(args: Record<string, unknown> | undefined): string {
  const a = args ?? {}
  for (const k of TARGET_KEYS) {
    const v = a[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  const first = Object.values(a).find(v => typeof v === 'string' && v.trim())
  return typeof first === 'string' ? first.trim() : ''
}

export function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return JSON.stringify(v, null, 2)
}
