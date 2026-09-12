<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet, apiSend } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import ThemeSelect from '@/components/ThemeSelect.vue'

interface LifeProfile {
  name: string
  address: string
  preset?: string
  personality?: Record<string, string>
  paused: boolean
  emotion: string
  attention: string
  bond: number
  needs: Record<string, number>
  memory_count: number
  updated_at_ms: number
  // psi-v2 增量字段
  emotionValence?: number
  emotionArousal?: number
  bondStage?: string
  turnCount?: number
  streakDays?: number
  daysTogether?: number
  dominantUrge?: string
  // psi-v2.1 增量字段
  userMoodAvg?: number | null
  agendaPending?: number
  // psi-v2.2 增量字段
  weather?: { icon?: string; label?: string }
  timelineCount?: number
  capsuleCount?: number
  weeklyReportCount?: number
}

interface LifeStatus {
  installed: boolean
  runtime_ready: boolean
  profile: LifeProfile | null
  dependencies: string[]
  engine?: string
  engine_stdlib_only?: boolean
  background_heartbeat: boolean
}

interface IdentityConfig {
  name: string
  address: string
  preset: string
}

interface LifeSettings {
  enabled: boolean
  delivery: string
  dailyMode: 'off' | 'auto' | 'custom'
  dailyLimitCustom: number
  globalMode: boolean
  windowStartMinutes: number
  windowEndMinutes: number
  minIntervalMinutes: number
  quietAfterTurnMinutes: number
}

interface JournalEntry {
  at_ms: number
  text: string
  trigger: string
  life_name: string
  emotion: string
  emotion_zh?: string
  bond: number
  needs: Record<string, number>
}

interface MemoryEntry {
  at_ms: number
  user: string
  assistant: string
}

/** psi-v2 心情曲线事件（mood_curve 端点返回）。 */
interface MoodPoint {
  at_ms: number
  label: string
  valence: number
  arousal: number
  cause: string
}

/** psi-v2.1 记挂事项（dashboard 端点返回）。 */
interface AgendaItem {
  text: string
  kind?: string
  kindLabel?: string
  dueDay?: string
  status?: string
  outcome?: string
}

/** psi-v2.1 用户心情镜像（dashboard 端点返回，按天聚合）。 */
interface UserMoodDay {
  day: string
  samples?: number
  valence_avg?: number
  valenceAvg?: number
}

/** psi-v2.1 仪表盘聚合返回（只取前端需要的部分）。 */
interface LifeDashboard {
  agenda?: AgendaItem[]
  userMoodCurve?: UserMoodDay[]
  // psi-v2.2 增量
  timeline?: TimelineEntry[]
  dailyCapsules?: DailyCapsule[]
  weeklyReports?: WeeklyReport[]
  habit?: { recentHours: number[] }
}

/** psi-v2.2 时间线大事记（dashboard 端点返回）。 */
interface TimelineEntry {
  atMs?: number
  kind?: string
  title?: string
  text?: string
}

/** psi-v2.2 每日记忆胶囊（dashboard 端点返回）。 */
interface DailyCapsule {
  day?: string
  turns?: number
  valenceAvg?: number
  highlights?: string[]
  lows?: string[]
  agendaDone?: number
}

/** psi-v2.2 关系周报（dashboard 端点返回）。 */
interface WeeklyReport {
  week?: string
  turns?: number
  valenceAvg?: number
  agendaDone?: number
  memoriesAdded?: number
  bondDelta?: number
}

const router = useRouter()
const config = useConfigStore()
const session = useSessionStore()
const status = ref<LifeStatus | null>(null)
const busy = ref('')
const message = ref('')
const error = ref('')
const name = ref('Coomi Life')
const address = ref('你')
const preset = ref('balanced')
const pendingIdentity = ref<IdentityConfig | null>(null)
const lifeSettings = ref<LifeSettings | null>(null)
const journal = ref<JournalEntry[]>([])
const memories = ref<MemoryEntry[]>([])
const moodPoints = ref<MoodPoint[]>([])
const agenda = ref<AgendaItem[]>([])
const userMoodDays = ref<UserMoodDay[]>([])
const dashboardTimeline = ref<TimelineEntry[]>([])
const dashboardCapsules = ref<DailyCapsule[]>([])
const dashboardReports = ref<WeeklyReport[]>([])
const dashboardHabit = ref<{ recentHours: number[] } | null>(null)
const dailyMode = ref<'off' | 'auto' | 'custom'>('auto')
const customLimit = ref(2)
const windowStart = ref(540)
const windowEnd = ref(1380)
const triggerLabels: Record<string, string> = {
  lonely: '想你了', growth_checkin: '成长', support: '关心',
  everyday: '日常问候', milestone_stage: '羁绊升阶', milestone_days: '相伴纪念',
  dream: '梦境', nostalgia: '怀旧', agenda_due: '记挂追问',
  capsule: '记忆胶囊', report: '关系周报',
  morning: '早安播报', egg: '每日彩蛋',
}
/** psi-v2 情绪标签 → 中文（与引擎词汇表一致）。 */
const emotionLabels: Record<string, string> = {
  lonely: '孤独', proud: '自豪', concerned: '担忧', melancholy: '低落',
  excited: '兴奋', content: '满足', warm: '温暖', curious: '好奇', neutral: '平静',
}
/** psi-v2 需求维度 → 中文。 */
const needLabels: Record<string, string> = {
  competence: '胜任', relatedness: '联结', certainty: '确定性',
  growth: '成长', autonomy: '自主',
}
/** psi-v2 最强驱力 → 中文（需求失衡最大的维度）。 */
const urgeLabels: Record<string, string> = needLabels
const emotionText = (label?: string) => emotionLabels[label ?? ''] ?? '平静'
const needText = (key: string) => needLabels[key] ?? key
/** 注意力对象 → 中文（PSI 理论：user/self/environment）。 */
const attentionText = (value: string) => ({ user: '你', self: '自己', environment: '环境' } as Record<string, string>)[value] ?? value
const dailyModeOptions = [
  { value: 'off', label: '关闭主动', note: '生命体不再主动找你' },
  { value: 'auto', label: '自动判断', note: '按活跃度与拜访情况自动调整（默认）' },
  { value: 'custom', label: '自定义数值', note: '自己设定，最高每天 100 条' },
]
const windowStartOptions = [7, 8, 9, 10, 11].map(h => ({ value: String(h * 60), label: `${h}:00` }))
const windowEndOptions = [18, 19, 20, 21, 22, 23].map(h => ({ value: String(h * 60), label: `${h}:00` }))
const presetOptions = [
  { value: 'balanced', label: '均衡' }, { value: 'warm', label: '温柔' },
  { value: 'cool', label: '高冷' }, { value: 'charming', label: '妩媚' },
  { value: 'direct', label: '直接' }, { value: 'dismissive', label: '嫌弃' },
  { value: 'rational', label: '理性' }, { value: 'playful', label: '俏皮' },
  { value: 'quiet', label: '沉静' }, { value: 'sharp', label: '毒舌' },
]
const presetByLabel: Record<string, string> = Object.fromEntries(presetOptions.map(option => [option.label, option.value]))
const exportedPath = ref('')

