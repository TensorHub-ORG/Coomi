<script setup lang="ts">
/**
 * 输入区。
 * DeepSeek 的输入框是「一整块大圆角卡片」：文本在上，模式开关和发送在下一行。
 * 这里的两个 chip 都对应真实协议能力（enter/exit_plan_mode、set_permission_mode），
 * ⊕ 展开指令面板：Android SAF 文件导入 + 可滚动的斜杠指令列表。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PERMISSION_MODES, REASONING_EFFORTS, useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { useSessionsStore } from '@/stores/sessions'
import { gitLog, gitStatus, type CommitInfo } from '@/bridge/git'
import type { SessionMeta } from '@/stores/sessions'
import { useRouter } from 'vue-router'
import CoomiIcon from './CoomiIcon.vue'

const session = useSessionStore()
const config = useConfigStore()
const sessionsStore = useSessionsStore()
const router = useRouter()

/** 斜杠指令：点击后填入输入框，可编辑后发送。hint 存在时作为默认任务文本一并填入。 */
const SLASH_COMMANDS = [
  { name: '/loop', desc: '循环执行直到完成' },
  { name: '/plan', desc: '进入计划模式' },
  { name: '/mcp', desc: '管理 MCP 服务器' },
  { name: '/skills', desc: '查看可用技能' },
  { name: '/memory', desc: '查看 Coomi 内建持久记忆' },
  { name: '/compact', desc: '立即压缩当前上下文' },
  // 工程向快捷任务（对应引擎 /api/git/* 能力；hint 为默认任务文本，可编辑后发送）
  { name: '/review', desc: '审查当前未提交改动', hint: '审查当前未提交改动，输出结构化问题清单' },
  { name: '/fix', desc: '一键修复当前改动问题', hint: '修复当前未提交改动中发现的问题' },
  { name: '/pr', desc: '生成 PR 描述并创建', hint: '基础分支 main' },
  { name: '/compare', desc: '对比快照与当前状态', hint: '对比最近快照与当前工作区' },
  { name: '/summary', desc: '总结当前会话', hint: '总结当前会话的进展与关键结论' },
  { name: '/adversarial', desc: '对抗式评审当前改动', hint: '对当前未提交改动做对抗式评审' },
  { name: '/root-cause', desc: '分析最近变更根因', hint: '分析最近一次提交的动机与影响' },
]

const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const quickOpen = ref(false)
const lifeStatsOpen = ref(false)
const transferText = ref('')
const transferProgress = ref(0)
const textareaScrollable = ref(false)
const hasNative = typeof window !== 'undefined' && !!window.CoomiAndroid

const canSend = computed(() => text.value.trim().length > 0)
const isJumpIn = computed(() => session.isBusy && canSend.value)
const showStop = computed(() => session.isBusy && !canSend.value)
const modeLabel = computed(() => PERMISSION_MODES.find(m => m.mode === config.permissionMode)?.label ?? '')
const providerReady = computed(() => config.providers.some(provider => (
  provider.id === config.activeId
  && (provider.models.length > 0 || Boolean(provider.model?.trim()))
  && Boolean(provider.baseUrl)
)))

function autoGrow() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  const scrollHeight = el.scrollHeight
  const maxHeight = Number.parseFloat(getComputedStyle(el).maxHeight) || 132
  textareaScrollable.value = scrollHeight > maxHeight
  el.style.height = Math.min(scrollHeight, maxHeight) + 'px'
}

async function submit() {
  if (!canSend.value) return
  if (!providerReady.value) {
    await config.fetchProviders()
    if (!providerReady.value) {
      await router.push('/providers')
      return
    }
  }
  session.sendMessage(text.value)
  text.value = ''
  await nextTick()
  autoGrow()
}

/** 主按钮：空着且在忙 = 停止，其余 = 发送 / 插队。 */
function tapPrimary() {
  if (showStop.value) session.cancel()
  else submit()
}

