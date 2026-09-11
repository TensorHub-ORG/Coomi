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
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { useSessionStore } from '@/stores/session'
import { useSessionsStore } from '@/stores/sessions'
import { useConfigStore } from '@/stores/config'
import { apiGet } from '@/bridge/http'
import { DEMO_PROMPT, isUnattended, shouldAutoplay } from '@/bridge/demoMode'
import { useAutoScroll } from '@/composables/useAutoScroll'
import type { ToolCard } from '@/stores/viewModel'
import { buildTimelineBlocks, type TimelineBlockItem } from '@/utils/chatTimeline'
import type { ApprovalDecision } from '@/protocol/commands'
import TopBar from '@/components/TopBar.vue'
import UxProgramBar from '@/components/UxProgramBar.vue'
import SideDrawer from '@/components/SideDrawer.vue'
import StatusBar from '@/components/StatusBar.vue'
import Composer from '@/components/Composer.vue'
import EmptyState from '@/components/EmptyState.vue'
import TimelineBlock from '@/components/TimelineBlock.vue'
import LoopProgressBar from '@/components/LoopProgressBar.vue'
import ApprovalSheet from '@/components/ApprovalSheet.vue'
import QuestionSheet from '@/components/QuestionSheet.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

const props = defineProps<{ floating?: boolean }>()

const session = useSessionStore()
const sessions = useSessionsStore()
const config = useConfigStore()

const scroller = ref<HTMLElement | null>(null)
const virtualScroller = ref<InstanceType<typeof DynamicScroller> | null>(null)
/** 空状态使用 main，时间线挂载后切换到 DynamicScroller 自己的滚动容器。 */
const scrollHost = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const drawerOpen = ref(false)
/** 全局轮询「后台运行中」状态的定时器（会话列表转圈的数据源）。 */
let runningPoll: ReturnType<typeof setInterval> | null = null
const openSessionFromNative = (event: Event) => {
  const id = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId
  if (id) void session.openSession(id)
}

const { following, follow, jumpToBottom } = useAutoScroll(scrollHost)

function syncScrollHost() {
  const virtualEl = virtualScroller.value?.$el as HTMLElement | undefined
  scrollHost.value = session.timeline.length > 0 && virtualEl instanceof HTMLElement
    ? virtualEl
    : scroller.value
}

const blocks = computed<TimelineBlockItem[]>(() => buildTimelineBlocks(session.timeline))

/** 生命体未读问候的触发类型 → 药丸标题（morning/egg 直接展示类型文案）。 */
const LIFE_TRIGGER_LABELS: Record<string, string> = {
  morning: '早安播报',
  egg: '每日彩蛋',
  milestone_stage: '里程碑时刻',
  everyday: '日常问候',
}
const lifePillTitle = computed(() => {
  const label = LIFE_TRIGGER_LABELS[session.lifeUnread[0]?.trigger ?? '']
  return label || `${session.lifeUnreadName || '数字生命体'} 想对你说`
})

function syncDigitalLifeMode() {
  config.syncDigitalLifeEnabled()
  if (!session.isBusy) session.syncLifeMode()
}

let ro: ResizeObserver | null = null

