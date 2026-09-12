<script setup lang="ts">
/**
 * 运维诊断：网络诊断 / 存储分析 / 日志诊断包 / Guest 工具 / 凭据管理 / 远端连通测试。
 * 全部数据来自 /api/git/*（见 src/bridge/ops.ts）。
 * 所有操作失败用行内错误提示，不弹窗。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { goBack } from '@/bridge/navigation'
import {
  createLogBundle,
  deleteCredential,
  guestTools,
  listCredentials,
  networkDiagnostics,
  saveCredential,
  storageAnalysis,
  testRemote,
  type CredentialEntry,
  type GuestTool,
  type NetworkReport,
  type RemoteTestResult,
  type StorageReport,
} from '@/bridge/ops'

const router = useRouter()

// ── 标签页 ─────────────────────────────────────────────────
type Tab = 'network' | 'storage' | 'bundle' | 'tools' | 'credentials' | 'remote'
const TABS: { key: Tab; label: string }[] = [
  { key: 'network', label: '网络诊断' },
  { key: 'storage', label: '存储分析' },
  { key: 'bundle', label: '日志诊断包' },
  { key: 'tools', label: 'Guest 工具' },
  { key: 'credentials', label: '凭据管理' },
  { key: 'remote', label: '远端连通测试' },
]
const activeTab = ref<Tab>('network')

// ── 网络诊断 ───────────────────────────────────────────────
const netReport = ref<NetworkReport | null>(null)
const netBusy = ref(false)
const netError = ref('')

async function runNetwork() {
  if (netBusy.value) return
  netBusy.value = true
  netError.value = ''
  try {
    netReport.value = await networkDiagnostics()
  } catch (e) {
    netError.value = `诊断失败：${e instanceof Error ? e.message : e}`
  } finally {
    netBusy.value = false
  }
}

// ── 存储分析 ───────────────────────────────────────────────
const storage = ref<StorageReport | null>(null)
const storageBusy = ref(false)
const storageError = ref('')

async function runStorage() {
  if (storageBusy.value) return
  storageBusy.value = true
  storageError.value = ''
  try {
    storage.value = await storageAnalysis()
  } catch (e) {
    storageError.value = `分析失败：${e instanceof Error ? e.message : e}`
  } finally {
    storageBusy.value = false
  }
}

function fmtBytes(n: number | undefined): string {
  if (!n) return '0 B'
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** 类别占比（相对 workspace 总量），返回 0-100 的数值与展示串。 */
function catPct(bytes: number): { num: number; label: string } {
  const total = storage.value?.workspace_bytes ?? 0
  if (!total) return { num: 0, label: '0%' }
  const num = Math.min(100, (bytes / total) * 100)
  return { num, label: `${num.toFixed(1)}%` }
}

// ── 日志诊断包 ─────────────────────────────────────────────
const bundlePath = ref('')
const bundleBusy = ref(false)
const bundleError = ref('')

async function runBundle() {
  if (bundleBusy.value) return
  bundleBusy.value = true
  bundleError.value = ''
  bundlePath.value = ''
  try {
    const r = await createLogBundle()
    bundlePath.value = r.path
  } catch (e) {
    bundleError.value = `打包失败：${e instanceof Error ? e.message : e}`
  } finally {
    bundleBusy.value = false
  }
}

// ── Guest 工具 ─────────────────────────────────────────────
const tools = ref<GuestTool[]>([])
const toolsBusy = ref(false)
const toolsError = ref('')

async function runTools() {
  if (toolsBusy.value) return
  toolsBusy.value = true
  toolsError.value = ''
  try {
    tools.value = await guestTools()
  } catch (e) {
    toolsError.value = `探测失败：${e instanceof Error ? e.message : e}`
  } finally {
    toolsBusy.value = false
  }
}

// ── 凭据管理 ───────────────────────────────────────────────
const creds = ref<CredentialEntry[]>([])
const credBusy = ref(false)
const credError = ref('')
const credForm = ref({ service: '', key: '', token: '' })

async function loadCreds() {
  if (credBusy.value) return
  credBusy.value = true
  credError.value = ''
  try {
    creds.value = await listCredentials()
  } catch (e) {
    credError.value = `凭据加载失败：${e instanceof Error ? e.message : e}`
  } finally {
    credBusy.value = false
  }
}

