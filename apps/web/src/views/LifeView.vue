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
}

interface LifeStatus {
  installed: boolean
  runtime_ready: boolean
  profile: LifeProfile | null
  dependencies: string[]
  upstream_commit: string
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
  bond: number
  needs: Record<string, number>
}

interface MemoryEntry {
  at_ms: number
  user: string
  assistant: string
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
const dailyMode = ref<'off' | 'auto' | 'custom'>('auto')
const customLimit = ref(2)
const windowStart = ref(540)
const windowEnd = ref(1380)
const triggerLabels: Record<string, string> = {
  lonely: '想你了', growth_checkin: '成长', support: '关心',
  everyday: '日常问候',
}
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
            <div><span>情绪</span><strong>{{ profile.emotion }}</strong></div>
            <div><span>关注</span><strong>{{ profile.attention }}</strong></div>
            <div><span>关系</span><strong>{{ bondPercent }}%</strong></div>
            <div><span>记忆</span><strong>{{ profile.memory_count }}</strong></div>
            <div v-for="(value, key) in profile.needs" :key="key"><span>{{ key }}</span><strong>{{ Math.round(value * 100) }}%</strong></div>
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
              <p class="journal-head"><span>{{ formatJournalTime(entry.at_ms) }}</span><b>{{ triggerLabels[entry.trigger] ?? entry.trigger }}</b></p>
              <p class="journal-text">{{ entry.text }}</p>
            </div>
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
.switch { position: relative; flex: none; width: 42px; height: 24px; border-radius: 12px; background: var(--border-strong); transition: background .2s; }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: var(--shadow-1); transition: transform .2s; }
.switch.on { background: var(--blue); }
.switch.on::after { transform: translateX(18px); }
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
.journal-text { margin: 0; color: var(--text-2); font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
