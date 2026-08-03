<script setup lang="ts">
/**
 * 主聊天窗口。
 *
 * 三件事和别处不一样：
 * 1) 抽屉打开时整个 shell 往右推 + 轻微缩放，是 DeepSeek 的那种层次感；
 * 2) 跟随滚动交给 useAutoScroll，高度变化用 ResizeObserver 兜住 ——
 *    markdown 重排、工具卡展开、软键盘弹出都会改高度，只 watch 数组长度会漏；
 * 3) 连续的工具调用合并成一个 ToolGroup，避免长任务把时间线冲成一堵卡片墙。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useSessionsStore } from '@/stores/sessions'
import { useConfigStore } from '@/stores/config'
import { apiGet } from '@/bridge/http'
import { DEMO_PROMPT, isUnattended, shouldAutoplay } from '@/bridge/demoMode'
import { useAutoScroll } from '@/composables/useAutoScroll'
import type { Timelineitem, ToolCard } from '@/stores/viewModel'
import type { ApprovalDecision } from '@/protocol/commands'
import TopBar from '@/components/TopBar.vue'
import SideDrawer from '@/components/SideDrawer.vue'
import StatusBar from '@/components/StatusBar.vue'
import Composer from '@/components/Composer.vue'
import EmptyState from '@/components/EmptyState.vue'
import MessageBubble from '@/components/MessageBubble.vue'
import ToolGroup from '@/components/ToolGroup.vue'
import ReasoningBlock from '@/components/ReasoningBlock.vue'
import NoticeItem from '@/components/NoticeItem.vue'
import LoopProgressBar from '@/components/LoopProgressBar.vue'
import ApprovalSheet from '@/components/ApprovalSheet.vue'
import QuestionSheet from '@/components/QuestionSheet.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

type Block =
  | { t: 'one'; key: string; item: Timelineitem }
  | { t: 'tools'; key: string; cards: ToolCard[] }

const session = useSessionStore()
const sessions = useSessionsStore()
const config = useConfigStore()

const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const drawerOpen = ref(false)
/** 全局轮询「后台运行中」状态的定时器（会话列表转圈的数据源）。 */
let runningPoll: ReturnType<typeof setInterval> | null = null

/** 长会话动态加载：只渲染最近一段，顶部可「加载更早记录」。 */
const RENDER_WINDOW = 60
const windowSize = ref(RENDER_WINDOW)
const hasMore = computed(() => session.timeline.length > windowSize.value)
function loadMore() { windowSize.value += RENDER_WINDOW }
// 新消息到达时 slice(-windowSize) 自动包含最新，无需额外 watch

const { following, follow, jumpToBottom } = useAutoScroll(scroller)

function idOf(i: Timelineitem): string { return 'id' in i ? i.id : i.callId }

const blocks = computed<Block[]>(() => {
  const out: Block[] = []
  const items = session.timeline.slice(-windowSize.value)
  for (const item of items) {
    if (item.kind === 'tool') {
      const last = out[out.length - 1]
      if (last && last.t === 'tools') { last.cards.push(item); continue }
      out.push({ t: 'tools', key: 'g:' + item.callId, cards: [item] })
      continue
    }
    out.push({ t: 'one', key: item.kind + ':' + idOf(item), item })
  }
  return out
})

let ro: ResizeObserver | null = null

onMounted(() => {
  session.connect()
  // 记录引擎当前工作目录，会话列表据此把不同项目的会话隔离开。
  void apiGet<{ cwd?: string }>('/api/runtime/health')
    .then(h => { if (h?.cwd) sessions.setCurrentCwd(h.cwd) })
    .catch(() => { /* 引擎未就绪时保持空 cwd，列表退化为全部显示 */ })
  // 以引擎磁盘会话为权威源同步列表，修复“会话记录消失/串会话”。
  void sessions.syncFromEngine()
  if (config.providers.length === 0) void config.fetchProviders()
  // 全局记忆开关以引擎为权威：启动即同步，避免「开关显示关、引擎实际开」的脱节。
  void config.syncGlobalMemoryFromEngine()
  // 全局轮询各会话的「后台运行中」状态：切走会话后任务在引擎侧继续跑，
  // 抽屉/会话页据此显示转圈。轮询常驻（本地 API 开销极小），不依赖抽屉打开。
  void sessions.refreshRunning()
  runningPoll = setInterval(() => sessions.refreshRunning(), 2000)
  // 高度只要变就重新贴底（内部有 rAF 合并，不怕高频触发）
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => follow())
    if (content.value) ro.observe(content.value)
    if (scroller.value) ro.observe(scroller.value)
  }
  nextTick(follow)
  // 演示模式自动播一轮，省得进来还要先打字才能看见瀑布流。
  if (shouldAutoplay() && session.timeline.length === 0) {
    setTimeout(() => { if (session.timeline.length === 0) session.sendMessage(DEMO_PROMPT) }, 700)
  }
})

onBeforeUnmount(() => {
  if (runningPoll) { clearInterval(runningPoll); runningPoll = null }
  ro?.disconnect(); ro = null
})

/**
 * 无人值守演示（?demo=1&auto=1）：授权弹层和提问弹层过一会儿自己点掉。
 * 走的是 approve / answerQuestion —— 和真手指按下去完全同一条路，
 * 所以卡片状态、「已回答」气泡都跟着变。截图、录屏、摆着自演都靠它。
 */