async function addCred() {
  const service = credForm.value.service.trim()
  const key = credForm.value.key.trim()
  const token = credForm.value.token
  if (!service || !key || !token) {
    credError.value = '请填写服务、键名与 Token'
    return
  }
  if (credBusy.value) return
  credBusy.value = true
  credError.value = ''
  try {
    await saveCredential({ service, key, token })
    credForm.value = { service: '', key: '', token: '' }
    creds.value = await listCredentials()
  } catch (e) {
    credError.value = `保存失败：${e instanceof Error ? e.message : e}`
  } finally {
    credBusy.value = false
  }
}

async function removeCred(entry: CredentialEntry) {
  if (credBusy.value) return
  credBusy.value = true
  credError.value = ''
  try {
    await deleteCredential(entry.service, entry.key)
    creds.value = creds.value.filter(c => c.service !== entry.service || c.key !== entry.key)
  } catch (e) {
    credError.value = `删除失败：${e instanceof Error ? e.message : e}`
  } finally {
    credBusy.value = false
  }
}

// ── 远端连通测试 ───────────────────────────────────────────
const remoteUrl = ref('')
const remoteToken = ref('')
const remoteBusy = ref(false)
const remoteError = ref('')
const remoteResult = ref<RemoteTestResult | null>(null)

async function runRemoteTest() {
  const url = remoteUrl.value.trim()
  if (!url) {
    remoteError.value = '请输入远端 URL'
    return
  }
  if (remoteBusy.value) return
  remoteBusy.value = true
  remoteError.value = ''
  remoteResult.value = null
  try {
    remoteResult.value = await testRemote({
      url,
      token: remoteToken.value.trim() || undefined,
    })
  } catch (e) {
    remoteError.value = `测试失败：${e instanceof Error ? e.message : e}`
  } finally {
    remoteBusy.value = false
  }
}

onMounted(() => {
  void runTools()
  void loadCreds()
})
</script>