onMounted(() => {
  session.connect()
  window.addEventListener('coomi:open-session', openSessionFromNative)
  window.addEventListener('coomi:flush-persistence', session.flushPersistence)
  // 记录引擎当前工作目录，会话列表据此把不同项目的会话隔离开。
  void apiGet<{ cwd?: string }>('/api/runtime/health')
    .then(h => { if (h?.cwd) sessions.setCurrentCwd(h.cwd) })
    .catch(() => { /* 引擎未就绪时保持空 cwd，列表退化为全部显示 */ })
  // 以引擎磁盘会话为权威源同步列表，修复“会话记录消失/串会话”。
  void sessions.syncFromEngine()
  if (config.providers.length === 0) void config.fetchProviders()
  // 全局记忆开关以引擎为权威：启动即同步，避免「开关显示关、引擎实际开」的脱节。
  void config.syncGlobalMemoryFromEngine()
  syncDigitalLifeMode()
  window.addEventListener('focus', syncDigitalLifeMode)
  // 全局轮询各会话的「后台运行中」状态：切走会话后任务在引擎侧继续跑，
  // 抽屉/会话页据此显示转圈。轮询常驻（本地 API 开销极小），不依赖抽屉打开。
  void sessions.refreshRunning()
  runningPoll = setInterval(() => { sessions.refreshRunning(); void session.refreshLifeUnread(); session.autoDeliverLifeIfReady() }, 2000)
  void session.refreshLifeUnread()
  // 高度只要变就重新贴底（内部有 rAF 合并，不怕高频触发）
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => follow())
    if (content.value) ro.observe(content.value)
    if (scroller.value) ro.observe(scroller.value)
    syncScrollHost()
    if (scrollHost.value && scrollHost.value !== scroller.value) {
      ro.observe(scrollHost.value)
      const wrapper = scrollHost.value.querySelector<HTMLElement>('.vue-recycle-scroller__item-wrapper')
      if (wrapper) ro.observe(wrapper)
    }
  }
  nextTick(() => { syncScrollHost(); follow() })
  // 演示模式自动播一轮，省得进来还要先打字才能看见瀑布流。
  if (shouldAutoplay() && session.timeline.length === 0) {
    setTimeout(() => { if (session.timeline.length === 0) session.sendMessage(DEMO_PROMPT) }, 700)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('coomi:open-session', openSessionFromNative)
  window.removeEventListener('coomi:flush-persistence', session.flushPersistence)
  window.removeEventListener('focus', syncDigitalLifeMode)
  closeDrawer()
  session.flushPersistence()
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
      if (q?.callId === id) {
        session.answerQuestion(id, Object.fromEntries(q.questions.map(question => [question.id, question.options[0]?.label ?? ''])))
      }
    }, AUTOPILOT_DELAY)
  })
}

// ResizeObserver 不可用时的兜底：至少条目增减能跟上；同时更新空态/虚拟列表滚动宿主。
watch(() => session.timeline.length, () => nextTick(() => { syncScrollHost(); follow() }), { flush: 'post' })
watch(scrollHost, host => {
  if (!ro || !host || host === scroller.value) return
  ro.observe(host)
  const wrapper = host.querySelector<HTMLElement>('.vue-recycle-scroller__item-wrapper')
  if (wrapper) ro.observe(wrapper)
}, { flush: 'post' })
watch([() => config.digitalLifeEnabled, () => config.lifeGlobalMode, () => session.isBusy], ([, , busy]) => {
  if (!busy) session.syncLifeMode()
})

function onDecide(callId: string, decision: ApprovalDecision) { session.approve(callId, decision) }
function onAnswer(callId: string, answers: Record<string, string>) { session.answerQuestion(callId, answers) }
function openDrawer() { drawerOpen.value = true; registerOverlay('side-drawer', closeDrawer) }
function closeDrawer() { drawerOpen.value = false; unregisterOverlay('side-drawer') }


watch(() => session.pendingApproval?.callId, (id, previous) => {
  if (previous) unregisterOverlay(`approval:${previous}`)
  if (id) registerOverlay(`approval:${id}`, () => session.approve(id, 'deny'))
})
watch(() => session.pendingQuestion?.callId, (id, previous) => {
  if (previous) unregisterOverlay(`question:${previous}`)
  if (id) registerOverlay(`question:${id}`, () => session.answerQuestion(id, {}))
})
</script>