if (isUnattended()) {
  const AUTOPILOT_DELAY = 1600
  watch(() => session.pendingApproval?.callId, id => {
    if (!id) return
    setTimeout(() => { if (session.pendingApproval?.callId === id) session.approve(id, 'allow') }, AUTOPILOT_DELAY)
  })
  watch(() => session.pendingQuestion?.callId, id => {
    if (!id) return
    setTimeout(() => {
      const q = session.pendingQuestion
      if (q?.callId === id) session.answerQuestion(id, q.options?.[0] ?? '你定就行')
    }, AUTOPILOT_DELAY)
  })
}

// ResizeObserver 不可用时的兜底：至少条目增减能跟上。
watch(() => session.timeline.length, () => nextTick(follow))

function onDecide(callId: string, decision: ApprovalDecision) { session.approve(callId, decision) }
function onAnswer(callId: string, text: string) { session.answerQuestion(callId, text) }
</script>

<template>
  <div class="chat">
    <div class="shell" :class="{ pushed: drawerOpen }">
      <TopBar @menu="drawerOpen = true" />

      <main ref="scroller" class="stream">
        <div ref="content" class="inner">
          <EmptyState v-if="session.timeline.length === 0" />

          <button v-if="hasMore" class="load-more" @click="loadMore">
            加载更早记录（还有 {{ session.timeline.length - windowSize }} 条）
          </button>

          <template v-for="b in blocks" :key="b.key">
            <ToolGroup v-if="b.t === 'tools'" :cards="b.cards" />
            <template v-else>
              <MessageBubble
                v-if="b.item.kind === 'user' || b.item.kind === 'assistant'"
                :msg="b.item"
              />
              <ReasoningBlock v-else-if="b.item.kind === 'reasoning'" :block="b.item" />
              <NoticeItem v-else-if="b.item.kind === 'notice'" :notice="b.item" />
              <div
                v-else-if="b.item.kind === 'question' && b.item.answered"
                class="q-answered cascade"
              >
                <span class="q-label">已回答</span> {{ b.item.answer }}
              </div>
            </template>
          </template>
        </div>
      </main>

      <Transition name="pop">
        <button v-if="!following" class="to-bottom" aria-label="回到底部" @click="jumpToBottom">
          <CoomiIcon name="arrowDown" :size="18" />
        </button>
      </Transition>

      <LoopProgressBar v-if="session.loop.active" :loop="session.loop" />
      <StatusBar />
      <Composer />
    </div>

    <SideDrawer :open="drawerOpen" @close="drawerOpen = false" />

    <ApprovalSheet
      v-if="session.pendingApproval"
      :card="session.pendingApproval"
      @decide="(d: ApprovalDecision) => onDecide(session.pendingApproval!.callId, d)"
    />
    <QuestionSheet
      v-else-if="session.pendingQuestion"
      :card="session.pendingQuestion"
      @answer="(t: string) => onAnswer(session.pendingQuestion!.callId, t)"
    />
  </div>
</template>

<style scoped>
.chat { height: 100%; min-height: 0; background: var(--bg); }

.shell {
  position: relative;
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--bg);
  transform-origin: left center;
  /* 只保留 transform 动画：Android WebView 里 transform+border-radius 同时
     过渡会反复重建合成层，表现为打开侧边栏时主内容文字闪烁。
     will-change 让合成层常驻，避免动画开始/结束时闪一下。 */
  transition: transform .3s cubic-bezier(.22, .68, .19, 1);
  will-change: transform;
}
.shell.pushed {
  /* origin 为 left center 时，scale(.94) 使右边缘内缩 6%；
     translateX(6%) 精确抵消，保证右侧始终贴住屏幕右缘（不会右侧被裁）。 */
  transform: translateX(6%) scale(.94);
  border-radius: 20px;
  overflow: hidden;
  box-shadow: var(--shadow-2);
}

.stream {
  flex: 1; min-width: 0; min-height: 0; max-width: 100%; overflow-x: hidden; overflow-y: auto;
  -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain;
}
.inner {
  display: flex; flex-direction: column; gap: 12px;
  width: 100%; min-width: 0; min-height: 100%; padding: 10px 12px 18px; overflow-x: hidden;
}

.to-bottom {
  position: absolute; left: 50%; bottom: 116px; z-index: 8;
  display: grid; place-items: center;
  width: 38px; height: 38px; margin-left: -19px;
  border: 1px solid var(--border); border-radius: 50%;
  background: var(--bg); color: var(--text-2);
  box-shadow: var(--shadow-2);
}
.to-bottom:active { background: var(--fill); }
.load-more {
  display: block; margin: 4px auto 12px; padding: 7px 16px;
  border-radius: var(--r-pill); border: 1px dashed var(--border-strong);
  background: transparent; color: var(--text-3);
  font-size: 12.5px; font-weight: 550;
}
.load-more:active { background: var(--fill); }
.pop-enter-active, .pop-leave-active { transition: opacity .18s ease, transform .18s ease; }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: translateY(8px) scale(.9); }

.q-answered {
  align-self: flex-end; max-width: 84%;
  padding: 7px 13px; border-radius: var(--r-pill);
  background: var(--fill); font-size: 12.5px; color: var(--text-2);
}
.q-label { color: var(--blue); font-weight: 600; }
</style>
