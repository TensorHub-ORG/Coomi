/**
 * 演示脚本：一轮完整的 Coomi 运行。
 *
 * 事件形状和真引擎完全一致（见 protocol/events.ts），所以它驱动的是同一套
 * 组件与同一条 store 分发路径。写这个脚本的目的只有一个 —— 让工具调用、
 * 授权、提问、瀑布流输出这些界面在没有引擎的时候也能看、能点。
 */
import type { AgentEvent } from '@/protocol/events'

export interface DemoCtx {
  emit(ev: AgentEvent): void
  sleep(ms: number): Promise<void>
  /** 逐字吐字；标点后会多停一下，匀速打字机不像真的流式输出。 */
  type(content: string, kind?: 'text' | 'reasoning'): Promise<void>
  waitApproval(): Promise<'allow' | 'deny' | 'always'>
  waitAnswer(): Promise<string>
}

interface ToolSpec {
  callId: string
  name: string
  args: Record<string, unknown>
  elapsed: number
  preview: string
  isError?: boolean
  /** tool_start 之前的停顿（模型在写参数） */
  think?: number
  /** running → done 的耗时 */
  work?: number
}

/** 一次完整调用：起 → 跑 → 完。三个事件都发，卡片状态机才会走全。 */
async function runTool(ctx: DemoCtx, t: ToolSpec): Promise<void> {
  await ctx.sleep(t.think ?? 200)
  ctx.emit({ event_type: 'tool_start', call_id: t.callId, tool_name: t.name, arguments: t.args })
  await ctx.sleep(150)
  ctx.emit({ event_type: 'tool_running', call_id: t.callId, tool_name: t.name })
  await ctx.sleep(t.work ?? 520)
  ctx.emit({
    event_type: 'tool_done', call_id: t.callId, tool_name: t.name,
    elapsed: t.elapsed, result_preview: t.preview, is_error: t.isError ?? false,
  })
}

function usage(input: number, output: number, ratio: number): AgentEvent {
  const contextWindow = 128_000
  return {
    event_type: 'usage_update',
    usage: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      context_ratio: ratio,
      context_used_tokens: Math.round(contextWindow * ratio),
      context_window_tokens: contextWindow,
    },
  }
}

const EDIT_ARGS = {
  file_path: 'apps/web/src/components/StatusBar.vue',
  old_string: '<span v-if="session.usage" class="usage">',
  new_string: '<span v-if="session.cacheHits" class="cache">⚡ {{ session.cacheHits }}</span>\n      <span v-if="session.usage" class="usage">',
}