function onKeydown(e: KeyboardEvent) {
  // @ 候选面板激活时：方向键导航、Enter 选中、Esc 关闭。
  if (atOpen.value) {
    if (e.key === 'ArrowDown') { e.preventDefault(); atIndex.value = (atIndex.value + 1) % Math.max(atCandidates.value.length, 1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); atIndex.value = (atIndex.value - 1 + Math.max(atCandidates.value.length, 1)) % Math.max(atCandidates.value.length, 1); return }
    if (e.key === 'Enter') { e.preventDefault(); const c = atCandidates.value[atIndex.value]; if (c) pickAt(c); return }
    if (e.key === 'Escape') { e.preventDefault(); atOpen.value = false; return }
  }
  // Enter 默认换行（需求：换行键就换行）；Ctrl/Cmd+Enter 仍可快捷发送。
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
}

function cycleMode() { session.setPermissionMode(config.cyclePermissionMode()) }
function cycleSessionMode() {
  const next = session.mode === 'agent' ? 'team' : session.mode === 'team' ? 'agent' : 'agent'
  session.setSessionMode(next)
}

async function insert(t: string) {
  text.value = text.value.trim() ? text.value.replace(/\s+$/, '') + '\n' + t : t
  quickOpen.value = false
  await nextTick()
  autoGrow()
  textarea.value?.focus()
}

/** 斜杠指令插入（批次五 #20）：不覆盖已输入内容——
 * 无输入 → `cmd `；已有普通输入 → `cmd <原输入>`；已是别的指令 → 只替换指令头。
 * 指令带 hint 时把默认任务文本一并填入（如 `/pr 基础分支 main`）。 */
async function insertSlash(cmd: { name: string; hint?: string }) {
  const tail = cmd.hint ? `${cmd.name} ${cmd.hint}` : `${cmd.name} `
  const existing = text.value.replace(/^\s+/, '')
  if (!existing) {
    text.value = tail
  } else if (existing.startsWith('/')) {
    const rest = existing.replace(/^\/\S+\s*/, '')
    text.value = rest ? `${tail} ${rest}` : tail
  } else {
    text.value = `${tail} ${existing}`
  }
  quickOpen.value = false
  await nextTick()
  autoGrow()
  textarea.value?.focus()
}

// ── @ 快捷上下文注入：输入 @ 弹出 文件/提交/会话 候选 ──
type AtTab = 'files' | 'commits' | 'sessions'
interface AtItem {
  kind: 'file' | 'commit' | 'session'
  icon: string
  label: string
  sub: string
  insert: string
}
const AT_TABS: Array<{ key: AtTab; label: string }> = [
  { key: 'files', label: '文件' },
  { key: 'commits', label: '提交' },
  { key: 'sessions', label: '会话' },
]
const atOpen = ref(false)
const atTab = ref<AtTab>('files')
const atQuery = ref('')
const atCandidates = ref<AtItem[]>([])
const atIndex = ref(0)
let atData: { files: string[]; commits: CommitInfo[]; sessions: SessionMeta[] } | null = null

/** 输入时检测光标前的 `@`：@ 后跟合法查询字符即打开候选面板。 */
function onInput() {
  autoGrow()
  const el = textarea.value
  const caret = el?.selectionStart ?? text.value.length
  const before = text.value.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at >= 0) {
    const query = before.slice(at + 1)
    if (query.length <= 24 && !/\s/.test(query)) {
      atQuery.value = query
      atOpen.value = true
      void loadAtCandidates()
      return
    }
  }
  if (atOpen.value) atOpen.value = false
}

async function loadAtCandidates() {
  if (!atData) {
    const sessions = sessionsStore.metas.slice(0, 30)
    atData = { files: [], commits: [], sessions }
    try {
      const [st, log] = await Promise.all([
        gitStatus().catch(() => null),
        gitLog({ limit: 15 }).catch(() => [] as CommitInfo[]),
      ])
      if (st) {
        const seen = new Set<string>()
        atData.files = [...st.staged, ...st.unstaged, ...st.untracked]
          .map(f => f.path)
          .filter((p): p is string => Boolean(p) && !seen.has(p) && Boolean(seen.add(p)))
      }
      if (Array.isArray(log)) atData.commits = log
    } catch { /* 数据源不可用时仅展示会话 */ }
  }
  const q = atQuery.value.toLowerCase()
  const all: AtItem[] = []
  if (atTab.value === 'files') {
    for (const p of atData.files) {
      if (!q || p.toLowerCase().includes(q)) all.push({ kind: 'file', icon: 'fileRead', label: p, sub: '改动文件', insert: `@${p}` })
    }
  } else if (atTab.value === 'commits') {
    for (const c of atData.commits) {
      const label = `${c.short} ${c.subject}`
      if (!q || label.toLowerCase().includes(q)) all.push({ kind: 'commit', icon: 'link', label, sub: '提交', insert: `@${c.short}` })
    }
  } else {
    for (const s of atData.sessions) {
      const label = s.title || s.preview?.slice(0, 24) || '未命名会话'
      if (!q || label.toLowerCase().includes(q)) all.push({ kind: 'session', icon: 'chat', label, sub: '会话', insert: `@${label}` })
    }
  }
  atCandidates.value = all.slice(0, 30)
  atIndex.value = 0
}

