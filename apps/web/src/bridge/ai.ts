/**
 * Git AI 辅助（Wave 3 引擎 API）封装。
 *
 * 全部端点 POST /api/git/ai/*，返回 `{ "text": "…" }`：
 * - commit-message {context?}：根据暂存/改动生成提交信息
 * - summarize {since?}：变更总结
 * - review {path?}：代码审查（path 省略时审查全部改动）
 * - conflict {path}：冲突解决建议
 * - readme：项目 README 生成
 */
import { apiSend } from './http'

/** AI 文本端点的统一应答。 */
export interface AiText {
  text: string
}

export function aiCommitMessage(context?: string): Promise<AiText> {
  return apiSend('/api/git/ai/commit-message', 'POST', context ? { context } : undefined)
}

export function aiSummarize(since?: string): Promise<AiText> {
  return apiSend('/api/git/ai/summarize', 'POST', since ? { since } : undefined)
}

export function aiReview(path?: string): Promise<AiText> {
  return apiSend('/api/git/ai/review', 'POST', path ? { path } : undefined)
}

export function aiConflict(path: string): Promise<AiText> {
  return apiSend('/api/git/ai/conflict', 'POST', { path })
}

export function aiReadme(): Promise<AiText> {
  return apiSend('/api/git/ai/readme', 'POST')
}
