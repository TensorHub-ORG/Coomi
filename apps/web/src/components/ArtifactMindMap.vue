<script setup lang="ts">
/**
 * 主对话「产物思维导图」抽屉。
 * 扫描 timeline 里 assistant 文本 / tool.arguments / tool.resultPreview 中
 * 出现的绝对路径（限定 html/htm/md/py/txt/json/js/ts/vue/css 扩展名），
 * 去重后按目录分组展示。
 * - 文本文件：/api/fs/raw?path=... 预览
 * - HTML 文件：sandbox iframe + srcdoc 渲染
 * - 其他：<pre> 兜底
 * - 支持复制路径 / 另存为 / 用其它应用打开
 * 交互：右边缘左滑打开、向右滑关闭（与主内容共用一个 overlay 栈）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import { authedFetch, engineToken } from '@/bridge/http'
import CoomiIcon from './CoomiIcon.vue'
import type { Timelineitem } from '@/stores/viewModel'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const session = useSessionStore()

/* ── 路径扫描 ── */
const EXTS = /\.html?$|\.md$|\.py$|\.txt$|\.json$|\.js$|\.ts$|\.vue$|\.css$/i

interface FileNode {
  path: string
  dir: string
  name: string
  lower: string
}

/** 从一段文本里提取所有绝对路径（限定扩展名） */
function scanText(text: string): string[] {
  const re = /(?:^|[\s"`'[(<])(\/(?:[\w.\-]+\/)+[\w.\-]+\.\w+)/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (EXTS.test(m[1])) out.push(m[1])
  }
  return out
}

function extractPaths(items: readonly Timelineitem[]): string[] {
  const set = new Set<string>()
  for (const item of items) {
    if (item.kind === 'assistant') {
      for (const p of scanText(item.content)) set.add(p)
    } else if (item.kind === 'tool') {
      // arguments 里的 file_path / path / target 等常见字段
      for (const v of Object.values(item.arguments)) {
        if (typeof v === 'string') {
          for (const p of scanText(v)) set.add(p)
        }
      }
      if (item.resultPreview) {
        for (const p of scanText(item.resultPreview)) set.add(p)
      }
    }
  }
  return [...set]
}

function buildNodes(items: readonly Timelineitem[]): FileNode[] {
  const seen = new Set<string>()
  const nodes: FileNode[] = []
  for (const p of extractPaths(items)) {
    if (!EXTS.test(p)) continue
    if (seen.has(p)) continue
    seen.add(p)
    const parts = p.split('/')
    nodes.push({ path: p, dir: parts.slice(1, -1).join('/'), name: parts[parts.length - 1], lower: p.toLowerCase() })
  }
  return nodes
}

const fileNodes = ref<FileNode[]>([])
watch(() => session.timeline, t => { fileNodes.value = buildNodes(t) }, { deep: false, immediate: true })

/* ── 分组 ── */
interface DirGroup { dir: string; files: FileNode[] }
const groups = computed<DirGroup[]>(() => {
  const m = new Map<string, FileNode[]>()
  for (const n of fileNodes.value) {
    const key = n.dir || '/'
    if (!m.has(key)) m.set(key, [])
    m.get(key)!.push(n)
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, files]) => ({ dir, files }))
})

/* ── 预览 ── */
const previewOpen = ref(false)
const previewPath = ref('')
const previewText = ref('')
const previewLoading = ref(false)
const previewError = ref('')

const previewName = computed(() => previewPath.value.split('/').pop() || previewPath.value)
const isHtml = computed(() => /\.html?$/i.test(previewPath.value))
const isText = computed(() => /\.(txt|md|json|js|ts|vue|css|py|xml|log|sh|toml|yaml|yml|ini|env)$/i.test(previewPath.value))
const isImage = computed(() => /\.(png|jpe?g|gif|webp|svg)$/i.test(previewPath.value))
const previewSrc = computed(() =>
  '/api/fs/raw?path=' + encodeURIComponent(previewPath.value)
  + '&token=' + encodeURIComponent(engineToken()))

