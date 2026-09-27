<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import { goBack } from '@/bridge/navigation'

const UPDATE_ROOT = 'https://api.monai.ccwu.cc/coomi/'
const UPDATE_META = `${UPDATE_ROOT}latest.json`

interface UpdateInfo {
  versionCode: number
  version: string
  notes: string
  publishedAt: string
  apkUrl?: string
  sha256?: string
  size?: number
}

const router = useRouter()
const loading = ref(true)
const installing = ref(false)
const error = ref('')
const info = ref<UpdateInfo | null>(null)
const currentCode = ref(0)
const canInstall = computed(() => Boolean(window.CoomiAndroid?.installApk))
const hasUpdate = computed(() => Boolean(info.value && info.value.versionCode > currentCode.value))

function resolveApkUrl(data: Record<string, unknown>): string | undefined {
  const direct = String(data.url ?? '').trim()
  if (/^https?:\/\//i.test(direct)) return direct
  const file = String(data.file ?? '').trim()
  return file ? UPDATE_ROOT + encodeURIComponent(file) : undefined
}

async function refresh() {
  loading.value = true
  error.value = ''
  info.value = null
  try {
    const response = await fetch(UPDATE_META, { cache: 'no-store', headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`更新源返回 HTTP ${response.status}`)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) throw new Error('更新源没有返回 JSON，请稍后重试')
    const data = await response.json() as Record<string, unknown>
    const versionCode = Number(data.versionCode) || 0
    const version = String(data.version ?? '').trim()
    if (!versionCode || !version) throw new Error('更新信息缺少版本号')
    info.value = {
      versionCode,
      version,
      notes: String(data.notes ?? ''),
      publishedAt: String(data.publishedAt ?? data.date ?? ''),
      apkUrl: resolveApkUrl(data),
      sha256: String(data.sha256 ?? ''),
      size: Number(data.size) || undefined,
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

function install() {
  if (!hasUpdate.value || !info.value?.apkUrl || !canInstall.value) return
  installing.value = true
  window.CoomiAndroid!.installApk!(info.value.apkUrl, info.value.version)
  setTimeout(() => { installing.value = false }, 1500)
}

function formatSize(value?: number): string {
  return value ? `${(value / 1024 / 1024).toFixed(1)} MB` : '—'
}

onMounted(() => {
  currentCode.value = window.CoomiAndroid?.getAppVersionCode?.() ?? 0
  void refresh()
})
</script>

<template>
  <div class="page">
    <PageHead title="检查更新" @back="goBack(router, 'dashboard')" />
    <main class="body">
      <section class="source-card">
        <span>魔改版更新源</span>
        <code>api.monai.ccwu.cc/coomi</code>
        <button :disabled="loading" @click="refresh">重新检测</button>
      </section>

      <p v-if="error" class="notice error">{{ error }}</p>
      <p v-if="loading" class="notice">正在从魔改版更新源获取信息…</p>

      <template v-if="info">
        <section class="group">
          <div class="line"><span>检测结果</span><strong :class="hasUpdate ? 'new' : 'ok'">{{ hasUpdate ? '发现新版本' : '已是最新版' }}</strong></div>
          <div class="line"><span>最新版本</span><strong>v{{ info.version }} · build {{ info.versionCode }}</strong></div>
          <div class="line"><span>本地版本</span><strong>build {{ currentCode || '—' }}</strong></div>
          <div class="line"><span>安装包大小</span><strong>{{ formatSize(info.size) }}</strong></div>
          <div v-if="info.publishedAt" class="line"><span>发布时间</span><strong>{{ info.publishedAt }}</strong></div>
          <div v-if="info.sha256" class="hash"><span>SHA-256</span><code>{{ info.sha256 }}</code></div>
          <div v-if="info.notes" class="notes">{{ info.notes }}</div>
        </section>

        <button class="primary" :disabled="installing || !canInstall || !hasUpdate || !info.apkUrl" @click="install">
          {{ installing ? '正在下载安装…' : hasUpdate ? '下载并安装魔改版' : '当前已是最新版' }}
        </button>
      </template>
    </main>
  </div>
</template>

<style scoped>
.page{display:flex;flex-direction:column;height:100%;background:var(--page)}.body{flex:1;overflow:auto;padding:14px 12px calc(var(--safe-bottom) + 24px)}.source-card{display:grid;grid-template-columns:1fr auto;align-items:center;gap:5px 10px;margin-bottom:12px;padding:12px 13px;border:1px solid var(--border);border-radius:var(--r-card);background:var(--bg)}.source-card span{color:var(--text);font-size:13px;font-weight:650}.source-card code{grid-column:1;color:var(--blue);font:11px var(--font-mono)}.source-card button{grid-column:2;grid-row:1/3;min-height:36px;padding:0 11px;border-radius:var(--r-sm);background:var(--blue-soft);color:var(--blue);font-size:12px}.notice{margin:0 0 10px;padding:9px 12px;border-radius:var(--r-md);background:var(--blue-soft);color:var(--blue);font-size:12.5px}.notice.error{background:var(--danger-soft);color:var(--danger)}.group{margin-bottom:12px;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-card);background:var(--bg)}.line{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 13px;border-bottom:1px solid var(--border);font-size:13px}.line span,.hash span{color:var(--text-3)}.line strong{color:var(--text);text-align:right}.line strong.new{color:var(--blue)}.line strong.ok{color:var(--ok)}.hash{display:grid;gap:5px;padding:11px 13px;border-bottom:1px solid var(--border);font-size:11px}.hash code{overflow-wrap:anywhere;color:var(--text-2);font-family:var(--font-mono)}.notes{padding:12px 13px;color:var(--text-2);font-size:12.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word}.primary{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;border-radius:var(--r-md);background:var(--blue);color:white;font-size:14px;font-weight:650}.primary:disabled{opacity:.5}
</style>