<template>
  <div class="page">
    <PageHead title="运维诊断" @back="goBack(router, '/settings')" />
    <main class="body">
      <div class="tabs">
        <button v-for="t in TABS" :key="t.key" class="tab" :class="{ on: activeTab === t.key }" @click="activeTab = t.key">{{ t.label }}</button>
      </div>

      <!-- ── 网络诊断 ── -->
      <section v-if="activeTab === 'network'" class="tab-panel">
        <div class="card">
          <div class="card-head">
            <span class="card-title">端点连通性</span>
            <span class="card-side">{{ netReport?.endpoints.length ?? 0 }} 个端点</span>
          </div>
          <div class="card-actions">
            <button class="btn btn-primary" :disabled="netBusy" @click="runNetwork">
              <CoomiIcon name="refresh" :size="15" />{{ netBusy ? '诊断中…' : '运行诊断' }}
            </button>
          </div>
          <p v-if="netError" class="notice err">{{ netError }}</p>
          <div v-if="netReport" class="probe-list">
            <div v-for="p in netReport.endpoints" :key="p.host" class="probe-row">
              <span class="probe-host mono">{{ p.host }}</span>
              <span v-if="p.ok" class="badge ok">ok</span>
              <span v-else class="badge fail">失败</span>
              <span v-if="p.latency_ms != null" class="probe-latency">{{ p.latency_ms }} ms</span>
              <span v-if="p.error" class="probe-error mono">{{ p.error }}</span>
            </div>
          </div>
          <p v-else-if="!netBusy" class="empty">尚未运行诊断。点击「运行诊断」探测常用端点连通性。</p>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">代理环境变量</span></div>
          <p v-if="netReport && !netReport.proxy_env.length" class="empty">未检测到代理环境变量</p>
          <div v-for="e in netReport?.proxy_env ?? []" :key="e" class="env-row mono">{{ e }}</div>
          <p v-if="!netReport" class="hint dim">运行网络诊断后展示。</p>
        </div>
      </section>

      <!-- ── 存储分析 ── -->
      <section v-if="activeTab === 'storage'" class="tab-panel">
        <div class="card">
          <div class="card-head">
            <span class="card-title">空间占用</span>
            <span class="card-side">{{ storage?.truncated ? '已截断' : '' }}</span>
          </div>
          <div class="card-actions">
            <button class="btn btn-primary" :disabled="storageBusy" @click="runStorage">
              <CoomiIcon name="wrench" :size="15" />{{ storageBusy ? '分析中…' : '运行分析' }}
            </button>
          </div>
          <p v-if="storageError" class="notice err">{{ storageError }}</p>
          <template v-if="storage">
            <div class="summary-grid">
              <div class="summary-item">
                <span class="sum-num">{{ fmtBytes(storage.workspace_bytes) }}</span>
                <span class="sum-label">工作区</span>
              </div>
              <div class="summary-item">
                <span class="sum-num">{{ fmtBytes(storage.git_dir_bytes) }}</span>
                <span class="sum-label">.git 目录</span>
              </div>
              <div class="summary-item">
                <span class="sum-num">{{ fmtBytes(storage.home_bytes) }}</span>
                <span class="sum-label">Home</span>
              </div>
            </div>
            <p v-if="storage.truncated" class="hint dim">文件数过多，扫描已提前截断。</p>
            <div class="cat-block">
              <p class="block-title">类别占比（相对工作区）</p>
              <div v-for="c in storage.categories" :key="c.category" class="cat-row">
                <span class="cat-name">{{ c.category }}</span>
                <span class="cat-bar"><i :style="{ width: catPct(c.bytes).num + '%' }" /></span>
                <span class="cat-bytes">{{ fmtBytes(c.bytes) }} · {{ catPct(c.bytes).label }}</span>
              </div>
            </div>
            <div v-if="storage.largest.length" class="cat-block">
              <p class="block-title">Top {{ storage.largest.length }} 大文件</p>
              <div v-for="(f, i) in storage.largest" :key="f.path" class="file-row">
                <span class="rank">{{ i + 1 }}</span>
                <span class="fpath mono">{{ f.path }}</span>
                <span class="fbytes">{{ fmtBytes(f.bytes) }}</span>
              </div>
            </div>
          </template>
          <p v-else-if="!storageBusy" class="empty">尚未运行分析。</p>
        </div>
      </section>

      <!-- ── 日志诊断包 ── -->
      <section v-if="activeTab === 'bundle'" class="tab-panel">
        <div class="card">
          <div class="card-head"><span class="card-title">日志诊断包</span></div>
          <p class="bundle-copy">收集 home 下的 *.log 与 logs/ 目录文件，连同运行环境摘要打包为 tar.gz，输出到 home/diagnostics/ 下。</p>
          <div class="card-actions">
            <button class="btn btn-primary" :disabled="bundleBusy" @click="runBundle">
              <CoomiIcon name="arrowDown" :size="15" />{{ bundleBusy ? '打包中…' : '生成诊断包' }}
            </button>
          </div>
          <p v-if="bundleError" class="notice err">{{ bundleError }}</p>
          <p v-if="bundlePath" class="bundle-path mono"><CoomiIcon name="check" :size="14" />{{ bundlePath }}</p>
        </div>
      </section>

      <!-- ── Guest 工具 ── -->
      <section v-if="activeTab === 'tools'" class="tab-panel">
        <div class="card">
          <div class="card-head">
            <span class="card-title">宿主工具</span>
            <span class="card-side">{{ tools.length }} 个</span>
          </div>
          <div class="card-actions">
            <button class="btn" :disabled="toolsBusy" @click="runTools">
              <CoomiIcon name="refresh" :size="15" />{{ toolsBusy ? '探测中…' : '重新探测' }}
            </button>
          </div>
          <p v-if="toolsError" class="notice err">{{ toolsError }}</p>
          <p v-if="!tools.length && !toolsBusy" class="empty">暂无探测结果</p>
          <div v-for="t in tools" :key="t.name" class="tool-row">
            <span class="tool-name mono">{{ t.name }}</span>
            <span v-if="t.available" class="badge ok">可用</span>
            <span v-else class="badge off">未安装</span>
            <span v-if="t.version" class="badge ver" :title="t.version">{{ t.version }}</span>
          </div>
        </div>
      </section>

      <!-- ── 凭据管理 ── -->
      <section v-if="activeTab === 'credentials'" class="tab-panel">
        <div class="card">
          <div class="card-head">
            <span class="card-title">已保存凭据</span>
            <span class="card-side">{{ creds.length }} 条</span>
          </div>
          <div class="card-actions">
            <button class="btn" :disabled="credBusy" @click="loadCreds">
              <CoomiIcon name="refresh" :size="15" />刷新
            </button>
          </div>
          <p v-if="credError" class="notice err">{{ credError }}</p>
          <p v-if="!creds.length && !credBusy" class="empty">暂无已保存的凭据</p>
          <div v-for="c in creds" :key="c.service + '/' + c.key" class="cred-row">
            <span class="cred-service mono">{{ c.service }}</span>
            <span class="cred-key mono">{{ c.key }}</span>
            <button class="mini-btn danger" :disabled="credBusy" @click="removeCred(c)">删除</button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">新增凭据</span></div>
          <form class="inline-form" @submit.prevent="addCred">
            <input v-model="credForm.service" class="text-input mono" placeholder="服务（如 github）" />
            <input v-model="credForm.key" class="text-input mono" placeholder="键名（如 token）" />
            <input v-model="credForm.token" class="text-input mono" type="password" placeholder="Token" />
            <button class="btn btn-primary" type="submit" :disabled="credBusy">保存</button>
          </form>
          <p class="form-note">凭据仅保存在本机引擎私有目录（文件权限 0600），用于 push 与远端连通测试等场景，不会上传。</p>
        </div>
      </section>

      <!-- ── 远端连通测试 ── -->
      <section v-if="activeTab === 'remote'" class="tab-panel">
        <div class="card">
          <div class="card-head"><span class="card-title">远端连通测试</span></div>
          <form class="inline-form" @submit.prevent="runRemoteTest">
            <input v-model="remoteUrl" class="text-input mono" placeholder="远端 URL（https://… 或 git@…）" />
            <input v-model="remoteToken" class="text-input mono" type="password" placeholder="Token（可选）" />
            <button class="btn btn-primary" type="submit" :disabled="remoteBusy">{{ remoteBusy ? '测试中…' : '测试' }}</button>
          </form>
          <p class="form-note">Token 仅本次请求使用，不会写入 remote URL 或凭据文件。</p>
          <p v-if="remoteError" class="notice err">{{ remoteError }}</p>
          <div v-if="remoteResult" class="remote-result">
            <span v-if="remoteResult.ok" class="badge ok">连接成功</span>
            <span v-else class="badge fail">连接失败</span>
            <span v-if="remoteResult.latency_ms != null" class="probe-latency">{{ remoteResult.latency_ms }} ms</span>
            <span v-if="remoteResult.error" class="probe-error mono">{{ remoteResult.error }}</span>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px calc(var(--safe-bottom) + 24px); }