<template>
  <div class="chat">
    <div class="shell" :class="{ pushed: drawerOpen }">
      <TopBar :floating="props.floating" @menu="openDrawer" />
      <UxProgramBar />

      <main ref="scroller" class="stream">
        <div v-if="session.timeline.length === 0" ref="content" class="inner empty-inner">
          <EmptyState v-if="session.timeline.length === 0" />
        </div>
        <DynamicScroller
          v-else
          ref="virtualScroller"
          :items="blocks"
          key-field="key"
          :min-item-size="48"
          :buffer="640"
          class="virtual-stream"
        >
          <template #default="{ item, index, active }">
            <DynamicScrollerItem
              :item="item"
              :active="active"
              :size-dependencies="[item, item.t === 'one' ? item.item : item.cards]"
              :data-index="index"
              class="virtual-item"
              emit-resize
              @resize="follow"
            >
              <TimelineBlock :block="item" />
            </DynamicScrollerItem>
          </template>
        </DynamicScroller>
      </main>

      <Transition name="pop">
        <button v-if="!following" class="to-bottom" aria-label="回到底部" @click="jumpToBottom">
          <CoomiIcon name="arrowDown" :size="18" />
        </button>
      </Transition>

      <LoopProgressBar v-if="session.loop.active" :loop="session.loop" />
      <div v-if="session.retryConfirmation" class="retry-confirm">
        <div><CoomiIcon name="alert" :size="16" /><span>{{ session.retryConfirmation }}</span></div>
        <div class="retry-actions">
          <button class="retry-secondary" @click="session.dismissRetry()">结束任务</button>
          <button class="retry-primary" @click="session.retryInterruptedTurn()">继续重试</button>
        </div>
      </div>
      <div v-if="session.undoConfirm" class="retry-confirm">
        <div><CoomiIcon name="arrowLeft" :size="16" /><span>确定回撤这一轮？将撤回该轮执行与产生的所有修改，并返回上一轮状态。</span></div>
        <div class="retry-actions">
          <button class="retry-secondary" @click="session.cancelUndo()">取消</button>
          <button class="retry-primary" @click="session.confirmUndo()">确认回撤</button>
        </div>
      </div>
      <Transition name="pop">
        <button
          v-if="session.lifeUnread.length && session.isGlobalSession && session.mode === 'life' && !session.isBusy"
          class="life-pill"
          type="button"
          @click="session.deliverLife()"
        >
          <CoomiIcon name="lifeRings" :size="15" />
          <span class="life-pill-label">{{ lifePillTitle }}</span>
          <span class="life-pill-preview">{{ session.lifeUnread[0].text }}</span>
        </button>
      </Transition>
      <StatusBar />
      <Composer />
    </div>

    <SideDrawer :open="drawerOpen" @close="closeDrawer" />

    <ApprovalSheet
      v-if="session.pendingApproval"
      :card="session.pendingApproval"
      @decide="(d: ApprovalDecision) => onDecide(session.pendingApproval!.callId, d)"
    />
    <QuestionSheet
      v-else-if="session.pendingQuestion"
      :card="session.pendingQuestion"
      @answer="(answers: Record<string, string>) => onAnswer(session.pendingQuestion!.callId, answers)"
    />
  </div>
</template>

<style scoped>
.chat {
  height: 100%;
  min-height: 0;
  background-color: transparent;
  background-image:
    linear-gradient(var(--chat-background-overlay), var(--chat-background-overlay)),
    var(--chat-background-image);
  background-position: center;
  background-size: cover;
}

.shell {
  position: relative;
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: transparent;
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
}

.stream {
  flex: 1; min-width: 0; min-height: 0; max-width: 100%; overflow-x: hidden; overflow-y: auto;
  -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain;
}
.inner {
  display: flex; flex-direction: column; gap: 12px;
  width: 100%; min-width: 0; min-height: 100%; padding: 10px 12px 18px; overflow-x: hidden;
}
.empty-inner { min-height: 100%; }
.virtual-stream {
  width: 100%; height: 100%; min-width: 0; min-height: 0; box-sizing: border-box;
  padding: 10px 12px 18px; overflow-y: auto; overflow-x: hidden;
  -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain;
}
.virtual-item { width: 100%; min-width: 0; padding-bottom: 12px; }

.to-bottom {
  position: absolute; left: 50%; bottom: 116px; z-index: 8;
  display: grid; place-items: center;
  width: 38px; height: 38px; margin-left: -19px;
  border: 1px solid var(--border); border-radius: 50%;
  background: var(--bg); color: var(--text-2);
  box-shadow: var(--shadow-2);
}
.to-bottom:active { background: var(--fill); }
.pop-enter-active, .pop-leave-active { transition: opacity .18s ease, transform .18s ease; }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: translateY(8px) scale(.9); }

.life-pill {
  display: flex; align-items: center; gap: 7px;
  margin: 0 12px 6px; padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  border-radius: 12px;
  background: linear-gradient(105deg, color-mix(in srgb, var(--accent-soft) 80%, var(--bg)), var(--bg));
  color: var(--accent);
  box-shadow: var(--shadow-1);
  text-align: left;
}
.life-pill-label { flex: none; font-size: 12.5px; font-weight: 650; }
.life-pill-preview {
  flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: var(--text-3); font-size: 12px;
}

.retry-confirm { margin: 0 12px 6px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); box-shadow: var(--shadow-1); }.retry-confirm > div:first-child { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--text-2); }
.retry-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 9px; }
.retry-actions button { min-height: 34px; padding: 0 13px; border-radius: 6px; font-size: 13px; font-weight: 600; }
.retry-secondary { background: var(--fill); color: var(--text-2); }
.retry-primary { background: var(--blue); color: #fff; }
</style>