function openPreview(path: string) {
  previewPath.value = path
  previewText.value = ''
  previewError.value = ''
  previewOpen.value = true
  if (isText.value || isHtml.value) {
    previewLoading.value = true
    void authedFetch(previewSrc.value)
      .then(r => r.text())
      .then(t => { previewText.value = t })
      .catch(() => { previewError.value = '无法读取文件' })
      .finally(() => { previewLoading.value = false })
  }
}

/* ── 操作 ── */
function copyPath(path: string) {
  void navigator.clipboard?.writeText(path).catch(() => {})
}
function saveAs(path: string) {
  const name = path.split('/').pop() || 'file'
  window.CoomiAndroid?.exportFile?.(path, name)
}
function openExternal(path: string) {
  window.CoomiAndroid?.openFile?.(path)
}

/* ── 手势：向右滑关闭 ── */
let touchStartX = 0
let touchStartY = 0
let touching = false

function onTouchStart(e: TouchEvent) {
  if (e.touches.length !== 1 || !props.open) return
  touching = true
  touchStartX = e.touches[0].clientX
  touchStartY = e.touches[0].clientY
}
function onTouchMove(e: TouchEvent) {
  if (!touching) return
  const dx = e.touches[0].clientX - touchStartX
  const dy = e.touches[0].clientY - touchStartY
  if (Math.abs(dx) < Math.abs(dy)) return
  if (dx > 80) {
    emit('close')
    touching = false
  }
}
function onTouchEnd() { touching = false }

onMounted(() => {
  window.addEventListener('touchstart', onTouchStart, { passive: true })
  window.addEventListener('touchmove', onTouchMove, { passive: true })
  window.addEventListener('touchend', onTouchEnd)
})
onBeforeUnmount(() => {
  window.removeEventListener('touchstart', onTouchStart)
  window.removeEventListener('touchmove', onTouchMove)
  window.removeEventListener('touchend', onTouchEnd)
})

const close = () => emit('close')
</script>

<template>
  <div class="art-root" :class="{ open }">
    <div class="scrim" @click="close" />
    <aside class="panel" role="dialog" aria-label="产物思维导图">
      <header class="dhead">
        <span class="dtitle">产物思维导图</span>
        <button class="x" aria-label="关闭" @click="close"><CoomiIcon name="close" :size="16" /></button>
      </header>

      <p v-if="!fileNodes.length" class="empty">暂无产物。Agent 生成文件后自动收集。</p>

      <div v-for="g in groups" :key="g.dir" class="grp">
        <p class="glabel">{{ g.dir }}</p>
        <div class="node" v-for="f in g.files" :key="f.path">
          <div class="card">
            <CoomiIcon name="fileRead" :size="14" class="cicon" />
            <span class="cname">{{ f.name }}</span>
            <div class="cacts">
              <button class="cbtn" @click="openPreview(f.path)"><CoomiIcon name="eye" :size="12" />预览</button>
              <button class="cbtn" @click="copyPath(f.path)"><CoomiIcon name="link" :size="12" />路径</button>
              <button class="cbtn" @click="saveAs(f.path)"><CoomiIcon name="download" :size="12" />另存</button>
              <button class="cbtn" @click="openExternal(f.path)"><CoomiIcon name="external" :size="12" />打开</button>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <!-- 预览面板 -->
    <div v-if="previewOpen" class="pv-mask" @click.self="previewOpen = false">
      <div class="pv-sheet">
        <header class="pv-head">
          <span class="pv-name">{{ previewName }}</span>
          <button class="x" @click="previewOpen = false"><CoomiIcon name="close" :size="15" /></button>
        </header>
        <p class="pv-path">{{ previewPath }}</p>
        <div class="pv-body">
          <template v-if="previewLoading"><p class="pv-hint">读取中…</p></template>
          <template v-else-if="previewError"><p class="pv-hint err">{{ previewError }}</p></template>
          <template v-else-if="isImage"><img :src="previewSrc" class="pv-img" alt="" /></template>
          <template v-else-if="isHtml">
            <iframe :srcdoc="previewText" class="pv-frame" sandbox="allow-scripts" />
          </template>
          <template v-else-if="isText"><pre class="pv-pre">{{ previewText }}</pre></template>
          <template v-else><p class="pv-hint">该类型不支持内联预览</p></template>
        </div>
        <footer class="pv-foot">
          <button @click="copyPath(previewPath)"><CoomiIcon name="link" :size="14" />复制路径</button>
          <button @click="saveAs(previewPath)"><CoomiIcon name="download" :size="14" />另存为</button>
          <button @click="openExternal(previewPath)"><CoomiIcon name="external" :size="14" />用其它应用打开</button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.art-root { position: fixed; inset: 0; z-index: 65; pointer-events: none; }
