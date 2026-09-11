<script setup lang="ts">
/**
 * 数字生命体 · 成长档案（三级页）。
 * 由 LifeView「成长档案」进入：人格徽章、羁绊进度、五维需求雷达、里程碑时间线。
 * 数据来自 GET /api/life/growth（契约：camelCase 字段）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'
import PageHead from '@/components/PageHead.vue'

interface GrowthMilestone {
  atMs?: number
  kind?: string
  title?: string
  text?: string
}

interface GrowthData {
  name?: string
  address?: string
  preset?: string
  personalityLabel?: string
  bond?: number
  bondStage?: string
  bondStageZh?: string
  bondPercent?: number
  daysTogether?: number
  streakDays?: number
  turnCount?: number
  needs?: Record<string, number>
  needsZh?: Record<string, string>
  milestones?: GrowthMilestone[]
  firstSeenMs?: number
  updatedAtMs?: number
}

const router = useRouter()
const data = ref<GrowthData | null>(null)
const loading = ref(false)
const error = ref('')

/** 预设英文值 → 中文（与 LifeView 人格预设选项一致）。 */
const presetLabels: Record<string, string> = {
  balanced: '均衡', warm: '温柔', cool: '高冷', charming: '妩媚',
  direct: '直接', dismissive: '嫌弃', rational: '理性', playful: '俏皮',
  quiet: '沉静', sharp: '毒舌',
}
/** 里程碑类型 → 中文。 */
const milestoneKindLabels: Record<string, string> = {
  first_meet: '初次见面', reunion: '久别重逢', bond_up: '羁绊升阶',
  milestone_stage: '羁绊升阶', milestone_days: '相伴纪念',
  dream: '梦境', nostalgia: '怀旧', event: '事件',
}
/** 五维需求兜底中文（needsZh 缺失时使用，与 LifeView needLabels 一致）。 */
const needFallback: Record<string, string> = {
  competence: '胜任', relatedness: '联结', certainty: '确定性',
  growth: '成长', autonomy: '自主',
}
const NEED_KEYS = ['competence', 'relatedness', 'certainty', 'growth', 'autonomy'] as const

/** 契约未约定取值范围：>1 视为 0-100，否则视为 0-1，统一归一化到 0..1。 */
function norm(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const ratio = n > 1 ? n / 100 : n
  return Math.max(0, Math.min(1, ratio))
}

/** 整体空态：接口未返回或关键字段都缺失。 */
const isEmpty = computed(() =>
  !data.value
  || (!data.value.name && !data.value.preset && !data.value.personalityLabel
    && !Object.keys(data.value.needs ?? {}).length && !(data.value.milestones?.length)),
)
/** 人格徽章文案：优先 personalityLabel，其次 preset 中文映射。 */
const badgeLabel = computed(() =>
  data.value?.personalityLabel
  || (data.value?.preset ? presetLabels[data.value.preset] ?? data.value.preset : ''),
)
/** 羁绊百分比（防御 0-1 / 0-100 两种口径）。 */
const bondPercent = computed(() =>
  Math.round(norm(data.value?.bondPercent ?? (data.value?.bond ?? 0)) * 100),
)
const bondStageText = computed(() => data.value?.bondStageZh || data.value?.bondStage || '')
const stats = computed(() => [
  { label: '相伴天数', value: data.value?.daysTogether },
  { label: '连续相伴', value: data.value?.streakDays },
  { label: '对话轮次', value: data.value?.turnCount },
])
/** 里程碑按 atMs 升序（从初次见面到现在）。 */
const milestones = computed(() =>
  [...(data.value?.milestones ?? [])].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0)),
)
const firstSeenText = computed(() => formatDate(data.value?.firstSeenMs))
const updatedText = computed(() => formatDate(data.value?.updatedAtMs))

