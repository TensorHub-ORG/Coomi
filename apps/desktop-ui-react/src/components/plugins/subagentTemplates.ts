/**
 * 插件子智能体模板的收集（纯逻辑；SubagentPanel 的新建区与测试共用这一份）。
 *
 * 数据来自插件声明的 subagents 项（plugin_list 下发，见 pluginStore.ts 的 PluginSubagentTemplate）：
 *  - 只收集**已启用**插件的模板；
 *  - 点击即建：前端只把 pluginId + templateId 交给壳（plugin_spawn_subagent），
 *    systemPrompt 由壳/引擎侧保存，前端不碰提示词。
 */
import { effectiveEnabled, type PluginEntry, type PluginPrefs } from './pluginStore'

/** 新建区里的一条插件子智能体模板。 */
export interface PluginSubagentTemplateItem {
  /** 唯一键（插件 id + 模板名/id），渲染 key 与忙碌锁用。 */
  key: string
  pluginId: string
  /** 来源插件名（标注出处）。 */
  plugin: string
  /** 模板 id（壳侧保存 systemPrompt 的键）；缺省时前端用 name 充当。 */
  id?: string
  name: string
  description?: string
}

/** 从已启用插件里收集子智能体模板（按插件顺序展开）。 */
export function collectPluginSubagentTemplates(plugins: PluginEntry[], prefs: PluginPrefs): PluginSubagentTemplateItem[] {
  const out: PluginSubagentTemplateItem[] = []
  for (const p of plugins) {
    if (!effectiveEnabled(p, prefs)) continue
    for (const t of p.subagents ?? []) {
      const name = t.name?.trim()
      if (!name) continue
      out.push({
        key: p.id + '::' + (t.id ?? name),
        pluginId: p.id,
        plugin: p.name || p.id,
        id: t.id?.trim() || undefined,
        name,
        description: t.description?.trim() || undefined,
      })
    }
  }
  return out
}