.art-root.open { pointer-events: auto; }
.scrim { position: absolute; inset: 0; background: rgba(17, 22, 31, .38); opacity: 0; transition: opacity .28s ease; }
.art-root.open .scrim { opacity: 1; }

.panel {
  position: absolute; inset: 0 0 0 auto;
  display: flex; flex-direction: column;
  width: 86%; max-width: 340px;
  padding-top: var(--safe-top);
  background: var(--bg);
  box-shadow: var(--shadow-sheet);
  transform: translateX(100%);
  transition: transform .3s cubic-bezier(.22, .68, .19, 1);
  overflow-y: auto;
}
.art-root.open .panel { transform: translateX(0); }

.dhead {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 14px 10px;
  border-bottom: 1px solid var(--border);
}
.dtitle { font-size: 15px; font-weight: 650; color: var(--text); }
.x { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 50%; background: var(--fill); color: var(--text-2); }

.empty { padding: 26px 14px; text-align: center; color: var(--text-3); font-size: 12.5px; line-height: 1.7; }

.grp { padding: 8px 14px; }
.glabel {
  font-size: 11px; color: var(--text-3); font-weight: 600;
  padding: 4px 0; margin-bottom: 4px;
  font-family: var(--font-mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.node { margin-bottom: 8px; }
.card {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--bg-elev);
}
.cicon { color: var(--blue); flex: none; }
.cname { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cacts { display: flex; gap: 4px; flex: none; }
.cbtn {
  display: inline-flex; align-items: center; gap: 3px;
  height: 26px; padding: 0 7px;
  border: 0; border-radius: 6px;
  background: var(--fill); color: var(--text-2);
  font-size: 10.5px; font-weight: 550;
}
.cbtn:active { background: var(--fill-press); }

/* ── 预览 ── */
.pv-mask { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, .45); display: flex; align-items: flex-end; }
.pv-sheet {
  width: 100%; max-height: 82vh; overflow-y: auto;
  background: var(--bg);
  border-radius: 18px 18px 0 0;
  padding: 14px 14px calc(14px + var(--safe-bottom));
  display: flex; flex-direction: column;
  animation: rise .22s cubic-bezier(.22,.68,.19,1) both;
}
@keyframes rise { from { transform: translateY(18px); opacity: .5 } to { transform: none; opacity: 1 } }

.pv-head { display: flex; align-items: center; gap: 8px; color: var(--text); }
.pv-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14.5px; font-weight: 650; }
.pv-path { margin: 4px 0 0; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-body { flex: 1; min-height: 0; overflow-y: auto; margin-top: 10px; border-radius: var(--r-sm); }
.pv-hint { text-align: center; color: var(--text-3); font-size: 12.5px; padding: 30px 0; }
.pv-hint.err { color: var(--danger); }
.pv-img { max-width: 100%; border-radius: var(--r-sm); }
.pv-frame { width: 100%; height: 240px; border: 1px solid var(--border); border-radius: 9px; background: #fff; }
.pv-pre { margin: 0; padding: 10px; background: var(--code-bg); border-radius: var(--r-sm); font-family: var(--font-mono); font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; color: var(--code-text); max-height: 320px; overflow: auto; }

.pv-foot { display: flex; gap: 6px; margin-top: 12px; }
.pv-foot button {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  height: 40px; border: 0; border-radius: var(--r-md);
  background: var(--fill-strong); color: var(--text-2);
  font-size: 11.5px; font-weight: 550;
}
.pv-foot button:active { opacity: .8; }
</style>