function switchAtTab(tab: AtTab) {
  atTab.value = tab
  atIndex.value = 0
  void loadAtCandidates()
}

/** 选中候选：用引用文本替换光标前的 `@查询`，并保留光标后内容。 */
function pickAt(item: AtItem) {
  const el = textarea.value
  const caret = el?.selectionStart ?? text.value.length
  const before = text.value.slice(0, caret)
  const at = before.lastIndexOf('@')
  const after = text.value.slice(caret)
  const head = at >= 0 ? before.slice(0, at) : before
  text.value = `${head}${item.insert} ${after}`.trimStart()
  atOpen.value = false
  void nextTick(() => { autoGrow(); textarea.value?.focus() })
}

function toggleQuick() { quickOpen.value = !quickOpen.value }
function toggleLifeStats() { lifeStatsOpen.value = !lifeStatsOpen.value }

function importFiles() { quickOpen.value = false; window.CoomiAndroid?.importFiles?.() }
function authorizeFolder() { quickOpen.value = false; window.CoomiAndroid?.authorizeFolder?.() }
function onTransferProgress(event: Event) {
  const detail = (event as CustomEvent<{ message?: string; progress?: number }>).detail ?? {}
  transferText.value = detail.message ?? '正在传输文件'
  transferProgress.value = detail.progress ?? 0
}
function onFilesImported(event: Event) {
  const detail = (event as CustomEvent<{ paths?: string[]; requestId?: string }>).detail ?? {}
  const paths = detail.paths ?? []
  transferText.value = paths.length ? `已导入 ${paths.length} 个文件` : '文件导入完成'
  transferProgress.value = 100
  if (detail.requestId) session.completeFileTransfer(detail.requestId, paths)
  else if (paths.length) void insert(`请读取这些已导入文件：\n${paths.join('\n')}`)
  setTimeout(() => { transferText.value = ''; transferProgress.value = 0 }, 2600)
}
function onFileExported(event: Event) {
  const detail = (event as CustomEvent<{ requestId?: string; path?: string }>).detail ?? {}
  if (detail.requestId) session.completeFileTransfer(detail.requestId, detail.path ? [detail.path] : [])
}
function onPrefillDraft(event: Event) {
  const detail = (event as CustomEvent<{ sessionId?: string; text?: string }>).detail ?? {}
  if ((detail.sessionId && detail.sessionId !== session.sessionId) || typeof detail.text !== 'string') return
  text.value = detail.text
  void nextTick(autoGrow)
}

/** 引用追问（MessageBubble「追问」按钮）：把引用块追加到输入框最前，已有输入保留在其后。 */
function onQuoteMessage(event: Event) {
  const detail = (event as CustomEvent<{ sessionId?: string; text?: string }>).detail ?? {}
  if ((detail.sessionId && detail.sessionId !== session.sessionId) || typeof detail.text !== 'string') return
  const base = text.value.trimEnd()
  text.value = base ? `${detail.text}${base}` : detail.text
  quickOpen.value = false
  void nextTick(() => { autoGrow(); textarea.value?.focus() })
}
onMounted(() => {
  window.addEventListener('coomi:file-transfer-progress', onTransferProgress)
  window.addEventListener('coomi:files-imported', onFilesImported)
  window.addEventListener('coomi:file-exported', onFileExported)
  window.addEventListener('coomi:prefill-draft', onPrefillDraft)
  window.addEventListener('coomi:quote-message', onQuoteMessage)
  window.addEventListener('resize', autoGrow)
  loadDraft()
})
onBeforeUnmount(() => {
  window.removeEventListener('coomi:file-transfer-progress', onTransferProgress)
  window.removeEventListener('coomi:files-imported', onFilesImported)
  window.removeEventListener('coomi:file-exported', onFileExported)
  window.removeEventListener('coomi:prefill-draft', onPrefillDraft)
  window.removeEventListener('coomi:quote-message', onQuoteMessage)
  window.removeEventListener('resize', autoGrow)
  saveDraft()
})