/* ── 标签页（可横向滚动） ── */
.tabs { display: flex; gap: 4px; margin-bottom: 10px; padding: 4px; border-radius: var(--r-md); background: var(--fill-strong); overflow-x: auto; scrollbar-width: none; }
.tabs::-webkit-scrollbar { display: none; }
.tab { flex: 1 0 auto; min-height: 34px; padding: 0 11px; border-radius: 8px; color: var(--text-2); font-size: 12.3px; font-weight: 550; white-space: nowrap; }
.tab.on { background: var(--bg); color: var(--blue); box-shadow: var(--shadow-1); }
.tab-panel { display: flex; flex-direction: column; gap: 10px; }

/* ── 卡片 ── */
.card { border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.card-head { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 8px 13px; border-bottom: 1px solid var(--border); }
.card-title { font-size: 13.5px; font-weight: 650; color: var(--text); }
.card-side { margin-left: auto; font-size: 12px; color: var(--text-3); }
.card-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 13px 0; }
.card-actions .btn { min-height: 36px; padding: 0 14px; font-size: 13px; }
.inline-form { display: flex; gap: 7px; flex-wrap: wrap; padding: 10px 13px; }
.text-input { flex: 1; min-width: 130px; min-height: 38px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg-input); color: var(--text); font-size: 12.5px; }
.inline-form .btn { min-height: 38px; padding: 0 15px; font-size: 13px; }
.form-note { margin: 0; padding: 0 13px 12px; font-size: 11.5px; color: var(--text-3); line-height: 1.6; }