function formatDate(atMs?: number): string {
  if (!atMs) return ''
  const d = new Date(atMs)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

function formatTime(atMs: number): string {
  const d = new Date(atMs)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---- 五维需求雷达图：纯手写 SVG 五边形，无第三方依赖 ----
const RADAR_CX = 120
const RADAR_CY = 118
const RADAR_R = 74
const RADAR_LABEL_GAP = 30

/** 五个轴上的数据点 / 标签点（角度从顶部 -90° 起，每 72° 一个）。 */
const radarPoints = computed(() =>
  NEED_KEYS.map((key, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / NEED_KEYS.length
    const ratio = norm(data.value?.needs?.[key])
    return {
      key,
      label: data.value?.needsZh?.[key] || needFallback[key] || key,
      percent: Math.round(ratio * 100),
      x: RADAR_CX + RADAR_R * ratio * Math.cos(angle),
      y: RADAR_CY + RADAR_R * ratio * Math.sin(angle),
      lx: RADAR_CX + (RADAR_R + RADAR_LABEL_GAP) * Math.cos(angle),
      ly: RADAR_CY + (RADAR_R + RADAR_LABEL_GAP) * Math.sin(angle),
      anchor: Math.cos(angle) > 0.35 ? 'start' : Math.cos(angle) < -0.35 ? 'end' : 'middle',
    }
  }),
)
const radarPolygon = computed(() =>
  radarPoints.value.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
)
/** 网格：从内到外 25% / 50% / 75% / 100% 四层五边形。 */
const radarGrids = computed(() =>
  [0.25, 0.5, 0.75, 1].map(ratio => {
    const points: string[] = []
    for (let i = 0; i < NEED_KEYS.length; i++) {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / NEED_KEYS.length
      points.push(`${(RADAR_CX + RADAR_R * ratio * Math.cos(angle)).toFixed(1)},${(RADAR_CY + RADAR_R * ratio * Math.sin(angle)).toFixed(1)}`)
    }
    return points.join(' ')
  }),
)
/** 五条轴线（中心 → 顶点）。 */
const radarAxes = computed(() =>
  NEED_KEYS.map((_, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / NEED_KEYS.length
    return {
      x1: RADAR_CX,
      y1: RADAR_CY,
      x2: RADAR_CX + RADAR_R * Math.cos(angle),
      y2: RADAR_CY + RADAR_R * Math.sin(angle),
    }
  }),
)

async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    data.value = await apiGet<GrowthData>('/api/life/growth')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

onMounted(() => { void load() })
</script>

<template>
  <div class="page">
    <PageHead title="成长档案" @back="goBack(router, '/life')" />
    <main class="body">
      <div v-if="error" class="notice error">{{ error }}</div>
      <p v-if="loading" class="empty">档案加载中…</p>

      <div v-else-if="isEmpty" class="empty-wrap">
        <p class="empty-title">成长档案还在孕育中</p>
        <p class="empty-text">等它记下你们相处的点滴后，羁绊进度、需求画像和里程碑都会出现在这里。</p>
      </div>

      <template v-else-if="data">
        <!-- 人格徽章 -->
        <section class="card badge-card">
          <div class="badge-ring">
            <span class="badge-text">{{ badgeLabel || '未命名' }}</span>
          </div>
          <div class="badge-info">
            <h2 class="badge-name">{{ data.name || '数字生命体' }}</h2>
            <p v-if="data.address" class="badge-line">它叫你「{{ data.address }}」</p>
            <p v-if="firstSeenText" class="badge-meta">初次见面 · {{ firstSeenText }}</p>
            <p v-if="updatedText" class="badge-meta">档案更新于 {{ updatedText }}</p>
          </div>
        </section>

        <!-- 羁绊进度 -->
        <section class="card section-card">
          <div class="card-title">羁绊进度</div>
          <div class="bond-row">
            <strong class="bond-percent">{{ bondPercent }}%</strong>
            <span v-if="bondStageText" class="bond-stage">{{ bondStageText }}</span>
          </div>
          <div class="bar" role="img" :aria-label="`羁绊进度 ${bondPercent}%`">
            <i class="bar-fill" :style="{ width: `${bondPercent}%` }" />
          </div>
          <div class="stat-grid">
            <div v-for="stat in stats" :key="stat.label" class="stat-cell">
              <strong>{{ stat.value ?? '—' }}</strong>
              <span>{{ stat.label }}</span>
            </div>
          </div>
        </section>

        <!-- 五维需求雷达图 -->
        <section class="card section-card">
          <div class="card-title">五维需求</div>
          <svg
            class="radar"
            viewBox="0 0 240 240"
            role="img"
            aria-label="五维需求雷达图"
          >
            <polygon v-for="(grid, index) in radarGrids" :key="`g${index}`" :points="grid" class="radar-grid" />
            <line
              v-for="(axis, index) in radarAxes"
              :key="`a${index}`"
              :x1="axis.x1" :y1="axis.y1" :x2="axis.x2" :y2="axis.y2"
              class="radar-axis"
            />
            <polygon v-if="radarPolygon" :points="radarPolygon" class="radar-area" />
            <polygon v-if="radarPolygon" :points="radarPolygon" class="radar-line" />
            <circle
              v-for="(point, index) in radarPoints"
              :key="`d${index}`"
              :cx="point.x" :cy="point.y" r="2.6"
              class="radar-dot"
            />
            <text
              v-for="(point, index) in radarPoints"
              :key="`t${index}`"
              :x="point.lx" :y="point.ly" dy="0.35em"
              :text-anchor="point.anchor"
              class="radar-label"
            >{{ point.label }} {{ point.percent }}%</text>
          </svg>
          <p class="hint">五个维度反映它当下的内在状态，数值越高越充沛。</p>
        </section>

        <!-- 里程碑时间线 -->
        <section class="card section-card">
          <div class="card-title">里程碑 · {{ milestones.length }}</div>
          <div v-if="milestones.length === 0" class="inner-empty">还没有值得记下的里程碑，先陪它多走一段吧。</div>
          <div v-else class="timeline">
            <div v-for="(item, index) in milestones" :key="index" class="milestone">
              <i class="milestone-dot" :class="{ first: index === 0 }" />
              <div class="milestone-body">
                <p class="milestone-head">
                  <span v-if="item.atMs" class="milestone-time">{{ formatTime(item.atMs) }}</span>
                  <b v-if="item.kind" class="milestone-kind">{{ milestoneKindLabels[item.kind] ?? item.kind }}</b>
                </p>
                <p v-if="item.title" class="milestone-title">{{ item.title }}</p>
                <p v-if="item.text" class="milestone-text">{{ item.text }}</p>
              </div>
            </div>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); }