// ── 草稿按会话持久化：每个会话（含新对话）各自保留输入框内容 ──
const DRAFT_PREFIX = 'coomi.draft.'
let draftTimer: ReturnType<typeof setTimeout> | null = null

function draftKey(id: string) { return DRAFT_PREFIX + id }

function loadDraft() {
  let saved = ''
  try { saved = localStorage.getItem(draftKey(session.sessionId)) ?? '' } catch { /* ignore */ }
  text.value = saved
  void nextTick(autoGrow)
}

function saveDraft() {
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null }
  try { localStorage.setItem(draftKey(session.sessionId), text.value) } catch { /* ignore */ }
}

// 切会话（含新建会话）时：先把旧会话的草稿存回【旧】key，再加载新会话草稿。
// 注意：watch 回调里 session.sessionId 已经是新值，保存必须用回调的 prev 参数，
// 否则旧内容会被写进新会话的 key，导致所有会话显示同一个草稿。
watch(() => session.sessionId, (next, prev) => {
  if (prev && prev !== next) {
    try { localStorage.setItem(draftKey(prev), text.value) } catch { /* ignore */ }
  }
  loadDraft()
})
watch(text, () => {
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(saveDraft, 200)
})
</script>

<template>
  <div class="composer">
    <div v-if="session.pendingEdit" class="edit-banner">
      <span>正在编辑上一条消息，发送将覆盖该轮执行</span>
      <button @click="session.cancelEditMessage()">取消编辑</button>
    </div>
    <div v-if="transferText" class="transfer">
      <span>{{ transferText }}</span><progress :value="transferProgress" max="100" />
    </div>
    <div v-if="session.collaboration.active" class="collaboration-status">
      <CoomiIcon name="subtask" :size="14" />
      <span>协作第 {{ session.collaboration.cycle }} 轮 · {{ session.collaboration.phase === 'reviewer' ? '审查模型' : '改码模型' }}{{ session.collaboration.status === 'running' ? '处理中' : session.collaboration.status }}</span>
    </div>
    <div v-if="quickOpen || lifeStatsOpen || atOpen" class="quick-scrim" @click="quickOpen = false; lifeStatsOpen = false; atOpen = false" />
    <div v-if="atOpen" class="at-menu">
      <div class="at-tabs">
        <button v-for="t in AT_TABS" :key="t.key" :class="{ on: atTab === t.key }" @click="switchAtTab(t.key)">{{ t.label }}</button>
      </div>
      <div class="at-list">
        <button v-for="(item, i) in atCandidates" :key="item.kind + item.label" class="at-item" :class="{ on: i === atIndex }"
          @mousedown.prevent @click="pickAt(item)" @mouseenter="atIndex = i">
          <CoomiIcon :name="item.icon" :size="14" />
          <span class="at-label">{{ item.label }}</span>
          <span class="at-sub">{{ item.sub }}</span>
        </button>
        <p v-if="!atCandidates.length" class="at-empty">没有匹配项</p>
      </div>
    </div>
    <div v-if="quickOpen" class="quick">
      <p class="qhead reasoning-head">推理强度</p>
      <div class="reasoning-options"><button v-for="item in REASONING_EFFORTS" :key="item.value" :class="{ selected: config.reasoningEffort === item.value }" @click="session.setReasoningEffort(item.value)">{{ item.label }}</button></div>
      <p class="qhead">指令</p>
      <div v-if="hasNative" class="file-actions">
        <button class="qchip file" @click="importFiles"><CoomiIcon name="fileRead" :size="15" />选择文件</button>
        <button class="qchip file" @click="authorizeFolder"><CoomiIcon name="folder" :size="15" />授权目录</button>
      </div>
      <div class="slash-list">
        <button v-for="c in SLASH_COMMANDS" :key="c.name" class="slash-item" @click="insertSlash(c)">
          <code>{{ c.name }}</code><span>{{ c.desc }}</span>
        </button>
      </div>
    </div>

    <div class="field" :class="{ busy: session.isBusy }">
      <button v-if="session.mode === 'life'" class="life-orbit" aria-label="查看数字生命统计" title="查看生命统计" @click="toggleLifeStats">
        <i class="orbit outer" /><i class="orbit inner" />
      </button>
      <div v-if="lifeStatsOpen" class="life-stats-card">
        <header><span>生命状态</span><button aria-label="关闭" @click="lifeStatsOpen = false"><CoomiIcon name="close" :size="14" /></button></header>
        <div class="life-waveform" aria-label="数字生命动态状态波形">
          <svg viewBox="0 0 320 100" preserveAspectRatio="none" aria-hidden="true">
            <path class="wave wave-upper upper-back" d="M0 50C20 47 26 28 46 29C65 30 66 45 84 39C102 33 101 15 117 12C133 9 136 38 153 39C169 40 177 29 191 34C207 40 210 48 225 48C243 48 247 30 264 32C282 34 285 45 301 43C310 42 316 48 320 50V50H0Z" />
            <path class="wave wave-upper upper-main" d="M0 50C17 46 27 17 47 20C68 23 68 43 87 34C104 26 103 5 119 4C137 3 137 35 153 36C169 37 177 21 192 29C207 37 209 48 225 47C242 46 248 20 264 24C281 28 283 45 300 40C309 38 316 47 320 50V50H0Z" />
            <path class="wave wave-upper upper-front" d="M0 50C22 48 33 35 49 36C65 37 72 46 87 42C104 37 105 23 119 20C135 17 139 43 155 44C171 45 179 35 193 39C208 43 214 49 228 49C245 49 250 37 265 38C282 39 291 48 304 46C312 45 317 49 320 50V50H0Z" />
            <path class="wave wave-lower lower-back" d="M0 50C19 53 26 73 46 71C65 69 66 55 84 61C102 67 101 85 117 88C133 91 136 62 153 61C169 60 177 71 191 66C207 60 210 52 225 52C243 52 247 70 264 68C282 66 285 55 301 57C310 58 316 52 320 50V50H0Z" />
            <path class="wave wave-lower lower-main" d="M0 50C17 54 27 83 47 80C68 77 68 57 87 66C104 74 103 95 119 96C137 97 137 65 153 64C169 63 177 79 192 71C207 63 209 52 225 53C242 54 248 80 264 76C281 72 283 55 300 60C309 62 316 53 320 50V50H0Z" />
            <path class="wave wave-lower lower-front" d="M0 50C22 52 33 65 49 64C65 63 72 54 87 58C104 63 105 77 119 80C135 83 139 57 155 56C171 55 179 65 193 61C208 57 214 51 228 51C245 51 250 63 265 62C282 61 291 52 304 54C312 55 317 51 320 50V50H0Z" />
            <path class="wave-baseline" d="M0 50H320" />
          </svg>
        </div>
        <div class="life-stats-grid"><span>当前模式<strong>数字生命</strong></span><span>推理档位<strong>{{ REASONING_EFFORTS.find(i => i.value === config.reasoningEffort)?.label }}</strong></span><span>会话状态<strong>{{ session.isBusy ? '运行中' : '待命' }}</strong></span><span>动态流<strong>已连接</strong></span></div>
      </div>
      <div class="input-clip">
        <textarea
          ref="textarea"
          v-model="text"
          class="input"
          :class="{ scrollable: textareaScrollable }"
          rows="1"
          :placeholder="session.isBusy ? '插队补充指令…' : '输入问题或任务…'"
          @input="onInput"
          @keydown="onKeydown"
        />
      </div>

      <div class="bar">
        <button class="pill" :class="{ on: config.planMode }" @click="session.togglePlanMode()">
          <CoomiIcon name="target" :size="14" />
          <span>计划</span>
        </button>
        <button class="pill" :class="{ on: session.mode === 'team' }" title="切换协同审查协作模式" @click="cycleSessionMode">
          <CoomiIcon name="subtask" :size="14" />
          <span>{{ session.mode === 'team' ? '协作' : '单模型' }}</span>
        </button>
        <button class="pill" :class="{ on: config.permissionMode === 'auto', 'warn-on': config.permissionMode === 'full' }" @click="cycleMode">
          <CoomiIcon name="shield" :size="14" />
          <span>{{ modeLabel }}</span>
        </button>

        <span class="spacer" />

        <button class="act" aria-label="快捷指令" @click="toggleQuick">
          <CoomiIcon name="plusCircle" :size="21" />
        </button>

        <button
          class="send"
          :class="{ jump: isJumpIn, stop: showStop }"
          :disabled="!canSend && !session.isBusy"
          :aria-label="showStop ? '停止' : isJumpIn ? '插队' : '发送'"
          @click="tapPrimary"
        >
          <CoomiIcon v-if="showStop" name="stop" :size="17" />
          <CoomiIcon v-else-if="isJumpIn" name="subtask" :size="18" />
          <CoomiIcon v-else name="arrowUp" :size="18" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer { position: relative; flex-shrink: 0; padding: 6px 12px calc(var(--safe-bottom) + 10px); background: var(--bg); }
