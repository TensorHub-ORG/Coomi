<script setup lang="ts">
/**
 * 内置环境状态。
 *
 * 之前这页是假的（写死的步骤列表 + setInterval 推进度条）。现在全部来自
 * GET /api/runtime/health 与 GET /api/runtime/port —— 引擎没起来就老实说没起来。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet, apiSend } from '@/bridge/http'
import { useConnectionStore } from '@/stores/connection'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

interface Health {
  status: string
  version: string
  engine: { initialized: boolean; llm: string | null; tools: number }
  runtime?: string
}
interface RuntimeV2 {
  runtime: { backend: 'legacy_termux' | 'proot_linux'; status: 'not_installed' | 'downloading' | 'initializing' | 'ready' | 'needs_repair' | 'update_available' | 'rolling_back' | 'removing'; active_version?: string; previous_version?: string; error?: string }
  manifest_available: boolean
  manifest?: { runtime_version: string; architecture: string; proot_commit: string; rootfs_bytes: number }
  downloads?: Record<string, { downloaded: number; total: number; percent: number; status: 'pending' | 'downloading' | 'completed' }>
  legacy_available: boolean
}

const router = useRouter()
const connection = useConnectionStore()

const health = ref<Health | null>(null)
const port = ref<number | null>(null)
const failed = ref(false)
const runtimeV2 = ref<RuntimeV2 | null>(null)
const runtimeAction = ref('')
const runtimeError = ref('')
const refreshing = ref(false)
const autoInstallRequested = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

async function load(manual = false) {
  if (manual) refreshing.value = true
  try {
    health.value = await apiGet<Health>('/api/runtime/health')
    failed.value = false
  } catch {
    health.value = null
    failed.value = true
  }
  try {
    runtimeV2.value = await apiGet<RuntimeV2>('/api/runtime/v2')
    const status = runtimeV2.value.runtime.status
    if (!autoInstallRequested.value && runtimeV2.value.manifest_available
      && (status === 'not_installed' || status === 'needs_repair')) {
      autoInstallRequested.value = true
      void runRuntimeAction('install')
    }
  } catch { runtimeV2.value = null }
  try {
    port.value = (await apiGet<{ port: number }>('/api/runtime/port')).port
  } catch {
    /* 端口拿不到不算故障，健康检查已经说明问题了 */
  }
  if (manual) refreshing.value = false
}

async function runRuntimeAction(action: 'install' | 'update' | 'repair' | 'rollback' | 'remove') {
  runtimeAction.value = action
  runtimeError.value = ''
  try {
    await apiSend('/api/runtime/v2', 'POST', { action })
    await load()
  } catch (error) {
    runtimeError.value = error instanceof Error ? error.message : String(error)
  } finally {
    runtimeAction.value = ''
  }
}