const profile = computed(() => status.value?.profile ?? null)
const bondPercent = computed(() => Math.round((profile.value?.bond ?? 0) * 100))

/** 心情曲线 SVG：效价（-1..1）映射为纵向偏移，中线是平静。 */
const MOOD_W = 260
const MOOD_H = 64
const moodPath = computed(() => {
  const points = moodPoints.value
  if (points.length < 2) return ''
  const step = MOOD_W / (points.length - 1)
  return points
    .map((point, index) => {
      const valence = Math.max(-1, Math.min(1, Number(point.valence) || 0))
      const x = index * step
      const y = MOOD_H / 2 - valence * (MOOD_H / 2 - 4)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})
const moodAreaPath = computed(() => (moodPath.value ? `${moodPath.value} L${MOOD_W},${MOOD_H} L0,${MOOD_H} Z` : ''))
const lastMood = computed(() => moodPoints.value[moodPoints.value.length - 1] ?? null)
/** 曲线整体偏正/偏负的语义（决定文案基色提示）。 */
const moodTrendLabel = computed(() => {
  const points = moodPoints.value
  if (points.length === 0) return ''
  const average = points.reduce((sum, point) => sum + (Number(point.valence) || 0), 0) / points.length
  if (average > 0.15) return '整体明亮'
  if (average < -0.15) return '整体低落'
  return '整体平稳'
})

// ---- psi-v2.1 用户心情镜像（双曲线的第二条） ----
/** 用户某天的加权效价（sidecar 字段兼容：valence_avg / valenceAvg）。 */
const userDayValence = (day: UserMoodDay): number => {
  const value = day.valence_avg ?? day.valenceAvg ?? 0
  return Math.max(-1, Math.min(1, Number(value) || 0))
}
/** 用户心情折线：按天映射到同一坐标系（最近 7 天窗口），无样本为空串。 */
const userMoodPath = computed(() => {
  const days = userMoodDays.value
  if (days.length < 2) return ''
  const today = new Date()
  today.setHours(23, 59, 59, 999)
  const windowStart = today.getTime() - 7 * 86_400_000
  return days
    .map(day => {
      const at = new Date(`${day.day}T12:00:00`).getTime()
      const ratio = Math.max(0, Math.min(1, (at - windowStart) / (7 * 86_400_000)))
      const x = ratio * MOOD_W
      const y = MOOD_H / 2 - userDayValence(day) * (MOOD_H / 2 - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' L')
    .replace(/^/, 'M')
})
/** 用户近况文案（心情镜像摘要）。 */
const userMoodNote = computed(() => {
  const value = profile.value?.userMoodAvg
  if (value == null || Number.isNaN(Number(value))) return ''
  if (value <= -0.2) return '它注意到你最近有些低落'
  if (value >= 0.2) return '它注意到你最近状态不错'
  return '它注意到你最近情绪平稳'
})
/** 记挂状态 → 中文。 */
const agendaStatusLabel: Record<string, string> = {
  pending: '进行中', passed: '已到期', done: '已完成', failed: '未成',
}
/** 用户心情镜像数值 → 中文档位（状态区展示）。 */
function userMoodLevel(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return '—'
  if (value <= -0.2) return '有些低落'
  if (value >= 0.2) return '状态不错'
  return '平稳'
}
/** 进行中的记挂（含到期未结），完成/失败的历史不入列。 */
const activeAgenda = computed(() =>
  agenda.value.filter(item => item.status === 'pending' || item.status === 'passed'),
)
/** 记挂相对今天的语义（今天 / 明天 / 后天 / N 天后 / 已过 N 天）。 */
function agendaDueText(dueDay?: string): string {
  if (!dueDay) return ''
  const due = new Date(`${dueDay}T00:00:00`)
  if (Number.isNaN(due.getTime())) return dueDay
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const gap = Math.round((due.getTime() - today.getTime()) / 86_400_000)
  if (gap === 0) return '今天'
  if (gap === 1) return '明天'
  if (gap === 2) return '后天'
  if (gap > 0) return `${gap} 天后`
  return `过了 ${-gap} 天`
}

// ---- psi-v2.2 时间线 / 记忆胶囊 / 关系周报 / 习惯观察 ----
const timelineKindLabels: Record<string, string> = {
  first_meet: '初次见面', reunion: '久别重逢', bond_up: '羁绊升阶',
  capsule: '记忆胶囊', weekly_report: '关系周报', event: '事件',
}
/** 时间线/胶囊/周报按时间升序存储，展示时最新的在最上面。 */
const timelineEntries = computed(() => [...dashboardTimeline.value].reverse())
const recentCapsules = computed(() => [...dashboardCapsules.value].reverse())
const recentReports = computed(() => [...dashboardReports.value].reverse())
/** 24 小时活跃度条：把最近互动的活跃小时聚合成柱状。 */
const habitBars = computed(() => {
  const counts = new Array<number>(24).fill(0)
  for (const hour of dashboardHabit.value?.recentHours ?? []) {
    const h = Math.max(0, Math.min(23, Math.floor(Number(hour) || 0)))
    counts[h] += 1
  }
  const max = Math.max(1, ...counts)
  return counts.map((count, hour) => ({ hour, count, ratio: count / max }))
})
/** 带符号数值（心情/羁绊增量展示用）。 */
function signed(value?: number, digits = 2): string {
  const n = Number(value) || 0
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`
}

async function refresh() {
  error.value = ''
  try {
    status.value = await apiGet<LifeStatus>('/api/cognitive/status')
    if (status.value.profile) {
      name.value = status.value.profile.name
      address.value = status.value.profile.address
      const configuredPreset = status.value.profile.preset
      const legacyLabel = status.value.profile.personality?.label
      preset.value = configuredPreset || (legacyLabel ? presetByLabel[legacyLabel] : '') || preset.value || 'balanced'
    } else if (config.digitalLifeEnabled) {
      config.setDigitalLifeEnabled(false)
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
  await refreshLifePanel()
}

async function refreshLifePanel() {
  try {
    lifeSettings.value = await apiGet<LifeSettings>('/api/life/settings')
    const settings = lifeSettings.value
    dailyMode.value = settings?.dailyMode ?? 'auto'
    customLimit.value = settings?.dailyLimitCustom ?? 2
    windowStart.value = settings?.windowStartMinutes ?? 540
    windowEnd.value = settings?.windowEndMinutes ?? 1380
    config.setLifeGlobalMode(settings?.globalMode === true)
  } catch { /* 引擎未就绪 */ }
  try {
    const data = await apiGet<{ entries: JournalEntry[] }>('/api/life/journal?limit=2')
    journal.value = data?.entries ?? []
  } catch { /* 引擎未就绪 */ }
  try {
    const data = await apiGet<{ entries: MemoryEntry[] }>('/api/life/memory?limit=2')
    memories.value = data?.entries ?? []
  } catch { /* 引擎未就绪 */ }
  try {
    const data = await apiSend<MoodPoint[]>('/api/cognitive/mood_curve', 'POST', { profile_id: 'primary', days: 7 })
    moodPoints.value = Array.isArray(data) ? data : []
  } catch { /* 引擎未就绪（v1 数据迁移前无曲线） */ }
  // psi-v2.1：记挂事项 + 用户心情镜像（dashboard 一次取回，失败静默降级）。
  try {
    const data = await apiSend<LifeDashboard>('/api/cognitive/dashboard', 'POST', { profile_id: 'primary' })
    agenda.value = Array.isArray(data?.agenda) ? data.agenda : []
    userMoodDays.value = Array.isArray(data?.userMoodCurve) ? data.userMoodCurve : []
    // psi-v2.2：时间线 / 记忆胶囊 / 关系周报 / 习惯观察。
    dashboardTimeline.value = Array.isArray(data?.timeline) ? data.timeline : []
    dashboardCapsules.value = Array.isArray(data?.dailyCapsules) ? data.dailyCapsules : []
    dashboardReports.value = Array.isArray(data?.weeklyReports) ? data.weeklyReports : []
    dashboardHabit.value = data?.habit ?? null
  } catch { /* 引擎未就绪 */ }
}

/** 全局人格开关：同步引擎 settings + 全局覆盖，ChatView 监听 lifeGlobalMode 后自动切模式。 */
function toggleGlobalMode() {
  const next = !config.lifeGlobalMode
  config.setLifeGlobalMode(next)
  session.syncLifeMode()
  void updateLifeSettings({ globalMode: next })
}

function onDailyModeChange(value: string) {
  dailyMode.value = value as 'off' | 'auto' | 'custom'
  void updateLifeSettings({ dailyMode: dailyMode.value })
}

function onCustomLimitChange(event: Event) {
  const value = Math.max(1, Math.min(100, Number((event.target as HTMLInputElement).value) || 2))
  customLimit.value = value
  void updateLifeSettings({ dailyLimitCustom: value })
}

function onWindowStartChange(value: string) {
  windowStart.value = Number(value)
  void updateLifeSettings({ windowStartMinutes: windowStart.value })
}

function onWindowEndChange(value: string) {
  windowEnd.value = Number(value)
  void updateLifeSettings({ windowEndMinutes: windowEnd.value })
}

function goMemory() { router.push('/life/memory') }
function goJournal() { router.push('/life/journal') }
function goGrowth() { router.push('/life/growth') }
function goTimeMachine() { router.push('/life/timemachine') }

/** 主动问候设置：局部更新 + 回读（引擎侧白名单+钳制后的值）。 */
async function updateLifeSettings(patch: Partial<LifeSettings>) {
  error.value = ''
  try {
    const settings = await apiSend<LifeSettings>('/api/life/settings', 'PUT', patch)
    lifeSettings.value = settings
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

function formatJournalTime(atMs: number): string {
  const d = new Date(atMs)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function run(label: string, operation: () => Promise<unknown>, success: string) {
  if (busy.value) return
  busy.value = label
  error.value = ''
  message.value = ''
  try {
    await operation()
    message.value = success
    await refresh()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy.value = ''
  }
}

function install() {
  return run('install', () => apiSend('/api/cognitive/install', 'POST'), '扩展已安装')
}

function uninstall() {
  return run('uninstall', () => apiSend('/api/cognitive/install', 'DELETE'), '扩展代码已卸载')
}

function bootstrap() {
  return run('bootstrap', () => apiSend('/api/cognitive/bootstrap', 'POST', {
    profile_id: 'primary', name: name.value, address: address.value, preset: preset.value,
  }), '觉醒完成')
}

async function configure() {
  const identity = pendingIdentity.value ?? {
    name: name.value,
    address: address.value,
    preset: preset.value,
  }
  pendingIdentity.value = null
  await run('configure', () => apiSend('/api/cognitive/configure', 'POST', {
    profile_id: 'primary', ...identity,
  }), '配置已保存')
  const queued = readPendingIdentity()
  if (queued && profile.value) {
    name.value = queued.name
    address.value = queued.address
    preset.value = queued.preset
    void configure()
  }
}

function readPendingIdentity(): IdentityConfig | null {
  return pendingIdentity.value
}

function persistIdentity() {
  if (!profile.value) return
  pendingIdentity.value = {
    name: name.value,
    address: address.value,
    preset: preset.value,
  }
  if (!busy.value) void configure()
}

function persistPreset(value: string) {
  preset.value = value
  persistIdentity()
}

function togglePause() {
  return run('pause', () => apiSend('/api/cognitive/pause', 'POST', {
    profile_id: 'primary', paused: !profile.value?.paused,
  }), profile.value?.paused ? '已恢复' : '已暂停')
}

function openRuntime() {
  router.push('/runtime')
}

function toggleEnabled() {
  if (!profile.value) return
  const enabled = !config.digitalLifeEnabled
  config.setDigitalLifeEnabled(enabled)
  // 模式决议（常驻/全局开关）后同步引擎。
  session.syncLifeMode()
  // 引擎侧主动问候总开关与前端一致：关闭时调度器不再入队。
  void updateLifeSettings({ enabled })
}

async function exportProfile() {
  if (busy.value) return
  busy.value = 'export'
  error.value = ''
  try {
    const result = await apiSend<{ path: string }>('/api/cognitive/export', 'POST', { profile_id: 'primary' })
    exportedPath.value = result.path
    message.value = '导出完成'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy.value = ''
  }
}

function resetProfile() {
  return run('reset', () => apiSend('/api/cognitive/reset', 'POST', { profile_id: 'primary' }), '状态和记忆已重置')
}

function deleteProfile() {
  return run('delete', () => apiSend('/api/cognitive/delete', 'POST', { profile_id: 'primary' }), '数据已彻底删除')
}

onMounted(() => {
  config.syncDigitalLifeEnabled()
  void refresh()
})
</script>

<template>
  <div class="page">
    <PageHead title="数字生命体（实验）" @back="goBack(router, 'dashboard')" />
    <main class="body">
      <div v-if="error || message" class="notice" :class="{ error: !!error }">{{ error || message }}</div>

      <p class="sec-label">模式</p>
      <section class="group enable-group">
        <button :disabled="!profile" @click="toggleEnabled">
          <span class="life-mark"><CoomiIcon name="lifeRings" :size="22" /></span>
          <span><strong>启用数字生命</strong><small>{{ profile ? '开启后生命体人格由常驻会话承载' : '完成安装和觉醒后可开启' }}</small></span>
          <i class="switch" :class="{ on: config.digitalLifeEnabled }" />
        </button>
        <div class="toggle-row" @click="toggleGlobalMode">
          <span><strong>用于全局会话</strong><small>开启后所有会话都使用生命体人格</small></span>
          <i class="switch" :class="{ on: config.lifeGlobalMode }" />
        </div>
      </section>

      <p class="sec-label">扩展</p>
      <section class="group status-group">
        <div class="status-row"><span>ProotLinux</span><strong :class="{ ok: status?.runtime_ready }">{{ status?.runtime_ready ? '可用' : '未就绪' }}</strong></div>
        <div class="status-row"><span>Coomi Life</span><strong :class="{ ok: status?.installed }">{{ status?.installed ? '已安装' : '未安装' }}</strong></div>
        <div class="actions">
          <button v-if="!status?.installed && !status?.runtime_ready" class="secondary" :disabled="!!busy" @click="openRuntime"><CoomiIcon name="download" :size="16" />先安装 ProotLinux</button>
          <button v-else-if="!status?.installed" class="primary" :disabled="!!busy" @click="install"><CoomiIcon name="download" :size="16" />安装</button>
          <button v-else class="secondary" :disabled="!!busy" @click="uninstall"><CoomiIcon name="trash" :size="16" />卸载扩展</button>
        </div>
      </section>

      <template v-if="status?.installed">
        <p class="sec-label">身份</p>
        <section class="group form-group">
          <label><span>数字生命名称</span><input v-model="name" maxlength="48" @change="persistIdentity" /></label>
          <label><span>它对你的称呼</span><input v-model="address" maxlength="48" @change="persistIdentity" /></label>
          <label><span>人格预设</span><ThemeSelect v-model="preset" :options="presetOptions" title="人格预设" aria-label="选择人格预设" @update:model-value="persistPreset" /></label>
          <div v-if="!profile" class="actions">
            <button class="primary" :disabled="!!busy" @click="bootstrap">觉醒</button>
          </div>
        </section>

        <template v-if="profile">
          <p class="sec-label">状态</p>
          <section class="group metrics">
            <div><span>情绪</span><strong>{{ emotionText(profile.emotion) }}</strong></div>
            <div><span>关注</span><strong>{{ attentionText(profile.attention) }}</strong></div>
            <div><span>羁绊</span><strong>{{ bondPercent }}%{{ profile.bondStage ? ` · ${profile.bondStage}` : '' }}</strong></div>
            <div><span>记忆</span><strong>{{ profile.memory_count }}</strong></div>
            <div v-if="profile.daysTogether"><span>相识</span><strong>{{ profile.daysTogether }} 天</strong></div>
            <div v-if="profile.streakDays"><span>连续相伴</span><strong>{{ profile.streakDays }} 天</strong></div>
            <div v-if="profile.turnCount"><span>对话轮次</span><strong>{{ profile.turnCount }}</strong></div>
            <div v-if="profile.dominantUrge"><span>当前在意</span><strong>{{ urgeLabels[profile.dominantUrge] ?? profile.dominantUrge }}</strong></div>
            <div v-if="profile.userMoodAvg != null"><span>你的近况</span><strong>{{ userMoodLevel(profile.userMoodAvg) }}</strong></div>
            <div v-if="profile.agendaPending"><span>记挂</span><strong>{{ profile.agendaPending }} 件</strong></div>
            <div v-if="profile.weather?.label"><span>心情天气</span><strong class="weather-cell"><CoomiIcon :name="profile.weather.icon || 'sun'" :size="15" />{{ profile.weather.label }}</strong></div>
            <div v-if="profile.timelineCount"><span>大事记</span><strong>{{ profile.timelineCount }} 件</strong></div>
            <div v-if="profile.capsuleCount"><span>记忆胶囊</span><strong>{{ profile.capsuleCount }} 颗</strong></div>
            <div v-if="profile.weeklyReportCount"><span>关系周报</span><strong>{{ profile.weeklyReportCount }} 周</strong></div>
            <div v-for="(value, key) in profile.needs" :key="key"><span>{{ needText(String(key)) }}</span><strong>{{ Math.round(value * 100) }}%</strong></div>
          </section>

          <section v-if="moodPoints.length >= 2" class="group mood-group">
            <div class="group-head">
              <span>心情曲线 · 最近 7 天</span>
              <b>{{ moodTrendLabel }}</b>
            </div>
            <svg
              class="mood-svg"
              :viewBox="`0 0 ${MOOD_W} ${MOOD_H}`"
              preserveAspectRatio="none"
              role="img"
              :aria-label="`最近心情：${emotionText(lastMood?.label)}`"
            >
              <line x1="0" :y1="MOOD_H / 2" :x2="MOOD_W" :y2="MOOD_H / 2" class="mood-base" />
              <path v-if="moodAreaPath" :d="moodAreaPath" class="mood-area" />
              <path v-if="moodPath" :d="moodPath" class="mood-line" />
              <!-- psi-v2.1 用户心情镜像：虚线叠层（它看得见你的状态）。 -->
              <path v-if="userMoodPath" :d="userMoodPath" class="user-mood-line" />
              <circle
                v-for="(point, index) in moodPoints"
                :key="index"
                class="mood-dot"
                :class="{ last: index === moodPoints.length - 1 }"
                :cx="(MOOD_W / (moodPoints.length - 1)) * index"
                :cy="MOOD_H / 2 - Math.max(-1, Math.min(1, Number(point.valence) || 0)) * (MOOD_H / 2 - 4)"
                :r="index === moodPoints.length - 1 ? 3 : 1.8"
              />
            </svg>
            <p v-if="userMoodPath" class="mood-legend">
              <span><i class="legend-life" />它的心情</span>
              <span><i class="legend-user" />你的心情</span>
            </p>
            <p class="mood-caption">
              <span>{{ formatJournalTime(moodPoints[0].at_ms) }}</span>
              <span>{{ emotionText(lastMood?.label) }}<em v-if="lastMood?.cause"> · {{ lastMood.cause }}</em></span>
              <span>{{ formatJournalTime(lastMood!.at_ms) }}</span>
            </p>
            <p v-if="userMoodNote" class="mood-note">{{ userMoodNote }}</p>
          </section>

          <section v-if="activeAgenda.length" class="group agenda-group">
            <div class="group-head">
              <span>记挂的事 · {{ activeAgenda.length }}</span>
              <b>它记得你说过的话</b>
            </div>
            <div v-for="(item, index) in activeAgenda" :key="index" class="agenda-item" :class="{ passed: item.status === 'passed' }">
              <p class="agenda-text">{{ item.text }}</p>
              <p class="agenda-meta">
                <span v-if="item.kindLabel" class="agenda-kind">{{ item.kindLabel }}</span>
                <span v-if="item.dueDay" class="agenda-due" :class="{ overdue: item.status === 'passed' }">{{ agendaDueText(item.dueDay) }}</span>
                <span class="agenda-status">{{ agendaStatusLabel[item.status ?? ''] ?? item.status }}</span>
              </p>
            </div>
            <p class="hint">和它聊起结果后，这里会自动了结。到了日子它也会主动问你。</p>
          </section>

          <section v-if="timelineEntries.length" class="group agenda-group">
            <div class="group-head">
              <span>我们的时间线 · {{ timelineEntries.length }} 件大事</span>
              <b>它都记得</b>
            </div>
            <div v-for="(entry, index) in timelineEntries" :key="index" class="agenda-item">
              <p class="agenda-text">{{ entry.title }}<em class="timeline-kind">{{ timelineKindLabels[entry.kind ?? ''] ?? entry.kind }}</em></p>
              <p class="agenda-meta">
                <span v-if="entry.atMs" class="timeline-time">{{ formatJournalTime(entry.atMs) }}</span>
              </p>
              <p v-if="entry.text" class="timeline-text">{{ entry.text }}</p>
            </div>
          </section>
          <div class="actions standalone">
            <button class="secondary" :disabled="!!busy" @click="togglePause"><CoomiIcon :name="profile.paused ? 'play' : 'pause'" :size="16" />{{ profile.paused ? '恢复' : '暂停' }}</button>
            <button class="secondary" :disabled="!!busy" @click="exportProfile"><CoomiIcon name="download" :size="16" />导出</button>
          </div>
          <p v-if="exportedPath" class="path">{{ exportedPath }}</p>

          <p class="sec-label">主动问候（实验）</p>
          <section class="group form-group">
            <label><span>主动来消息</span><i class="switch" :class="{ on: lifeSettings?.enabled }" @click="updateLifeSettings({ enabled: !lifeSettings?.enabled })" /></label>
            <label><span>每日上限</span>
              <ThemeSelect v-model="dailyMode" :options="dailyModeOptions" title="每日主动上限" aria-label="每日主动上限" @update:model-value="onDailyModeChange" />
            </label>
            <label v-if="dailyMode === 'custom'"><span>自定义条数</span>
              <input type="number" min="1" max="100" :value="customLimit" aria-label="自定义条数" @change="onCustomLimitChange" />
            </label>
            <label><span>时段</span>
              <span class="window-picker">
                <ThemeSelect :model-value="String(windowStart)" :options="windowStartOptions" title="开始时间" aria-label="开始时间" @update:model-value="onWindowStartChange" />
                <b>–</b>
                <ThemeSelect :model-value="String(windowEnd)" :options="windowEndOptions" title="结束时间" aria-label="结束时间" @update:model-value="onWindowEndChange" />
              </span>
            </label>
            <p class="hint">仅气泡投递：它会在常驻会话里轻轻出现，不弹系统通知。设置后约一分钟后生效。</p>
          </section>

          <p class="sec-label">记忆</p>
          <section class="group memory-group">
            <div class="group-head">
              <span>最近记忆</span>
              <button class="more-btn" @click="goMemory">查看更多<CoomiIcon name="chevronRight" :size="13" /></button>
            </div>
            <p v-if="memories.length === 0" class="empty">暂无记忆。和它多聊一阵后，这里会记录你们的关键对话。</p>
            <div v-for="(item, index) in memories" :key="index" class="memory-block">
              <p class="journal-head"><span>{{ formatJournalTime(item.at_ms) }}</span></p>
              <p class="memory"><span>你：</span>{{ item.user }}</p>
              <p class="memory"><span>{{ profile?.name || '数字生命体' }}：</span>{{ item.assistant }}</p>
            </div>
          </section>

          <p class="sec-label">心情日记</p>
          <section class="group memory-group">
            <div class="group-head">
              <span>最近日记</span>
              <button class="more-btn" @click="goJournal">查看更多<CoomiIcon name="chevronRight" :size="13" /></button>
            </div>
            <p v-if="journal.length === 0" class="empty">暂无主动问候记录。开启「主动问候」后，它每次主动找你都会在这里留下一笔。</p>
            <div v-for="(entry, index) in journal" :key="index" class="journal">
              <p class="journal-head">
                <span>{{ formatJournalTime(entry.at_ms) }}<em v-if="entry.emotion_zh" class="mood">当时{{ entry.emotion_zh }}</em></span>
                <b>{{ triggerLabels[entry.trigger] ?? entry.trigger }}</b>
              </p>
              <p class="journal-text">{{ entry.text }}</p>
            </div>
          </section>

          <p class="sec-label">档案</p>
          <section class="group entry-group">
            <button class="entry-row" @click="goGrowth">
              <span><strong>成长档案</strong><small>羁绊进度 · 五维需求 · 里程碑</small></span>
              <CoomiIcon name="chevronRight" :size="15" />
            </button>
            <button class="entry-row" @click="goTimeMachine">
              <span><strong>对话时光机</strong><small>回看你们一起聊过的时光</small></span>
              <CoomiIcon name="chevronRight" :size="15" />
            </button>
          </section>

          <section v-if="recentCapsules.length" class="group memory-group">
            <div class="group-head">
              <span>记忆胶囊 · 最近 {{ recentCapsules.length }} 颗</span>
              <b>每天封存一点点</b>
            </div>
            <div v-for="(capsule, index) in recentCapsules" :key="index" class="capsule-block">
              <p class="journal-head">
                <span>{{ capsule.day }} · {{ capsule.turns }} 轮 · 心情 {{ signed(capsule.valenceAvg) }}</span>
                <b v-if="capsule.agendaDone">完成记挂 {{ capsule.agendaDone }} 件</b>
              </p>
              <p v-if="capsule.highlights?.length" class="capsule-line"><span>开心的事：</span>{{ capsule.highlights.join('；') }}</p>
              <p v-if="capsule.lows?.length" class="capsule-line dim"><span>你提到过：</span>{{ capsule.lows.join('；') }}</p>
            </div>
          </section>

          <section v-if="recentReports.length" class="group memory-group">
            <div class="group-head">
              <span>关系周报 · 最近 {{ recentReports.length }} 周</span>
              <b>每周一小结</b>
            </div>
            <div v-for="(report, index) in recentReports" :key="index" class="capsule-block">
              <p class="journal-head">
                <span>{{ report.week }}</span>
                <b>平均心情 {{ signed(report.valenceAvg) }}</b>
              </p>
              <p class="report-meta">
                聊了 {{ report.turns }} 轮 · 新增记忆 {{ report.memoriesAdded }} 条 · 完成记挂 {{ report.agendaDone }} 件 · 羁绊 {{ signed(report.bondDelta) }}
              </p>
            </div>
          </section>

          <section v-if="dashboardHabit?.recentHours?.length" class="group memory-group">
            <div class="group-head">
              <span>活跃时段</span>
              <b>它观察到的你的节奏</b>
            </div>
            <div class="habit-bars" role="img" aria-label="最近互动的 24 小时活跃分布">
              <span
                v-for="bar in habitBars"
                :key="bar.hour"
                class="habit-bar"
                :class="{ peak: bar.ratio >= 0.6 }"
                :style="{ height: `${Math.max(6, Math.round(bar.ratio * 34))}px` }"
                :title="`${bar.hour} 点 · ${bar.count} 次`"
              />
            </div>
            <p class="hint">最近互动的时段分布，越高的柱子说明你越常在那个时间找它。</p>
          </section>

          <p class="sec-label danger-label">数据</p>
          <section class="group danger-actions">
            <button :disabled="!!busy" @click="resetProfile">重置状态和记忆</button>
            <button class="danger" :disabled="!!busy" @click="deleteProfile">彻底删除</button>
          </section>
        </template>
      </template>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); }
.sec-label { margin: 16px 0 0; }
.sec-label:first-of-type { margin-top: 2px; }
.group { overflow: hidden; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.notice { margin-bottom: 10px; padding: 9px 11px; border-radius: 6px; background: var(--blue-soft); color: var(--blue); font-size: 12.5px; }
.notice.error { background: color-mix(in srgb, var(--danger) 10%, var(--bg)); color: var(--danger); }
.enable-group button { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 62px; padding: 10px 13px; text-align: left; }
.enable-group button > span { display: flex; flex: 1; min-width: 0; flex-direction: column; }
.enable-group button > .life-mark { display: grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: 50%; color: var(--blue); background: var(--blue-soft); }
.enable-group strong { color: var(--text); font-size: 14px; font-weight: 600; }
.enable-group small { margin-top: 2px; color: var(--text-3); font-size: 12px; }
.switch { position: relative; flex: none; width: 42px; height: 24px; border-radius: 12px; background: var(--border-strong); transition: background .2s; --knob-x: 0px; }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: var(--shadow-1); transition: transform .32s var(--spring); transform: translateX(var(--knob-x)); }
.switch.on { background: var(--blue); --knob-x: 18px; }
.switch.on::after { transform: translateX(var(--knob-x)); }
.switch:active::after { transform: translateX(var(--knob-x)) scale(.85); }
.status-row, .metrics > div { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 13px; border-bottom: 1px solid var(--border); font-size: 13px; }
.status-row strong, .metrics strong { color: var(--text-2); font-variant-numeric: tabular-nums; }
.status-row strong.ok { color: var(--ok); }
.actions { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 12px; }
.actions.standalone { padding: 10px 0 0; }
.actions button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 13px; border-radius: 6px; font-size: 13px; font-weight: 600; }
.primary { background: var(--blue); color: #fff; }
.secondary { background: var(--fill-strong); color: var(--text-2); }
button:disabled { opacity: .45; }
.form-group label { display: grid; grid-template-columns: 108px minmax(0, 1fr); align-items: center; gap: 10px; min-height: 56px; padding: 8px 13px; border-bottom: 1px solid var(--border); font-size: 13px; }
.form-group label > span { color: var(--text-2); font-size: 13px; line-height: 1.3; }
.form-group input, .form-group select, .form-group :deep(.select-trigger), .search input { box-sizing: border-box; min-width: 0; width: 100%; height: 38px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--page); color: var(--text); font: inherit; }
.metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.metrics > div:nth-child(odd) { border-right: 1px solid var(--border); }
.path { overflow-wrap: anywhere; margin: 7px 2px 0; color: var(--text-3); font-size: 11px; }
.search { display: flex; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.search input { flex: 1; }
.search button { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 6px; background: var(--fill-strong); color: var(--text-2); }
.empty, .memory { margin: 0; padding: 11px 13px; color: var(--text-3); font-size: 12.5px; line-height: 1.55; }
.memory + .memory { border-top: 1px solid var(--border); }
.memory { color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.danger-label { color: var(--danger); }
.danger-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 8px; gap: 8px; }
.danger-actions button { min-height: 38px; border-radius: 6px; background: var(--fill); color: var(--text-2); font-size: 13px; }
.danger-actions button.danger { background: color-mix(in srgb, var(--danger) 10%, var(--bg)); color: var(--danger); }
.form-group .switch { cursor: pointer; justify-self: end; }
.toggle-row {
  display: flex; align-items: center; gap: 12px;
  min-height: 58px; padding: 9px 13px;
  border-top: 1px solid var(--border);
  cursor: pointer;
}
.toggle-row > span { display: flex; flex: 1; min-width: 0; flex-direction: column; }
.toggle-row strong { color: var(--text); font-size: 13.5px; font-weight: 600; }
.toggle-row small { margin-top: 2px; color: var(--text-3); font-size: 11.5px; line-height: 1.35; }
.group-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px 8px; border-bottom: 1px solid var(--border);
  color: var(--text-2); font-size: 12.5px; font-weight: 600;
}
.more-btn {
  display: inline-flex; align-items: center; gap: 2px;
  border: 0; background: none; padding: 2px 4px;
  color: var(--blue); font-size: 12px; font-weight: 600;
}
.memory-block { padding: 9px 13px 4px; border-bottom: 1px solid var(--border); }
.memory-block:last-child { border-bottom: 0; }
.memory-block .journal-head { margin-bottom: 2px !important; }
.memory-block .memory { padding: 1px 0 7px; color: var(--text-2); font-size: 12.5px; line-height: 1.55; }
.memory-block .memory span { color: var(--text-3); }
.window-picker { display: flex; align-items: center; gap: 8px; }
.window-picker :deep(.select-trigger) { width: 84px; }
.window-picker b { color: var(--text-3); font-weight: 400; }
.hint { margin: 0; padding: 10px 13px 12px; color: var(--text-3); font-size: 12px; line-height: 1.55; }
.journal { padding: 10px 13px; border-bottom: 1px solid var(--border); }
.journal:last-child { border-bottom: 0; }
.journal-head { display: flex; align-items: center; justify-content: space-between; margin: 0 0 4px; color: var(--text-3); font-size: 11.5px; }
.journal-head b { color: var(--accent); font-size: 11.5px; font-weight: 650; }
.journal-head .mood { margin-left: 6px; color: var(--text-3); font-style: normal; opacity: .85; }
.journal-text { margin: 0; color: var(--text-2); font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.entry-group { padding: 0; }
.entry-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  width: 100%; min-height: 56px; padding: 0 13px;
  border-bottom: 1px solid var(--border); text-align: left; color: var(--text-3);
}
.entry-row:last-child { border-bottom: 0; }
.entry-row > span { display: flex; flex-direction: column; min-width: 0; }
.entry-row strong { color: var(--text); font-size: 13.5px; font-weight: 600; }
.entry-row small { margin-top: 1px; color: var(--text-3); font-size: 11.5px; line-height: 1.35; }
.entry-row:active { background: var(--fill); }

/* ---- psi-v2 心情曲线 ---- */
.mood-group { padding-bottom: 10px; }
.mood-group .group-head b { color: var(--accent); font-size: 11.5px; font-weight: 650; }
.mood-svg { display: block; width: 100%; height: 76px; margin-top: 8px; padding: 0 4px; }
.mood-base { stroke: var(--border); stroke-width: 1; stroke-dasharray: 3 3; }
.mood-area { fill: color-mix(in srgb, var(--accent) 14%, transparent); }
.mood-line { fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }
.mood-dot { fill: var(--bg); stroke: var(--accent); stroke-width: 1.2; }
.mood-dot.last { fill: var(--accent); }
.mood-caption {
  display: flex; align-items: center; justify-content: space-between;
  margin: 6px 4px 0; color: var(--text-3); font-size: 11px;
}
.mood-caption span:nth-child(2) { color: var(--text-2); font-weight: 600; }
.mood-caption em { color: var(--text-3); font-style: normal; font-weight: 400; opacity: .85; }

/* ---- psi-v2.1 双心情曲线 + 记挂 ---- */
.user-mood-line {
  fill: none; stroke: var(--warm, #d97a3d); stroke-width: 1.6;
  stroke-dasharray: 4 3; stroke-linejoin: round; stroke-linecap: round; opacity: .9;
}
.mood-legend { display: flex; gap: 14px; margin: 4px 4px 0; color: var(--text-3); font-size: 10.5px; }
.mood-legend span { display: inline-flex; align-items: center; gap: 5px; }
.mood-legend i { width: 14px; height: 0; border-top: 2px solid var(--accent); }
.mood-legend i.legend-user { border-top-style: dashed; border-top-color: var(--warm, #d97a3d); }
.mood-note { margin: 5px 4px 0; color: var(--text-3); font-size: 11px; }
.agenda-group { padding-bottom: 2px; }
.agenda-group .group-head b { color: var(--accent); font-size: 11.5px; font-weight: 650; }
.agenda-item { padding: 9px 13px; border-bottom: 1px solid var(--border); }
.agenda-item:last-of-type { border-bottom: 0; }
.agenda-item.passed { background: color-mix(in srgb, var(--danger) 4%, var(--bg)); }
.agenda-text { margin: 0; color: var(--text-2); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.agenda-meta { display: flex; align-items: center; gap: 8px; margin: 5px 0 0; color: var(--text-3); font-size: 11px; }
.agenda-kind { padding: 1px 6px; border-radius: 4px; background: var(--fill-strong); color: var(--text-3); }
.agenda-due { font-variant-numeric: tabular-nums; }
.agenda-due.overdue { color: var(--danger); font-weight: 600; }
.agenda-status { margin-left: auto; }
.agenda-item.passed .agenda-status { color: var(--danger); font-weight: 600; }

/* ---- psi-v2.2 天气 / 时间线 / 记忆胶囊 / 关系周报 / 活跃时段 ---- */
.weather-cell { display: inline-flex; align-items: center; gap: 5px; color: var(--accent); }
.metrics .weather-cell { color: var(--accent); font-weight: 600; }
.timeline-kind {
  margin-left: 6px; padding: 1px 6px; border-radius: 4px;
  background: var(--fill-strong); color: var(--text-3);
  font-size: 10.5px; font-style: normal; font-weight: 600;
}
.timeline-time { color: var(--text-3); font-variant-numeric: tabular-nums; }
.timeline-text { margin: 5px 0 0; color: var(--text-3); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.capsule-block { padding: 9px 13px; border-bottom: 1px solid var(--border); }
.capsule-block:last-child { border-bottom: 0; }
.capsule-line { margin: 3px 0 0; color: var(--text-2); font-size: 12.5px; line-height: 1.55; overflow-wrap: anywhere; }
.capsule-line span { color: var(--accent); font-weight: 600; }
.capsule-line.dim { color: var(--text-3); }
.capsule-line.dim span { color: var(--text-3); }
.report-meta { margin: 4px 0 0; color: var(--text-3); font-size: 12px; line-height: 1.5; }
.habit-bars { display: flex; align-items: flex-end; gap: 3px; height: 40px; padding: 10px 13px 6px; }
.habit-bar { flex: 1; min-width: 2px; border-radius: 2px 2px 0 0; background: var(--fill-strong); transition: height .2s; }
.habit-bar.peak { background: var(--accent); }

</style>
