<script setup lang="ts">
/**
 * 对话时光机（F4）。
 *
 * 按月份回看历史会话：月历格子上标出当天会话数（有记录的高亮可点），
 * 并用 /api/cognitive/mood_curve 的数据在格子上打当日情绪小点；
 * 点某天在下方列出当天会话（标题/轮数/预览），点会话用与「会话历史」相同的
 * 方式打开聊天；每条会话可一键「改写成…」小说/剧本/漫画脚本（/api/story/generate），
 * 结果可复制，也可开新会话把成稿发给模型一起润色。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet, apiSend } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'
import { useSessionStore } from '@/stores/session'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

interface HistorySession {
  id: string
  title: string
  turns: number
  updatedAtMs: number
  preview: string
}

interface DayEntry {
  day: string
  count: number
  sessions: HistorySession[]
}

interface MonthEntry {
  month: string
  count: number
}

/** psi-v2 心情曲线事件（mood_curve 端点返回，与 LifeView 同构）。 */
interface MoodPoint {
  at_ms: number
  label: string
  valence: number
  arousal: number
  cause: string
}

type Genre = 'novel' | 'script' | 'comic'

const GENRE_LABEL: Record<Genre, string> = {
  novel: '小说',
  script: '剧本',
  comic: '漫画脚本',
}

const router = useRouter()
const session = useSessionStore()

// ---- 月份导航与月数据 ----
const year = ref(new Date().getFullYear())
const month = ref(new Date().getMonth()) // 0-11
const months = ref<MonthEntry[]>([])
const monthTotal = ref(0)
const monthDays = ref<Map<string, DayEntry>>(new Map())
const selectedDate = ref('')
const daySessions = ref<HistorySession[]>([])
const loadingMonths = ref(false)
const loadingDays = ref(false)
const loadingDay = ref(false)
const daysError = ref('')

// ---- 每日情绪点（按天聚合成效价均值）----
const moodByDay = ref<Map<string, number>>(new Map())

// ---- F6 改写（聊天 → 小说/剧本/漫画脚本）----
const genreTarget = ref<HistorySession | null>(null)
const generating = ref(false)
const storyError = ref('')
const storyResult = ref<{ story: string; genre: Genre; title: string } | null>(null)
const copied = ref(false)

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function monthKey(): string {
  return `${year.value}-${pad2(month.value + 1)}`
}

function dayKey(day: number): string {
  return `${year.value}-${pad2(month.value + 1)}-${pad2(day)}`
}

