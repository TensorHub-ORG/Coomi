/**
 * 插件斜杠命令的收集与模板填入（纯逻辑，不碰 React；Composer 与测试共用这一份）。
 *
 * 数据全部来自插件声明的 slash 项（plugin_list 下发，见 pluginStore.ts 的 PluginSlashCommand）：
 *  - 只收集**已启用**插件的命令（effectiveEnabled 与插件列表共用同一判据）；
 *  - 选中后把 template 填入输入框，模板里的 {{cursor}} 是光标占位（见 applySlashTemplate）。
 */
import { effectiveEnabled, type PluginEntry, type PluginPrefs } from './pluginStore'

/** 斜杠菜单里的一条：展示与填入所需的字段都齐了。 */
export interface SlashItem {
  /** 唯一键（插件 id + 命令），渲染 key 用。 */
  key: string
  /** 显示的命令名（含斜杠，如 /review）。 */
  command: string
  /** 来源插件名（菜单里标注出处）。 */
  plugin: string
  description?: string
  /** 选中后填入输入框的模板；{{cursor}} 是光标占位。 */
  template: string
}

/** 从已启用插件里收集斜杠命令（按插件顺序展开）。 */
export function collectPluginSlash(plugins: PluginEntry[], prefs: PluginPrefs): SlashItem[] {
  const out: SlashItem[] = []
  for (const p of plugins) {
    if (!effectiveEnabled(p, prefs)) continue
    for (const sc of p.slash ?? []) {
      const name = sc.name?.trim()
      if (!name) continue
      const command = sc.command?.trim() || '/' + name
      out.push({
        key: p.id + '::' + command,
        command,
        plugin: p.name || p.id,
        description: sc.description?.trim() || undefined,
        template: sc.template ?? '',
      })
    }
  }
  return out
}

/** 按输入前缀过滤：输入「/re」与裸字「re」都匹配命令名；空查询返回全部。 */
export function filterSlash(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase().replace(/^\//, '')
  if (!q) return items
  return items.filter((it) => {
    const cmd = it.command.toLowerCase().replace(/^\//, '')
    return cmd.startsWith(q) || (it.description ?? '').toLowerCase().includes(q)
  })
}

/**
 * 把模板填入草稿：在 selectionStart 处插入，模板里的 {{cursor}} 换成光标落点。
 * 返回 { text, cursor }：cursor 是插入后光标应处的索引。
 * 模板里没有 {{cursor}} 时，光标落在模板末尾。
 */
export function applySlashTemplate(
  draft: string,
  selectionStart: number,
  template: string,
): { text: string; cursor: number } {
  const head = draft.slice(0, selectionStart)
  const tail = draft.slice(selectionStart)
  const marker = '{{cursor}}'
  const idx = template.indexOf(marker)
  if (idx < 0) {
    return { text: head + template + tail, cursor: head.length + template.length }
  }
  const before = template.slice(0, idx)
  const after = template.slice(idx + marker.length)
  return { text: head + before + after + tail, cursor: head.length + before.length }
}

/**
 * 检测「正在敲斜杠命令」：光标前最近一个 / 在行首或空白后、且其后只有命令名字符时返回查询串。
 * URL（如 /usr/bin）中间夹的斜杠不算；返回 null 表示不弹菜单。
 */
export function detectSlashQuery(text: string, pos: number): string | null {
  const before = text.slice(0, Math.max(0, pos))
  const idx = before.lastIndexOf('/')
  if (idx < 0) return null
  // 斜杠前面必须是行首或空白：URL、路径里的斜杠不触发。
  if (idx > 0 && !/\s/.test(before[idx - 1]!)) return null
  const rest = before.slice(idx + 1)
  if (!/^[A-Za-z0-9_-]*$/.test(rest)) return null
  return rest
}