onMounted(() => {
  void load()
  timer = setInterval(() => { void load() }, 5000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
const state = computed(() => {
  if (failed.value) return { label: '连不上引擎', cls: 'bad', icon: 'alert', desc: '桥接服务可能还在启动，或者已经退出了。' }
  if (!health.value) return { label: '检测中…', cls: 'idle', icon: 'clock', desc: '正在读取运行时状态。' }
  if (health.value.status === 'ok') return { label: '引擎就绪', cls: 'ok', icon: 'check', desc: '模型和工具都已装载，可以开始对话。' }
  return { label: '部分就绪', cls: 'warn', icon: 'alert', desc: '服务在跑，但模型还没配好 —— 去 Provider 里填一个 API Key。' }
})

const runtimeStatusLabel = computed(() => {
  switch (runtimeV2.value?.runtime.status) {
    case 'not_installed': return '未安装'
    case 'downloading': return '正在下载'
    case 'initializing': return '正在初始化'
    case 'ready': return '已就绪'
    case 'needs_repair': return '需要修复'
    case 'update_available': return '可更新'
    case 'rolling_back': return '正在回滚'
    case 'removing': return '正在删除'
    default: return '未知'
  }
})

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MB`
}

const runtimeDownload = computed(() => {
  const downloads = runtimeV2.value?.downloads
  if (!downloads) return null
  const entries = Object.entries(downloads)
  const active = entries.find(([, item]) => item.status === 'downloading')
  const [name, item] = active || entries.find(([, value]) => value.status !== 'completed') || entries[entries.length - 1] || []
  if (!item || !name) return null
  return { name, ...item }
})

const rows = computed(() => {
  const h = health.value
  return [
    { k: '引擎初始化', v: h ? (h.engine.initialized ? '已完成' : '未完成') : '—', mono: false },
    { k: '当前模型', v: h?.engine.llm || '未配置', mono: true },
    { k: '已注册工具', v: h ? String(h.engine.tools) : '—', mono: false },
    { k: '运行时', v: h?.runtime || '-', mono: true },
    { k: '桥接版本', v: h?.version || '—', mono: true },
    { k: '服务端口', v: port.value != null ? String(port.value) : '—', mono: true },
    { k: '事件通道', v: connection.label, mono: false },
  ]
})
// 从控制台进入：返回统一回控制台（浏览器环境回聊天主页）
function goDashboard() {
  if (window.CoomiAndroid?.openDashboard) window.CoomiAndroid.openDashboard()
  else router.push('/')
}
</script><template>
  <div class="page">
    <PageHead title="ProotLinux 环境" @back="goDashboard">
      <template #right>
        <button class="icon-btn" aria-label="刷新" @click="load(true)">
          <CoomiIcon name="refresh" :class="{ spin: refreshing }" />
        </button>
      </template>
    </PageHead>

    <main class="body">
      <div class="hero" :class="state.cls">
        <span class="hic"><CoomiIcon :name="state.icon" :size="20" /></span>
        <span class="htxt">
          <span class="hlabel">{{ state.label }}</span>
          <span class="hdesc">{{ state.desc }}</span>
        </span>
      </div>

      <p class="sec-label">运行时</p>
      <div class="group">
        <div v-for="r in rows" :key="r.k" class="kv">
          <span class="k">{{ r.k }}</span>
          <span class="v" :class="{ mono: r.mono }">{{ r.v }}</span>
        </div>
      </div>

      <template v-if="runtimeV2">
        <p class="sec-label">ProotLinux</p>
        <div class="group runtime-v2">
          <div class="kv"><span class="k">后端</span><span class="v mono">{{ runtimeV2.runtime.backend }}</span></div>
          <div class="kv"><span class="k">状态</span><span class="v">{{ runtimeStatusLabel }}</span></div>
          <div class="kv"><span class="k">当前版本</span><span class="v mono">{{ runtimeV2.runtime.active_version || '未安装' }}</span></div>
          <div v-if="runtimeV2.manifest" class="kv"><span class="k">可用版本</span><span class="v mono">{{ runtimeV2.manifest.runtime_version }}</span></div>
          <div class="runtime-actions">
            <button v-if="runtimeV2.manifest_available && runtimeV2.runtime.status === 'update_available'" :disabled="!!runtimeAction" @click="runRuntimeAction('update')">更新</button>
            <button v-if="runtimeV2.runtime.status === 'needs_repair'" :disabled="!!runtimeAction" @click="runRuntimeAction('install')">重新部署</button>
            <button v-if="runtimeV2.runtime.previous_version" :disabled="!!runtimeAction" @click="runRuntimeAction('rollback')">回滚</button>
          </div>
          <p v-if="!runtimeV2.manifest_available" class="runtime-error">APK 中缺少 Runtime V2 安装清单，请更新或重新安装应用。</p>
          <div v-else-if="runtimeV2.runtime.status === 'downloading' || runtimeV2.runtime.status === 'initializing'" class="runtime-progress">
            <template v-if="runtimeDownload">
              <div class="progress-head"><span>{{ runtimeDownload.status === 'completed' ? '内置包已就绪' : '准备中' }} {{ runtimeDownload.percent }}%</span><span>{{ formatBytes(runtimeDownload.downloaded) }} / {{ formatBytes(runtimeDownload.total) }}</span></div>
              <div class="progress-track"><div class="progress-fill" :style="{ width: `${runtimeDownload.percent}%` }" /></div>
              <div class="progress-file">{{ runtimeDownload.name }}</div>
            </template>
            <span v-else>{{ runtimeV2.runtime.status === 'initializing' ? '正在校验并解包内置环境，请稍候。' : '正在读取 APK 内置运行时。' }}</span>
          </div>
          <p v-if="runtimeError || runtimeV2.runtime.error" class="runtime-error">{{ runtimeError || runtimeV2.runtime.error }}</p>
        </div>
      </template>

      <button v-if="health && health.status !== 'ok'" class="btn btn-soft wide" @click="router.push('/providers')">
        去配置提供商
      </button>

      <p class="note">
        ProotLinux 是 Coomi 的必备内置环境，由 Runtime V2 在 App 私有存储中自动校验和初始化，
        无需手动安装或联网下载。首次解包会花一点时间，后续更新、修复和回滚均保留持久状态。
      </p>
    </main>
  </div>
</template>
<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); }
.spin { animation: coomi-spin 1s linear infinite; }

.hero {
  display: flex; align-items: center; gap: 12px;
  padding: 15px 15px 16px; border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-1);
}
.hic {
  display: grid; place-items: center; flex-shrink: 0;
  width: 40px; height: 40px; border-radius: 12px;
  background: var(--fill-strong); color: var(--text-2);
}
.hero.ok .hic { background: var(--ok-soft); color: var(--ok); }
.hero.warn .hic { background: var(--orange-soft); color: var(--orange); }
.hero.bad .hic { background: var(--danger-soft); color: var(--danger); }
.htxt { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.hlabel { font-size: 16px; font-weight: 650; color: var(--text); }
.hdesc { font-size: 12.8px; line-height: 1.55; color: var(--text-2); }

.sec-label { margin: 16px 0 0; }
.group { border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.kv { display: flex; align-items: baseline; gap: 12px; padding: 12px 14px; font-size: 13.8px; }
.kv + .kv { border-top: 1px solid var(--border); }
.kv .k { flex-shrink: 0; min-width: 82px; color: var(--text-2); }
.kv .v { flex: 1; min-width: 0; text-align: right; color: var(--text); word-break: break-all; }
.kv .v.mono { font-family: var(--font-mono); font-size: 12.6px; }

.wide { width: 100%; margin-top: 14px; }
.note { margin-top: 16px; padding: 0 4px; font-size: 12px; line-height: 1.75; color: var(--text-3); }
.note code { font-family: var(--font-mono); font-size: 11.2px; }
.runtime-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
.runtime-actions button { min-height: 36px; padding: 0 13px; border-radius: 6px; background: var(--blue); color: #fff; font-size: 13px; }
.runtime-actions button.danger { background: var(--danger-soft); color: var(--danger); }
.runtime-actions button:disabled { opacity: .5; }
.runtime-error { margin: 0; padding: 0 12px 12px; color: var(--danger); font-size: 12px; overflow-wrap: anywhere; }
.runtime-progress { margin: 0; padding: 0 12px 12px; color: var(--blue); font-size: 12px; }
.progress-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-variant-numeric: tabular-nums; }
.progress-track { height: 7px; overflow: hidden; border-radius: 4px; background: var(--fill-strong); }
.progress-fill { height: 100%; border-radius: inherit; background: var(--blue); transition: width .3s ease; }
.progress-file { margin-top: 6px; color: var(--text-3); font-family: var(--font-mono); font-size: 10.5px; overflow-wrap: anywhere; }
</style>
