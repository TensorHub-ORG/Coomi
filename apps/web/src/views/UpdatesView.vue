<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import { goBack } from '@/bridge/navigation'

/** 更新通道：正式 / 测试，取自 updates.septemc.com 各自目录下的 latest.json。 */
const CHANNELS = {
  stable: { label: '正式更新', dir: 'https://updates.septemc.com/coomi/android' },
  test: { label: '测试更新', dir: 'https://updates.septemc.com/coomi/android_test' },
} as const

type Channel = keyof typeof CHANNELS
interface UpdateInfo {
  versionCode: number
  version: string
  notes: string
  date: string
  channel: Channel
  apkUrl?: string
}

const router = useRouter()
const channel = ref<Channel>('stable')
const loading = ref(true)
const installing = ref(false)
const error = ref('')
const info = ref<UpdateInfo | null>(null)

const canInstall = computed(() => Boolean(window.CoomiAndroid?.installApk))

// 批次七 #9：与当前版本比对——更新页明确给出「已是最新 / 有新版本」状态，
// 已是最新时隐藏下载按钮（旧版会重复下载同版本包）。
const hasUpdate = computed(() => Boolean(info.value && info.value.versionCode > currentCode.value))
const versionStatusText = computed(() => {
  if (!info.value) return ''
  if (hasUpdate.value) return `有新版本 v${info.value.version}`
  if (info.value.versionCode && info.value.versionCode === currentCode.value) return '已是最新版本'
  return '当前版本较新（或版本号无法比较）'
})

async function refresh() {
  loading.value = true
  error.value = ''
  info.value = null
  const dir = CHANNELS[channel.value].dir
  try {
    const response = await fetch(`${dir}/latest.json`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`更新源返回 HTTP ${response.status}`)
    const data = await response.json()
    const file: string | undefined = data.file
    info.value = {
      versionCode: Number(data.versionCode) || 0,
      version: String(data.version ?? ''),
      notes: String(data.notes ?? ''),
      date: String(data.date ?? ''),
      channel: channel.value,
      apkUrl: file ? `${dir}/${file}` : undefined,
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function switchChannel(next: Channel) {
  if (channel.value === next) return
  channel.value = next
  void refresh()
}

function install() {
  if (!info.value?.apkUrl || !info.value.version || !canInstall.value) return
  installing.value = true
  window.CoomiAndroid!.installApk!(info.value.apkUrl, info.value.version)
  setTimeout(() => { installing.value = false }, 1500)
}

const currentCode = ref(0)
const currentVersionName = ref('')

onMounted(() => {
  currentCode.value = window.CoomiAndroid?.getAppVersionCode?.() ?? 0
  currentVersionName.value = window.CoomiAndroid?.getAppVersionName?.() ?? ''
  void refresh()
})
</script>

<template>
  <div class="page">
    <PageHead title="检查更新" @back="goBack(router, 'dashboard')" />

    <main class="body">
      <div class="channel-tabs">
        <button
          v-for="(item, key) in CHANNELS"
          :key="key"
          :class="{ selected: channel === key }"
          @click="switchChannel(key)"
        >
          {{ item.label }}
        </button>
      </div>

      <p v-if="error" class="notice error">{{ error }}</p>
      <p v-if="loading" class="notice">正在获取更新信息…</p>

      <template v-if="info">
        <section class="group">
          <div class="line"><span>更新通道</span><strong>{{ CHANNELS[info.channel].label }}</strong></div>
          <div class="line">
            <span>版本状态</span>
            <strong :class="{ fresh: hasUpdate }">{{ versionStatusText }}</strong>
          </div>
          <div class="line"><span>最新版本</span><strong>v{{ info.version }}（build {{ info.versionCode }}）</strong></div>
          <div v-if="info.date" class="line"><span>发布日期</span><strong>{{ info.date }}</strong></div>
          <div class="line"><span>本地版本</span><strong>{{ currentVersionName || '—' }}（build {{ currentCode || '—' }}）</strong></div>
          <div v-if="info.notes" class="notes">{{ info.notes }}</div>
        </section>

        <button v-if="hasUpdate" class="primary" :disabled="installing || !canInstall" @click="install">
          {{ installing ? '正在下载安装…' : '下载并安装' }}
        </button>
        <p v-else class="notice">当前已是该通道的最新版本，无需更新。</p>
      </template>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); }
.channel-tabs { display: flex; gap: 8px; margin-bottom: 22px; }
.channel-tabs button {
  flex: 1; height: 38px; border-radius: 8px;
  background: var(--fill); color: var(--text-2); font-size: 13px;
}
.channel-tabs button.selected { background: var(--blue); color: #fff; }
.notice { margin: 0 0 10px; padding: 8px 12px; border-radius: 8px; background: var(--blue-soft); color: var(--blue); font-size: 12.5px; }
.fresh { color: var(--focus, #b4690e); }
.notice.error { background: color-mix(in srgb, var(--orange) 16%, var(--bg)); color: var(--orange); }
.group { margin-bottom: 12px; overflow: hidden; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.line { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 13px; border-bottom: 1px solid var(--border); font-size: 13px; }
.line:last-of-type { border-bottom: 0; }
.line span { color: var(--text-3); }
.line strong { color: var(--text); }
.notes { padding: 12px 13px; font-size: 12.5px; line-height: 1.6; color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
.primary, .secondary { display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 44px; border-radius: 10px; background: var(--blue); color: #fff; font-size: 14px; }
.primary:disabled { opacity: 0.55; }
</style>
