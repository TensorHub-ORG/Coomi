<script setup lang="ts">
/**
 * 内置环境状态。
 *
 * 之前这页是假的（写死的步骤列表 + setInterval 推进度条）。现在全部来自
 * GET /api/runtime/health 与 GET /api/runtime/port —— 引擎没起来就老实说没起来。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet } from '@/bridge/http'
import { useConnectionStore } from '@/stores/connection'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

interface Health {
  status: string
  version: string
  engine: { initialized: boolean; llm: string | null; tools: number }
  runtime?: string
}

const router = useRouter()
const connection = useConnectionStore()

const health = ref<Health | null>(null)
const port = ref<number | null>(null)
const failed = ref(false)
const refreshing = ref(false)
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
    port.value = (await apiGet<{ port: number }>('/api/runtime/port')).port
  } catch {
    /* 端口拿不到不算故障，健康检查已经说明问题了 */
  }
  if (manual) refreshing.value = false
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
    <PageHead title="内置环境" @back="goDashboard">
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

      <button v-if="health && health.status !== 'ok'" class="btn btn-soft wide" @click="router.push('/providers')">
        去配置 Provider
      </button>

      <p class="note">
        环境跑在 App 私有目录 <code>$FILES_DIR/rootfs</code> 里，天然沙箱。首次启动要解压内置
        Linux 环境并装基础包，会花一点时间和流量；装好之后不再重复。
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
</style>

