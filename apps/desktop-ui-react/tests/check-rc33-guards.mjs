#!/usr/bin/env node
/**
 * rc33 护栏：两件事
 *   A. 「做任务一半停了就不回我」——引擎发了 retry_confirmation，前端以前零处理
 *   B. 厂商重写第一刀 —— 新建也能拉模型 + 保存后广播，不再「主页说没有配置模型」
 * 运行：node tests/check-rc33-guards.mjs
 */
import { readFileSync } from 'node:fs'

let failed = 0
let total = 0
function ok(name, condition, detail) {
  total += 1
  if (condition) return
  failed += 1
  console.error('FAIL ' + name + (detail === undefined ? '' : '\n  ' + detail))
}
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const chat = read('../src/lib/chat.ts')
const session = read('../src/stores/session.ts')
const stats = read('../src/components/chat/StatsBar.tsx')
const list = read('../src/components/chat/MessageList.tsx')
const wizard = read('../src/components/settings/ProviderWizard.tsx')
const agent = read('../src/stores/agent.ts')
const composer = read('../src/components/chat/Composer.tsx')
const settings = read('../src/views/SettingsView.tsx')
const engine = read('../../coomi-rs/ui/src/web/mod.rs')

/* ── A. 中断可见 + 可继续 ── */
ok('A1 前端渲染 retry_confirmation', chat.includes("if (type === 'retry_confirmation')"))
ok('A1 通知卡带 resume（可继续这一轮）', chat.includes('resume: true') && list.includes('继续这一轮'))
ok('A1 卡片带「已用 N/M 轮工具」与最后工具', chat.includes('rounds_used') && chat.includes('last_tool'))
ok('A2 前端处理 connection_retry（自动重试可见）', session.includes("if (type === 'connection_retry')"))
ok('A2 状态条显示「正在自动恢复」', stats.includes('正在自动恢复（第'))
ok('A2 retrying 状态有类型与初值', session.includes('retrying: { attempt: number; max: number; delayMs: number; at: number } | null') && session.includes('retrying: null,'))
ok('A3 内容回来/轮结束会清掉重试提示', session.includes('set({ streaming: true, retrying: null })'))
ok('A4 引擎的 interruption 事件带机器可读字段', engine.includes('"reason": if round_limit_reached') && engine.includes('"resumable": true'))
ok('A5 引擎记住上一轮输入与连接上下文', engine.includes('last_prompt: StdMutex<Option<QueuedPrompt>>') && engine.includes('last_context: StdMutex<Option<Arc<ConnectionContext>>>'))
ok('A5 任务中心重试真的重新起一轮', /"retry" => \{[\s\S]{0,1400}spawn_turn_worker\(/.test(engine))

/* ── B. 厂商：新建可拉模型 + 保存后广播 ── */
ok('B1 引擎有无状态预览端点', engine.includes('async fn discover_models_preview') && engine.includes('"/api/providers/discover-models-preview"'))
ok('B2 预览端点不落盘', !/async fn discover_models_preview[\s\S]{0,2000}\.save\(/.test(engine))
ok('B3 向导新建时走预览端点', wizard.includes("'/api/providers/discover-models-preview'"))
ok('B3 不再拦「新厂商先保存一次」', !wizard.includes('新厂商先保存一次，再回来拉取模型清单'))
ok('B4 agent store 有 providerRevision', agent.includes('providerRevision: number') && agent.includes('bumpProviders: () =>'))
ok('B4 对话页订阅它重拉 providers', composer.includes('providerRevision]'))
ok('B4 设置页保存/删除后广播', settings.includes('useAgent.getState().bumpProviders()'))

if (failed) {
  console.error('\n' + failed + '/' + total + ' 条断言失败')
  process.exit(1)
}
console.log('OK  ' + total + ' 个断言通过：中断可见可继续 + 新建可拉模型 + 保存后广播')