/* ── 提示 ── */
.notice { margin: 0; padding: 8px 12px; border-radius: var(--r-sm); background: var(--ok-soft); color: var(--ok); font-size: 12.5px; line-height: 1.5; word-break: break-all; }
.notice.err { background: var(--danger-soft); color: var(--danger); }
.hint { padding: 14px 4px; color: var(--text-3); font-size: 12.5px; text-align: center; }
.hint.dim { padding: 6px 4px; font-size: 11.5px; }
.empty { padding: 16px 4px; color: var(--text-3); font-size: 12.5px; text-align: center; }
.badge { flex-shrink: 0; padding: 2px 8px; border-radius: var(--r-pill); font-size: 10.5px; font-weight: 600; }
.badge.ok { background: var(--ok-soft); color: var(--ok); }
.badge.fail { background: var(--danger-soft); color: var(--danger); }
.badge.off { background: var(--fill-strong); color: var(--text-3); }
.badge.ver { max-width: 55%; overflow: hidden; background: var(--blue-soft); color: var(--blue); text-overflow: ellipsis; white-space: nowrap; }
.mini-btn { flex-shrink: 0; min-height: 26px; padding: 0 8px; border-radius: 6px; background: var(--fill-strong); color: var(--text-2); font-size: 11px; }
.mini-btn:active { background: var(--fill-press); }
.mini-btn:disabled { opacity: .4; }
.mini-btn.danger { color: var(--danger); background: var(--danger-soft); }

/* ── 网络诊断 ── */
.probe-list { padding: 4px 0; }
.probe-row { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 6px 13px; border-bottom: 1px solid var(--border); }
.probe-row:last-child { border-bottom: none; }
.probe-host { flex: 1; min-width: 0; overflow: hidden; color: var(--text); font-size: 12.3px; text-overflow: ellipsis; white-space: nowrap; }
.probe-latency { flex-shrink: 0; color: var(--text-3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.probe-error { max-width: 46%; overflow: hidden; color: var(--danger); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.env-row { padding: 9px 13px; border-bottom: 1px solid var(--border); color: var(--text-2); font-size: 12px; word-break: break-all; }
.env-row:last-child { border-bottom: none; }

/* ── 存储分析 ── */
.summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 12px 13px; }
.summary-item { display: flex; flex-direction: column; gap: 3px; padding: 9px 10px; border-radius: var(--r-sm); background: var(--fill); }
.sum-num { color: var(--text); font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sum-label { color: var(--text-3); font-size: 11px; }
.cat-block { padding: 4px 13px 12px; }
.block-title { margin: 8px 0 7px; font-size: 12.5px; font-weight: 650; color: var(--text-2); }
.cat-row { display: flex; align-items: center; gap: 9px; min-height: 30px; }
.cat-name { flex-shrink: 0; width: 92px; overflow: hidden; color: var(--text-2); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.cat-bar { flex: 1; min-width: 0; height: 8px; border-radius: 4px; background: var(--fill-strong); overflow: hidden; }
.cat-bar i { display: block; height: 100%; border-radius: 4px; background: var(--blue); }
.cat-bytes { flex-shrink: 0; color: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.file-row { display: flex; align-items: center; gap: 9px; min-height: 36px; border-bottom: 1px solid var(--border); }
.file-row:last-child { border-bottom: none; }
.rank { flex-shrink: 0; width: 22px; color: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; }
.fpath { flex: 1; min-width: 0; overflow: hidden; color: var(--text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.fbytes { flex-shrink: 0; color: var(--text-2); font-size: 11.5px; font-variant-numeric: tabular-nums; }

/* ── 日志诊断包 ── */
.bundle-copy { margin: 0; padding: 10px 13px 0; color: var(--text-2); font-size: 12.5px; line-height: 1.65; }
.bundle-path { display: flex; align-items: center; gap: 6px; margin: 0; padding: 10px 13px 12px; color: var(--ok); font-size: 12px; line-height: 1.5; word-break: break-all; }

/* ── Guest 工具 ── */
.tool-row { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 6px 13px; border-bottom: 1px solid var(--border); }
.tool-row:last-child { border-bottom: none; }
.tool-name { flex-shrink: 0; color: var(--text); font-size: 12.8px; font-weight: 600; }
.tool-version { margin-left: auto; max-width: 50%; overflow: hidden; color: var(--text-3); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }

/* ── 凭据 ── */
.cred-row { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 6px 13px; border-bottom: 1px solid var(--border); }
.cred-row:last-child { border-bottom: none; }
.cred-service { flex-shrink: 0; min-width: 74px; color: var(--blue); font-size: 12.5px; font-weight: 600; }
.cred-key { flex: 1; min-width: 0; overflow: hidden; color: var(--text); font-size: 12.3px; text-overflow: ellipsis; white-space: nowrap; }

/* ── 远端连通测试 ── */
.remote-result { display: flex; align-items: center; gap: 8px; padding: 2px 13px 12px; }
</style>
