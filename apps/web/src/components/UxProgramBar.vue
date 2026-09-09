<script setup lang="ts">
/**
 * 「用户体验改进计划」邀请浮条（会话界面顶部）。
 * 状态机：hidden → invite（每天首次邀请）→ note（点「不要再出现」后的短暂提示）→ hidden。
 * 位置：上边缘与模型切换卡片展开的上边缘对齐（fixed top = safe-top + 49px），
 * z-index 低于模型卡（12 < 20）——展开模型卡时自然遮挡浮条。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useUxProgramStore } from '@/stores/uxProgram'
import { useConnectionStore } from '@/stores/connection'

const SHOWN_DATE_KEY = 'coomi.uxProgram.lastShownDate'

const router = useRouter()
const ux = useUxProgramStore()
const connection = useConnectionStore()

/** hidden：不显示；invite：邀请浮条；note：「不要再出现」后的短暂提醒。 */
const stage = ref<'hidden' | 'invite' | 'note'>('hidden')
const moreOpen = ref(false)

const today = () => new Date().toISOString().slice(0, 10)

const showInvite = computed(() =>
  stage.value === 'invite'
  && !ux.neverAsk
  && ux.consent !== 'joined'
  && connection.isOpen)

onMounted(async () => {
  await ux.refresh()
  if (ux.neverAsk) return
  let shownBefore = ''
  try { shownBefore = localStorage.getItem(SHOWN_DATE_KEY) ?? '' } catch { /* ignore */ }
  if (shownBefore === today()) return
  try { localStorage.setItem(SHOWN_DATE_KEY, today()) } catch { /* ignore */ }
  // 稍作延迟，避免与页面首帧动画抢戏。
  setTimeout(() => { if (!ux.neverAsk) stage.value = 'invite' }, 800)
})

function openProgram() {
  void router.push('/ux-program')
}

function dismissToday() {
  moreOpen.value = false
  stage.value = 'hidden'
}

function neverAgain() {
  moreOpen.value = false
  // 引擎侧持久化：与计划页「会话页邀请提示」开关同步，重启后依然生效。
  void ux.setNeverAsk(true)
  stage.value = 'note'
  setTimeout(() => { stage.value = 'hidden' }, 2200)
}
</script>

<template>
  <Transition name="ux-bar">
    <div v-if="showInvite" class="ux-bar">
      <i class="spark">✦</i>
      <span class="ux-text" @click="openProgram">
        TensorHub邀请您加入《用户体验改进计划》
      </span>
      <div class="more-wrap">
        <button class="ux-more" aria-label="更多" @click.stop="moreOpen = !moreOpen">▾</button>
        <Transition name="pop">
          <div v-if="moreOpen" class="more-pop">
            <button class="never-btn" @click.stop="neverAgain">不要再出现</button>
          </div>
        </Transition>
      </div>
      <button class="ux-close" aria-label="关闭" @click.stop="dismissToday">✕</button>
    </div>
  </Transition>
  <Transition name="ux-bar">
    <div v-if="stage === 'note'" class="ux-bar">
      <i class="spark">✦</i>
      <span class="ux-text plain">可从控制台「用户体验改进计划」找到入口</span>
      <button class="ux-close" aria-label="关闭" @click.stop="stage = 'hidden'">✕</button>
    </div>
  </Transition>
</template>

<style scoped>
.ux-bar {
  position: fixed;
  /* 与模型切换展开卡上边缘一致（TopBar 高 49px + 安全区） */
  top: calc(var(--safe-top) + 49px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 12; /* 低于模型卡（20）与其遮罩（19）：展开模型卡时遮挡浮条 */
  display: flex;
  align-items: center;
  gap: 2px;
  height: 40px;
  max-width: min(94vw, 460px);
  padding: 0 6px 0 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-card);
  box-shadow: 0 4px 16px rgba(17, 22, 31, .1);
}
.ux-text {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  line-height: 40px; /* 与浮条同高，保证单行文本垂直居中 */
  color: var(--text-3);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ux-text.plain { cursor: default; }
.spark {
  flex-shrink: 0;
  font-style: normal;
  font-size: 12px;
  line-height: 40px; /* 与文本同行高，图标上下居中 */
  color: var(--blue);
  text-align: center;
}
.ux-close, .ux-more {
  flex-shrink: 0;
  width: 26px; height: 26px;
  border: 0; border-radius: 8px;
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  cursor: pointer;
  display: grid; place-items: center;
}
.ux-close:active, .ux-more:active { background: var(--fill); }
.ux-more { font-size: 10px; }
.more-wrap { position: relative; flex-shrink: 0; display: flex; align-items: center; }
.more-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: -4px;
  z-index: 13;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 6px 20px rgba(17, 22, 31, .14);
  padding: 4px;
  white-space: nowrap;
}
.never-btn {
  border: 0; background: transparent;
  color: var(--text-2);
  font-size: 12px; font-weight: 600;
  padding: 7px 14px; border-radius: 7px;
  cursor: pointer;
  width: 100%;
  text-align: left;
}
.never-btn:active { background: var(--fill); }

.ux-bar-enter-active, .ux-bar-leave-active { transition: opacity .25s, transform .25s; }
.ux-bar-enter-from, .ux-bar-leave-to { opacity: 0; transform: translateX(-50%) translateY(-8px); }
.pop-enter-active, .pop-leave-active { transition: opacity .15s, transform .15s; }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