export async function playDemoRun(ctx: DemoCtx): Promise<void> {
  await ctx.sleep(320)
  await ctx.type(
    '用户要两件事：讲清事件分发链路，再把 tool_cache_hit 接到状态栏。'
    + '先把协议定义和 store 里的 switch 找出来，不凭印象改。',
    'reasoning',
  )

  await ctx.sleep(220)
  await ctx.type('先定位协议定义和分发入口。\n\n')

  await runTool(ctx, {
    callId: 'c1', name: 'Glob', args: { pattern: 'apps/web/src/{protocol,bridge}/*.ts' },
    elapsed: 0.31, work: 420,
    preview: '5 matches\napps/web/src/protocol/events.ts\napps/web/src/protocol/commands.ts\n'
      + 'apps/web/src/bridge/transport.ts\napps/web/src/bridge/wsTransport.ts\napps/web/src/bridge/envelope.ts',
  })

  await runTool(ctx, {
    callId: 'c2', name: 'Read', args: { file_path: 'apps/web/src/protocol/events.ts', limit: 40 },
    elapsed: 0.12, work: 360,
    preview: "13: export interface ToolCacheHitEvent { event_type: 'tool_cache_hit'; call_id: string; tool_name: string }\n"
      + '29: export type AgentEvent = TextChunkEvent | ReasoningChunkEvent | ToolStartEvent …',
  })

  // 同一个文件读第二次：命中缓存，卡片走 cache_hit 分支（不再有耗时）
  await ctx.sleep(180)
  ctx.emit({ event_type: 'tool_start', call_id: 'c3', tool_name: 'Read', arguments: { file_path: 'apps/web/src/stores/session.ts' } })
  await ctx.sleep(240)
  ctx.emit({ event_type: 'tool_cache_hit', call_id: 'c3', tool_name: 'Read' })

  await runTool(ctx, {
    callId: 'c4', name: 'Grep', args: { pattern: 'tool_cache_hit', output_mode: 'content', '-n': true },
    elapsed: 0.47, work: 560,
    preview: 'apps/web/src/protocol/events.ts:13\n'
      + "apps/web/src/stores/session.ts:78:  case 'tool_cache_hit': patchTool(ev.call_id, c => c.status = 'cache_hit'); break\n"
      + 'apps/web/src/utils/toolMeta.ts:52\n3 matches in 3 files',
  })

  ctx.emit(usage(9120, 640, 0.21))

  await ctx.sleep(260)
  await ctx.type('链路是这样的：\n\n')
  await ctx.type(
    '1. `wsTransport.ts` 收到帧，`parseInbound` 解出信封；\n'
    + '2. `session.ts:64` 的 `applyEvent` 按 `event_type` 分发，写进 `timeline`；\n'
    + '3. `ChatView` 把连续的工具事件并成一个 `ToolGroup`，长任务就不会冲成一堵卡片墙。\n\n'
    + '`tool_cache_hit` 目前只改卡片状态（`session.ts:78`），没参与状态栏统计 —— 要补的就是这里。\n\n',
  )

  ctx.emit({ event_type: 'tool_start', call_id: 'c5', tool_name: 'Edit', arguments: EDIT_ARGS })
  await ctx.sleep(420)
  ctx.emit({
    event_type: 'tool_approval_request', call_id: 'c5', tool_name: 'Edit', arguments: EDIT_ARGS,
    access: 'write', risk_summary: '改 1 个文件、+2 −1 行：状态栏加一个缓存命中计数，不动已有逻辑。',
  })

  const decision = await ctx.waitApproval()
  if (decision === 'deny') {
    ctx.emit({
      event_type: 'tool_done', call_id: 'c5', tool_name: 'Edit',
      elapsed: 0, result_preview: '（用户拒绝执行）', is_error: true,
    })
    await ctx.sleep(320)
    await ctx.type('好，这次不动 `StatusBar.vue`。要我把改动写成 patch 贴出来吗？\n')
    ctx.emit({ event_type: 'turn_end' })
    return
  }

  ctx.emit({ event_type: 'tool_running', call_id: 'c5', tool_name: 'Edit' })
  await ctx.sleep(540)
  ctx.emit({
    event_type: 'tool_done', call_id: 'c5', tool_name: 'Edit',
    elapsed: 0.08, result_preview: 'Edited apps/web/src/components/StatusBar.vue\n+2 −1', is_error: false,
  })

  // 改完跑校验：三步小循环，顺带演示进度条和后台任务
  await ctx.sleep(240)
  ctx.emit({ event_type: 'loop_step_start', step_index: 1, step_description: '类型检查 vue-tsc', total_steps: 3 })
  ctx.emit({ event_type: 'loop_progress', current_step: 1, total_steps: 3, status: 'running' })
  await ctx.sleep(560)
  ctx.emit({ event_type: 'bg_task_detached', task_id: '7f2', tool_name: 'Bash' })
  await ctx.sleep(700)
  ctx.emit({ event_type: 'loop_step_start', step_index: 2, step_description: '构建 vite build', total_steps: 3 })
  ctx.emit({ event_type: 'loop_progress', current_step: 2, total_steps: 3, status: 'running' })
  await ctx.sleep(640)
  ctx.emit({ event_type: 'bg_task_completed', task_id: '7f2', tool_name: 'Bash', is_error: false })

  await ctx.sleep(300)
  ctx.emit({
    event_type: 'user_question_request', call_id: 'q1',
    questions: [{
      id: 'cache_display', header: '缓存显示', question: '状态栏里的缓存命中要显示成哪种？',
      options: [
        { label: '⚡ 3（图标 + 次数）', description: '显示紧凑' },
        { label: '缓存 3/12（命中 / 总调用）', description: '信息完整' },
        { label: '仅在 >0 时显示次数', description: '减少干扰' },
      ],
    }],
  })
  const answer = await ctx.waitAnswer()

  await ctx.sleep(260)
  await ctx.type('按「' + answer + '」来。剩下的第三步跑测试。', 'reasoning')
  ctx.emit({ event_type: 'loop_step_start', step_index: 3, step_description: '单元测试', total_steps: 3 })
  ctx.emit({ event_type: 'loop_progress', current_step: 3, total_steps: 3, status: 'running' })
  await ctx.sleep(620)
  ctx.emit({ event_type: 'loop_progress', current_step: 3, total_steps: 3, status: 'done' })

  ctx.emit({ event_type: 'compression', before: 128_400, after: 41_900 })
  await ctx.sleep(280)

  await ctx.type('改完了，状态栏现在按你选的方式显示。\n\n')
  await ctx.type(
    '```diff\n'
    + '   <div class="row">\n'
    + '+    <span v-if="session.cacheHits" class="cache">⚡ {{ session.cacheHits }}</span>\n'
    + '     <span v-if="session.usage" class="usage">\n'
    + '```\n\n',
  )
  await ctx.type(
    '| 事件 | 之前 | 现在 |\n| --- | --- | --- |\n'
    + '| `tool_done` | 卡片转成功 | 不变 |\n'
    + '| `tool_cache_hit` | 只改卡片 | 卡片 + 状态栏计数 |\n\n'
    + '要不要我把命中率也一起算进上下文那一行？\n',
  )

  ctx.emit(usage(41_900, 1_180, 0.34))
  ctx.emit({ event_type: 'turn_end' })
}

/** 演示模式下「停止」的收尾：真引擎也是先 cancelled 再 turn_end。 */
export function emitCancelled(ctx: Pick<DemoCtx, 'emit'>): void {
  ctx.emit({ event_type: 'agent_cancelled' })
  ctx.emit({ event_type: 'turn_end' })
}