.notice { margin-bottom: 10px; padding: 9px 11px; border-radius: 6px; background: color-mix(in srgb, var(--danger) 10%, var(--bg)); color: var(--danger); font-size: 12.5px; }
.card { margin-bottom: 10px; padding: 14px; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.card-title { margin: 0 0 10px; color: var(--text-2); font-size: 12.5px; font-weight: 600; }
.hint { margin: 8px 0 0; color: var(--text-3); font-size: 11.5px; line-height: 1.5; }
.empty { margin: 14px 2px; color: var(--text-3); font-size: 12.5px; line-height: 1.6; }
.empty-wrap { margin-top: 34px; padding: 0 18px; text-align: center; }
.empty-title { margin: 0 0 6px; color: var(--text-2); font-size: 14px; font-weight: 600; }
.empty-text { margin: 0; color: var(--text-3); font-size: 12.5px; line-height: 1.65; }
.inner-empty { padding: 4px 2px 6px; color: var(--text-3); font-size: 12.5px; line-height: 1.6; }

/* ---- 人格徽章 ---- */
.badge-card { display: flex; align-items: center; gap: 14px; padding: 16px 14px; }
.badge-ring {
  display: grid; place-items: center; flex: none;
  width: 62px; height: 62px; border-radius: 50%;
  background: var(--blue-soft); color: var(--blue);
  box-shadow: inset 0 0 0 1.5px var(--blue-border);
}
.badge-text { padding: 0 4px; font-size: 13px; font-weight: 650; line-height: 1.25; text-align: center; }
.badge-info { flex: 1; min-width: 0; }
.badge-name { margin: 0 0 3px; color: var(--text); font-size: 16.5px; font-weight: 650; }
.badge-line { margin: 0; color: var(--text-2); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.badge-meta { margin: 2px 0 0; color: var(--text-3); font-size: 11.5px; }

/* ---- 羁绊进度 ---- */
.bond-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.bond-percent { color: var(--blue); font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
.bond-stage { color: var(--text-2); font-size: 12.5px; font-weight: 600; }
.bar { height: 8px; border-radius: 999px; background: var(--fill-strong); overflow: hidden; }
.bar-fill { display: block; height: 100%; border-radius: 999px; background: var(--blue); transition: width .4s ease; }
.stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--border); }
.stat-cell { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.stat-cell strong { color: var(--text); font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
.stat-cell span { color: var(--text-3); font-size: 11px; }

/* ---- 五维需求雷达图 ---- */
.radar { display: block; width: 100%; height: auto; margin-top: 2px; }
.radar-grid { fill: none; stroke: var(--border); stroke-width: 1; }
.radar-axis { stroke: var(--border); stroke-width: 1; }
.radar-area { fill: color-mix(in srgb, var(--blue) 15%, transparent); }
.radar-line { fill: none; stroke: var(--blue); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }
.radar-dot { fill: var(--blue); stroke: var(--bg); stroke-width: 1.2; }
.radar-label { fill: var(--text-2); font-size: 10.5px; font-weight: 600; }

/* ---- 里程碑时间线 ---- */
.timeline { position: relative; margin: 2px 0 0; padding-left: 18px; }
.timeline::before {
  content: ''; position: absolute; left: 4px; top: 5px; bottom: 5px;
  width: 2px; border-radius: 1px; background: var(--border);
}
.milestone { position: relative; padding: 0 0 16px; }
.milestone:last-child { padding-bottom: 0; }
.milestone-dot {
  position: absolute; left: -18px; top: 4px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--bg); box-shadow: inset 0 0 0 2px var(--blue);
}
.milestone-dot.first { background: var(--blue); box-shadow: none; }
.milestone-head { display: flex; align-items: center; gap: 7px; margin: 0 0 3px; }
.milestone-time { color: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.milestone-kind {
  padding: 1px 6px; border-radius: 4px;
  background: var(--fill-strong); color: var(--text-3);
  font-size: 10.5px; font-weight: 600;
}
.milestone-title { margin: 0; color: var(--text); font-size: 13.5px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.milestone-text { margin: 3px 0 0; color: var(--text-2); font-size: 12.5px; line-height: 1.55; overflow-wrap: anywhere; }
</style>