.edit-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: 0 2px 8px; padding: 8px 14px;
  border: 1px solid color-mix(in srgb, var(--blue) 38%, var(--border));
  border-radius: 13px;
  background: var(--blue-soft); color: var(--blue);
  font-size: 12.5px;
}
.edit-banner button { border: 0; background: none; color: var(--blue); font-weight: 680; }
.transfer { display: flex; align-items: center; gap: 8px; margin: 0 2px 8px; font-size: 11.5px; color: var(--text-2); }
.transfer span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transfer progress { width: 76px; height: 4px; accent-color: var(--blue); }
.collaboration-status {
  display:flex; align-items:center; gap:6px; margin:0 2px 8px; padding:7px 12px;
  border:1px solid color-mix(in srgb, var(--blue) 35%, var(--border)); border-radius:13px;
  background:var(--blue-soft); color:var(--blue); font-size:11.5px;
}

.field {
  position: relative;
  padding: 6px 8px 7px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 24px;
  background: var(--bg);
  box-shadow: 0 1px 2px rgba(23, 32, 54, 0.03), 0 4px 16px rgba(23, 32, 54, 0.05);
  transition: border-color .18s, box-shadow .28s ease, background .18s ease;
}
.life-orbit {
  position: absolute; z-index: 2; top: -13px; left: 50%;
  width: 27px; height: 27px; margin-left: -13.5px;
  border-radius: 50%; background: var(--bg);
  box-shadow: 0 0 0 3px var(--bg), 0 0 13px color-mix(in srgb, var(--blue) 38%, transparent);
  border: 0; padding: 0; cursor: pointer;
}
.orbit { position: absolute; inset: 3px; border-radius: 50%; }
.orbit.outer {
  border: 2px solid transparent; border-top-color: var(--blue); border-right-color: var(--blue);
  filter: drop-shadow(0 0 3px color-mix(in srgb, var(--blue) 70%, transparent));
  animation: life-spin 1.8s linear infinite;
}
.orbit.inner {
  inset: 7px; border: 2px solid transparent; border-bottom-color: var(--orange); border-left-color: var(--orange);
  filter: drop-shadow(0 0 2px color-mix(in srgb, var(--orange) 65%, transparent));
  animation: life-spin-reverse 1.15s linear infinite;
}
@keyframes life-spin { to { transform: rotate(360deg); } }
@keyframes life-spin-reverse { to { transform: rotate(-360deg); } }
@media (prefers-reduced-motion: reduce) {
  .orbit.outer, .orbit.inner { animation-duration: 6s; }
}
.field:focus-within {
  border-color: color-mix(in srgb, var(--blue) 62%, var(--border));
  background: var(--bg);
  box-shadow: 0 0 0 3.5px color-mix(in srgb, var(--blue) 13%, transparent),
    0 6px 24px color-mix(in srgb, var(--blue) 9%, transparent);
}
.field.busy { border-color: var(--border-strong); }