function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function formatDateLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const monthLabel = computed(() => `${year.value}年${month.value + 1}月`)
const todayKey = computed(() => dateKeyOf(new Date()))
const lastYearKey = computed(() => {
  const d = new Date()
  return `${d.getFullYear() - 1}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
})
const lastYearLabel = computed(() => {
  const d = new Date()
  return `${d.getMonth() + 1}月${d.getDate()}日`
})

/** 月历网格：1-31 与前后补位的空位。 */
const weeks = computed<Array<number | null>>(() => {
  const first = new Date(year.value, month.value, 1)
  const cells: Array<number | null> = []
  for (let i = 0; i < first.getDay(); i++) cells.push(null)
  const daysInMonth = new Date(year.value, month.value + 1, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
})

function dayEntry(day: number | null): DayEntry | undefined {
  if (day == null) return undefined
  return monthDays.value.get(dayKey(day))
}

/** 当天情绪档位：正/负/平稳 → 色点样式。 */
function moodInfo(day: number | null): { cls: string } | null {
  if (day == null) return null
  const v = moodByDay.value.get(dayKey(day))
  if (v == null) return null
  if (v > 0.15) return { cls: 'good' }
  if (v < -0.15) return { cls: 'low' }
  return { cls: 'flat' }
}

async function loadMonths() {
  loadingMonths.value = true
  try {
    const data = await apiGet<{ months: MonthEntry[] }>('/api/sessions/history')
    months.value = data?.months ?? []
  } catch {
    months.value = []
  } finally {
    loadingMonths.value = false
  }
}

async function loadMonthDays(): Promise<void> {
  loadingDays.value = true
  daysError.value = ''
  try {
    const data = await apiGet<{ days: DayEntry[]; total: number }>(`/api/sessions/history?month=${monthKey()}`)
    monthDays.value = new Map((data?.days ?? []).map(entry => [entry.day, entry]))
    monthTotal.value = data?.total ?? 0
  } catch {
    daysError.value = '这个月的会话记录加载失败，请稍后再试。'
    monthDays.value = new Map()
    monthTotal.value = 0
  } finally {
    loadingDays.value = false
  }
}

/** 每日情绪点：与 LifeView 同一端点，多取几天覆盖当前月份附近。 */
async function loadMood() {
  try {
    const data = await apiSend<MoodPoint[]>('/api/cognitive/mood_curve', 'POST', { profile_id: 'primary', days: 62 })
    const points = Array.isArray(data) ? data : []
    const sums = new Map<string, { total: number; count: number }>()
    for (const point of points) {
      const d = new Date(point.at_ms)
      if (Number.isNaN(d.getTime())) continue
      const key = dateKeyOf(d)
      const entry = sums.get(key) ?? { total: 0, count: 0 }
      entry.total += Number(point.valence) || 0
      entry.count += 1
      sums.set(key, entry)
    }
    const byDay = new Map<string, number>()
    for (const [key, value] of sums) byDay.set(key, value.total / value.count)
    moodByDay.value = byDay
  } catch {
    moodByDay.value = new Map()
  }
}

function shiftMonth(delta: number) {
  let y = year.value
  let m = month.value + delta
  while (m < 0) { m += 12; y -= 1 }
  while (m > 11) { m -= 12; y += 1 }
  year.value = y
  month.value = m
  selectedDate.value = ''
  daySessions.value = []
  void loadMonthDays()
}

/** 去年的今天：切到去年同月并高亮该日；那天有会话就直接列出来。 */
function goLastYearToday() {
  const d = new Date()
  year.value = d.getFullYear() - 1
  month.value = d.getMonth()
  selectedDate.value = ''
  daySessions.value = []
  void loadMonthDays().then(() => {
    selectedDate.value = lastYearKey.value
    const entry = monthDays.value.get(lastYearKey.value)
    daySessions.value = entry?.sessions ?? []
  })
}

async function selectDay(day: number) {
  const key = dayKey(day)
  selectedDate.value = key
  const entry = monthDays.value.get(key)
  if (entry) {
    daySessions.value = entry.sessions ?? []
    return
  }
  // 月份数据里没有（正常情况下点不到）：按日期单独拉一次兜底。
  loadingDay.value = true
  try {
    const data = await apiGet<{ days: DayEntry[]; total: number }>(`/api/sessions/history?date=${key}`)
    const found = (data?.days ?? []).find(item => item.day === key)
    daySessions.value = found?.sessions ?? []
  } catch {
    daySessions.value = []
  } finally {
    loadingDay.value = false
  }
}

/** 与「会话历史」相同的打开方式：切会话后回聊天页。 */
function openSession(id: string) {
  session.openSession(id)
  router.push('/')
}

async function generateStory(genre: Genre) {
  const target = genreTarget.value
  if (!target || generating.value) return
  generating.value = true
  storyError.value = ''
  try {
    const data = await apiSend<{ story: string }>('/api/story/generate', 'POST', {
      session_id: target.id,
      genre,
    })
    if (!data?.story) throw new Error('返回内容为空')
    storyResult.value = { story: data.story, genre, title: target.title }
    genreTarget.value = null
  } catch (reason) {
    storyError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    generating.value = false
  }
}

function closePicker() {
  if (generating.value) return
  genreTarget.value = null
}

async function copyStory() {
  const text = storyResult.value?.story ?? ''
  if (!text) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      legacyCopy(text)
    }
    copied.value = true
  } catch {
    legacyCopy(text)
    copied.value = true
  }
  setTimeout(() => { copied.value = false }, 1600)
}

/** 剪贴板降级：隐藏 textarea + execCommand。 */
function legacyCopy(text: string) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  } catch {
    /* 降级也失败就不打扰用户 */
  }
}

/** 开新会话把成稿发给模型，一起润色。 */
function polishInNewSession() {
  const result = storyResult.value
  if (!result) return
  const message = `这是把我们的对话改写成${GENRE_LABEL[result.genre]}：\n\n${result.story}\n\n请帮我看看，我们可以一起润色它。`
  session.newSession()
  session.sendMessage(message)
  router.push('/')
}

onMounted(() => {
  void loadMonths()
  void loadMood()
  void loadMonthDays()
})
</script>

<template>
  <div class="page">
    <PageHead title="对话时光机" @back="goBack(router, '/sessions')" />

    <main class="body">
      <!-- 月份导航 -->
      <div class="nav">
        <button class="nav-btn" aria-label="上个月" @click="shiftMonth(-1)">
          <CoomiIcon name="chevronLeft" :size="18" />
        </button>
        <div class="nav-title">
          <b>{{ monthLabel }}</b>
          <span v-if="!loadingDays">{{ monthTotal > 0 ? `${monthTotal} 条会话` : '本月暂无会话' }}</span>
        </div>
        <button class="nav-btn" aria-label="下个月" @click="shiftMonth(1)">
          <CoomiIcon name="chevronRight" :size="18" />
        </button>
      </div>

      <!-- 月历：会话数 + 当日情绪点 -->
      <section class="calendar">
        <div class="week-head">
          <span v-for="w in ['日', '一', '二', '三', '四', '五', '六']" :key="w">{{ w }}</span>
        </div>
        <div v-if="loadingDays" class="cal-loading">加载中…</div>
        <div v-else class="grid">
          <button
            v-for="(day, index) in weeks"
            :key="index"
            class="cell"
            :class="{
              has: day != null && dayEntry(day) != null,
              today: day != null && dayKey(day) === todayKey,
              lastyear: day != null && dayKey(day) === lastYearKey,
              sel: day != null && dayKey(day) === selectedDate,
            }"
            :disabled="day == null || dayEntry(day) == null"
            @click="day != null && selectDay(day)"
          >
            <template v-if="day != null">
              <span class="num">{{ day }}</span>
              <span v-if="dayEntry(day)" class="cnt">{{ dayEntry(day)?.count }}</span>
              <i v-if="moodInfo(day)" class="mood-dot" :class="moodInfo(day)?.cls" />
            </template>
          </button>
        </div>
        <p v-if="daysError" class="cal-error">{{ daysError }}</p>
        <p class="mood-legend">
          <span><i class="good" />明亮</span>
          <span><i class="flat" />平稳</span>
          <span><i class="low" />低落</span>
        </p>
      </section>

      <!-- 去年的今天 -->
      <div class="lastyear-row">
        <button class="lastyear-btn" @click="goLastYearToday">
          <CoomiIcon name="refresh" :size="15" />
          <span>去年的今天（{{ lastYearLabel }}）</span>
        </button>
      </div>

      <!-- 当天会话列表 -->
      <section class="daylist">
        <p v-if="!selectedDate" class="empty">
          <template v-if="monthTotal > 0">点击日历上有记录的日子，查看当天的会话。</template>
          <template v-else-if="!loadingMonths && months.length === 0">还没有任何对话记录。回到对话随便聊聊，时光机里就会出现它们。</template>
          <template v-else>这个月还没有对话记录。回到对话聊聊，时光机里就会出现它。</template>
        </p>
        <template v-else>
          <div class="daylist-head">
            <span>{{ formatDateLabel(selectedDate) }}</span>
            <b v-if="daySessions.length">{{ daySessions.length }} 个会话</b>
          </div>
          <p v-if="loadingDay" class="empty">加载中…</p>
          <p v-else-if="daySessions.length === 0" class="empty">这一天没有会话记录。</p>
          <div v-else class="group">
            <div v-for="item in daySessions" :key="item.id" class="row">
              <button class="rmain" @click="openSession(item.id)">
                <span class="rtitle">{{ item.title || '未命名会话' }}</span>
                <span class="rpreview">{{ item.preview || '（暂无预览）' }}</span>
                <span class="rmeta">{{ formatTime(item.updatedAtMs) }} · {{ item.turns }} 轮</span>
              </button>
              <button class="rewrite" aria-label="改写成" @click="genreTarget = item">
                <CoomiIcon name="pencil" :size="15" />
                <span>改写成…</span>
              </button>
            </div>
          </div>
        </template>
      </section>
    </main>

    <!-- 改写类型选择 -->
    <div v-if="genreTarget" class="scrim" @click.self="closePicker">
      <div class="sheet">
        <div class="grip" />
        <p class="stitle">把「{{ genreTarget.title || '这个会话' }}」改写成</p>
        <p v-if="storyError" class="serr">{{ storyError }}</p>
        <button class="sact" :disabled="generating" @click="generateStory('novel')">
          <span class="gname">小说</span>
          <span class="gdesc">叙事化改写，适合慢慢读</span>
        </button>
        <button class="sact" :disabled="generating" @click="generateStory('script')">
          <span class="gname">剧本</span>
          <span class="gdesc">分场次对话，带舞台提示</span>
        </button>
        <button class="sact" :disabled="generating" @click="generateStory('comic')">
          <span class="gname">漫画脚本</span>
          <span class="gdesc">分镜脚本，含画面与台词</span>
        </button>
        <p v-if="generating" class="sbusy">正在改写中…</p>
        <button class="sact plain" :disabled="generating" @click="genreTarget = null"><span>取消</span></button>
      </div>
    </div>

    <!-- 改写结果 -->
    <div v-if="storyResult" class="scrim" @click.self="storyResult = null">
      <div class="sheet result">
        <div class="grip" />
        <p class="stitle">改写完成 · {{ GENRE_LABEL[storyResult.genre] }}</p>
        <p class="ssub">「{{ storyResult.title }}」的改写结果如下，可复制带走，或开新会话一起润色。</p>
        <div class="story-box">{{ storyResult.story }}</div>
        <div class="sacts">
          <button class="btn" @click="copyStory">
            <CoomiIcon name="copy" :size="15" />
            {{ copied ? '已复制' : '复制' }}
          </button>
          <button class="btn btn-primary" @click="polishInNewSession">去新会话润色</button>
        </div>
        <button class="sact plain" @click="storyResult = null"><span>关闭</span></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 4px 12px calc(var(--safe-bottom) + 24px); }

/* ── 月份导航 ── */
.nav { display: flex; align-items: center; gap: 6px; margin: 10px 2px 10px; }
.nav-btn {
  display: grid; place-items: center; flex-shrink: 0;
  width: 36px; height: 36px; border-radius: 50%;
  background: var(--fill); color: var(--text-2);
}
.nav-btn:active { background: var(--fill-strong); }
.nav-btn:disabled { opacity: 0.42; }
.nav-title { flex: 1; min-width: 0; text-align: center; }
.nav-title b { display: block; font-size: 15.5px; font-weight: 650; color: var(--text); }
.nav-title span { display: block; margin-top: 1px; font-size: 11px; color: var(--text-3); }

/* ── 月历 ── */
.calendar { padding: 12px 10px 8px; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.week-head { display: grid; grid-template-columns: repeat(7, 1fr); margin-bottom: 6px; }
.week-head span { text-align: center; font-size: 11px; color: var(--text-3); }
.grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
.cell {
  position: relative; display: grid; place-items: center;
  aspect-ratio: 1; border-radius: 10px;
  font-size: 13px; color: var(--text-2);
}
.cell.has { background: var(--blue-soft); color: var(--blue); font-weight: 600; }
.cell.has:active { background: var(--blue-soft-2); }
.cell:disabled { color: var(--text-3); }
.cell.today { box-shadow: inset 0 0 0 1px var(--blue); }
.cell.lastyear { box-shadow: inset 0 0 0 1.5px var(--orange); }
.cell.sel { box-shadow: inset 0 0 0 2px var(--blue); background: var(--blue-soft); color: var(--blue); font-weight: 650; }
.cnt {
  position: absolute; top: 2px; right: 3px;
  min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box;
  border-radius: 7px; background: var(--blue); color: #fff;
  font-size: 9px; font-weight: 700; line-height: 14px; text-align: center;
}
.mood-dot {
  position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%);
  width: 5px; height: 5px; border-radius: 50%;
}
.mood-dot.good { background: var(--orange); }
.mood-dot.flat { background: var(--text-3); }
.mood-dot.low { background: var(--blue); }
.cal-loading { padding: 24px 0; text-align: center; font-size: 12.5px; color: var(--text-3); }
.cal-error { margin: 8px 2px 0; font-size: 12px; color: var(--danger); }
.mood-legend { display: flex; gap: 14px; margin: 8px 2px 2px; color: var(--text-3); font-size: 10.5px; }
.mood-legend span { display: inline-flex; align-items: center; gap: 5px; }
.mood-legend i { width: 6px; height: 6px; border-radius: 50%; }
.mood-legend i.good { background: var(--orange); }
.mood-legend i.flat { background: var(--text-3); }
.mood-legend i.low { background: var(--blue); }

/* ── 去年的今天 ── */
.lastyear-row { margin-top: 12px; }
.lastyear-btn {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  width: 100%; min-height: 40px; border-radius: var(--r-md);
  background: var(--orange-soft); color: var(--orange); font-size: 13px; font-weight: 550;
}
.lastyear-btn:active { background: var(--orange-border); }

/* ── 当天会话列表 ── */
.daylist { margin-top: 14px; }
.empty { padding: 14px 10px; text-align: center; font-size: 12.5px; line-height: 1.7; color: var(--text-3); }
.daylist-head {
  display: flex; align-items: baseline; justify-content: space-between;
  margin: 0 4px 8px; color: var(--text-2); font-size: 13.5px; font-weight: 650;
}
.daylist-head b { color: var(--text-3); font-size: 11.5px; font-weight: 600; }
.group { border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.row { display: flex; align-items: stretch; }
.row + .row { border-top: 1px solid var(--border); }
.rmain { flex: 1; min-width: 0; padding: 12px 4px 12px 14px; text-align: left; }
.rmain:active { background: var(--fill); }
.rtitle {
  display: block; min-width: 0; font-size: 14px; font-weight: 550; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rpreview {
  display: block; margin-top: 3px; font-size: 12px; line-height: 1.5; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rmeta { display: block; margin-top: 3px; font-size: 11.5px; color: var(--text-3); }
.rewrite {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  flex-shrink: 0; width: 60px; color: var(--blue); font-size: 10.5px; font-weight: 550;
}
.rewrite:active { background: var(--fill); }

/* ── 底部弹层（改写选择 / 结果） ── */
.scrim {
  position: fixed; inset: 0; z-index: 70;
  display: flex; align-items: flex-end;
  background: rgba(17, 22, 31, .36); animation: fade .18s ease-out;
}
@keyframes fade { from { opacity: 0; } }
.sheet {
  width: 100%; padding: 6px 14px calc(var(--safe-bottom) + 14px);
  border-radius: 22px 22px 0 0; background: var(--bg);
  box-shadow: var(--shadow-sheet); animation: rise .26s cubic-bezier(.2, .8, .2, 1);
}
@keyframes rise { from { transform: translateY(100%); } }
.sheet.result { display: flex; flex-direction: column; max-height: 80vh; }
.grip { width: 38px; height: 4px; margin: 4px auto 12px; border-radius: 2px; background: var(--border-strong); }
.stitle {
  padding: 0 6px 8px; font-size: 14px; font-weight: 600; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ssub { padding: 0 6px 10px; font-size: 12.5px; line-height: 1.6; color: var(--text-2); }
.serr { margin: 0 6px 8px; padding: 8px 10px; border-radius: var(--r-sm); background: var(--danger-soft); color: var(--danger); font-size: 12px; line-height: 1.5; }
.sact {
  display: flex; align-items: center; gap: 11px;
  width: 100%; min-height: 52px; padding: 0 12px;
  border-radius: var(--r-md); text-align: left; font-size: 15px; color: var(--text);
}
.sact:active { background: var(--fill); }
.sact:disabled { opacity: 0.5; pointer-events: none; }
.sact.plain { justify-content: center; margin-top: 4px; color: var(--text-2); font-weight: 550; }
.gname { flex-shrink: 0; font-size: 15px; font-weight: 600; color: var(--text); }
.gdesc { min-width: 0; font-size: 12px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sbusy { margin: 8px 6px 2px; font-size: 12.5px; color: var(--text-3); text-align: center; }
.story-box {
  flex: 1; min-height: 0; overflow-y: auto; margin: 2px 0 12px;
  padding: 12px; border-radius: var(--r-md);
  background: var(--page); color: var(--text-2);
  font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere;
}
.sacts { display: flex; gap: 8px; margin-top: 2px; }
.sacts .btn { flex: 1; }
</style>
