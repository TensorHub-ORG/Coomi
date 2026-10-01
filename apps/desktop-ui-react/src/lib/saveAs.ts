/**
 * 另存为（桌面壳命令 save_file_as 的前端入口）。
 *
 * 分工：**对话框与复制都在壳里做**（Tauri 的原生保存对话框 + 同盘 rename / 回退 copy），
 * 前端只给「源文件路径 + 建议文件名」，拿回新路径。这样：
 *  · 覆盖确认由系统对话框负责，界面不会自作主张地静默覆盖；
 *  · 失败原因（权限 / 磁盘满 / 被占用）由壳翻译成中文一句话，这里原样透出；
 *  · 浏览器直跑（没有壳）时给出可读的一句，而不是一句 "undefined is not a function"。
 *
 * 调用方一律走 saveArtifactAs / savePreviewedFileAs：它们负责把结果说成一句人话
 * （取消不报错、成功报落点），各处不必重复写 toast 文案。
 */
import { toast } from 'sonner'
import { ipc } from './ipc'
import { shortPath } from './format'

/** 壳命令 save_file_as 的回执（Rust 的 SaveAsReport，serde camelCase）。 */
export interface SaveAsReport {
  /** 用户在系统对话框里点了取消：不是失败，界面只提示一句。 */
  canceled: boolean
  path: string
  name: string
  size: number
  /** 这次选的目录与上一次不同（壳记着上次的位置，见 desktop-ui.json 的 lastSaveDir）。 */
  dirChanged: boolean
}

/** 调用壳命令。失败抛 Error，消息可直接展示。 */
export async function saveFileAs(input: { source: string; suggestedName?: string }): Promise<SaveAsReport> {
  const source = input.source.trim()
  if (!source) throw new Error('没有可另存的文件：路径是空的')
  return ipc<SaveAsReport>('save_file_as', { source, suggestedName: input.suggestedName ?? '' })
}

/** 失败原因转成一句可展示的话（壳给的中文原样用，壳不可用时补一句说明）。 */
export function describeSaveError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (!message) return '未知原因'
  if (/桌面壳未就绪|not in a Tauri|Tauri environment/i.test(message)) {
    return '另存为需要桌面版：当前不在桌面壳里运行（浏览器里可直接用「复制路径」或浏览器下载）'
  }
  return message
}

/** 另存为的完整动作：弹对话框 → 复制 → 按结果给一句提示。 */
export async function saveArtifactAs(item: { path: string; name: string }): Promise<void> {
  try {
    const report = await saveFileAs({ source: item.path, suggestedName: item.name })
    if (report.canceled) {
      toast.message('已取消另存为')
      return
    }
    const at = report.path ? shortPath(report.path, 60) : report.name
    toast.success(report.dirChanged ? '已另存到：' + at : '已另存：' + at)
  } catch (error) {
    toast.error('另存为失败：' + describeSaveError(error))
  }
}