.input-clip { overflow: hidden; border-radius: 17px 17px 8px 8px; }
.input {
  display: block; width: 100%; max-height: 132px; overflow-y: hidden;
  padding: 9px 10px 5px 6px; border: 0; background: none; outline: none; resize: none;
  font: inherit; font-size: 16px; line-height: 1.5; color: var(--text);
  scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent;
}
.input.scrollable { overflow-y: auto; }
:global(html[data-coomi-floating='true'] .composer .input) { max-height: min(132px, 20vh); }
.input::placeholder { color: var(--text-3); }
.input:not(.scrollable)::-webkit-scrollbar { display: none; width: 0; }
.input.scrollable::-webkit-scrollbar { width: 3px; }
.input.scrollable::-webkit-scrollbar-track { margin-block: 12px 7px; background: transparent; }
.input.scrollable::-webkit-scrollbar-thumb { border-radius: 3px; background: var(--border-strong); }

.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 3px 0 0 2px; }
.spacer { flex: 1; }

.act {
  display: grid; place-items: center; flex-shrink: 0; width: 36px; height: 36px;
  border: 0; border-radius: 50%; background: none; color: var(--text-2);
  transition: background .15s, transform .07s;
}
.act:active { background: var(--fill-press); transform: scale(.93); }

.send {
  display: grid; place-items: center; flex-shrink: 0;
  width: 38px; height: 38px;
  border: 0; border-radius: 50%;
  background: linear-gradient(135deg, var(--blue), color-mix(in srgb, var(--blue) 82%, var(--blue-press)));
  color: #fff;
  box-shadow: 0 3px 10px color-mix(in srgb, var(--blue) 32%, transparent);
  transition: background .16s, transform .06s, box-shadow .16s, opacity .16s;
}
.send.jump { background: linear-gradient(135deg, var(--orange), color-mix(in srgb, var(--orange) 80%, #a04a2e)); }
.send.stop { background: var(--text); box-shadow: none; }
.send:disabled { background: var(--fill-strong); color: var(--text-3); box-shadow: none; pointer-events: none; }
.send:active { transform: scale(.9); }

/* 指令面板浮层：可滚动卡片 */
.quick-scrim { position: fixed; inset: 0; z-index: 1; }

/* @ 快捷上下文候选面板 */
.at-menu {
  position: absolute; z-index: 2; left: 10px; right: 10px; bottom: calc(100% + 4px);
  max-height: min(46vh, 320px); overflow-y: auto;
  padding: 8px 10px 10px;
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
  animation: coomi-cascade .18s ease both;
}
.at-tabs { display: flex; gap: 6px; margin-bottom: 6px; }
.at-tabs button {
  height: 28px; padding: 0 12px; border-radius: 999px;
  background: var(--fill); color: var(--text-2); font-size: 12.5px;
}
.at-tabs button.on { background: var(--blue-soft); color: var(--blue); font-weight: 650; }
.at-list { display: flex; flex-direction: column; gap: 1px; }
.at-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 7px 8px; border: 0; border-radius: 9px;
  background: none; text-align: left; color: var(--text-2);
}
.at-item.on { background: var(--blue-soft); color: var(--blue); }
.at-item .at-label {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-mono); font-size: 12.5px; color: inherit;
}
.at-item .at-sub { flex-shrink: 0; font-size: 11px; color: var(--text-3); }
.at-empty { padding: 10px 8px; font-size: 12.5px; color: var(--text-3); text-align: center; }

.quick {
  position: absolute; z-index: 2; left: 10px; right: 10px; bottom: calc(100% + 4px);
  /* 批次五 #18：放宽到 70vh，推理强度 + 全部斜杠命令默认一屏可见，不再藏在滚动下面 */
  max-height: min(70vh, 480px); overflow-y: auto;
  padding: 10px 12px 12px;
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
  animation: coomi-cascade .18s ease both;
}
.reasoning-head { margin-top: 3px; }
.reasoning-options { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:4px; margin-bottom:8px; }
.reasoning-options button { position:relative; min-width:0; height:32px; overflow:visible; isolation:isolate; border-radius:6px; background:var(--fill); color:var(--text-2); font-size:12px; }
.reasoning-options button::after { content:''; position:absolute; z-index:-1; inset:-3px; border-radius:9px; opacity:0; background:radial-gradient(circle, color-mix(in srgb,var(--blue) 34%,transparent), transparent 68%); pointer-events:none; }
.reasoning-options button.selected { background:var(--blue-soft); color:var(--blue); font-weight:650; }
.reasoning-options button.selected::after { opacity:1; animation:reasoning-ripple 1.8s ease-out infinite; }
.reasoning-options button:nth-child(2).selected::after { inset:-5px; }
.reasoning-options button:nth-child(3).selected::after { inset:-8px; }
.reasoning-options button:nth-child(4).selected::after, .reasoning-options button:nth-child(5).selected::after { inset:-11px; }
.life-stats-card { position:absolute; z-index:4; left:12px; right:12px; bottom:calc(100% + 10px); overflow:hidden; padding:11px 12px 12px; border:1px solid color-mix(in srgb,var(--blue) 35%,var(--border)); border-radius:13px; background:color-mix(in srgb,var(--bg) 94%,var(--blue-soft)); box-shadow:0 8px 28px color-mix(in srgb,var(--blue) 20%,transparent); animation:life-card-in .2s ease both; }
.life-stats-card header { display:flex; align-items:center; justify-content:space-between; color:var(--text); font-size:12px; font-weight:650; }
.life-stats-card header button { display:grid; place-items:center; width:24px; height:24px; border-radius:50%; background:var(--fill); color:var(--text-2); }
.life-waveform { position:relative; height:64px; margin:9px 1px 10px; overflow:hidden; border-radius:7px; background:linear-gradient(to bottom, color-mix(in srgb,var(--blue-soft) 28%,transparent), transparent 50%, color-mix(in srgb,var(--blue-soft) 20%,transparent)); }
.life-waveform svg { display:block; width:100%; height:100%; overflow:visible; }
.wave { transform-origin:160px 50px; vector-effect:non-scaling-stroke; animation:life-wave-breathe 3.4s ease-in-out infinite alternate; }
.wave-upper { fill:color-mix(in srgb,var(--orange) 48%,var(--bg)); stroke:color-mix(in srgb,var(--orange) 72%,var(--bg)); stroke-width:1.2; }
.wave-lower { fill:color-mix(in srgb,var(--blue) 52%,var(--bg)); stroke:color-mix(in srgb,var(--blue) 76%,var(--bg)); stroke-width:1.2; }
.upper-back,.lower-back { opacity:.55; animation-duration:4.5s; animation-delay:-1.1s; }
.upper-front,.lower-front { opacity:.7; animation-duration:2.8s; animation-delay:-.55s; }
.wave-baseline { fill:none; stroke:var(--border-strong); stroke-width:1.4; vector-effect:non-scaling-stroke; opacity:.9; }
.life-stats-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:7px 12px; }.life-stats-grid span { display:flex; justify-content:space-between; gap:8px; color:var(--text-3); font-size:11px; }.life-stats-grid strong { color:var(--text-2); font-weight:600; }
@keyframes life-card-in { from { opacity:0; transform:translateY(5px) scale(.98); } to { opacity:1; transform:none; } }
@keyframes reasoning-ripple { 0%,100% { transform:scale(.92); opacity:.35; } 50% { transform:scale(1.12); opacity:.9; } }
@keyframes life-wave-breathe { 0% { transform:translateX(-1.5px) scaleY(.9); opacity:.72; } 50% { transform:translateX(0) scaleY(1.04); opacity:1; } 100% { transform:translateX(1.5px) scaleY(.94); opacity:.8; } }
@media (prefers-reduced-motion: reduce) { .wave { animation-duration:8s; } }
.qhead { margin-bottom: 8px; font-size: 12px; font-weight: 600; color: var(--text-3); }
.file-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 8px; }
.qchip.file { display: inline-flex; align-items: center; gap: 5px; color: var(--blue); }
.qchip {
  height: 32px; padding: 0 13px;
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--bg); font-size: 13.5px; color: var(--text-2);
}
.qchip:active { background: var(--blue-soft); border-color: var(--blue-border); color: var(--blue); }

/* 斜杠指令逐行列表 */
.slash-list { display: flex; flex-direction: column; gap: 2px; }
.slash-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 10px 8px; border: 0; border-radius: 10px;
  background: none; text-align: left; cursor: pointer;
}
.slash-item code { font-family: inherit; font-size: 13.5px; font-weight: 700; color: var(--blue); }
.slash-item span { font-size: 12.5px; color: var(--text-2); }
.slash-item:active { background: var(--blue-soft); }
</style>
