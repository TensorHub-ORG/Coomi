<script setup lang="ts">
/**
 * 输入区。
 * DeepSeek 的输入框是「一整块大圆角卡片」：文本在上，模式开关和发送在下一行。
 * 这里的两个 chip 都对应真实协议能力（enter/exit_plan_mode、set_permission_mode），
 * ⊕ 同时提供快捷指令和 Android SAF 文件导入。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PERMISSION_MODES, useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import CoomiIcon from './CoomiIcon.vue'

const session = useSessionStore()
const config = useConfigStore()

const QUICKS = [
  { label: '继续', text: '继续' },
  { label: '跑测试', text: '跑一下测试，把失败的用例列出来' },
  { label: '解释代码', text: '解释一下这段代码的作用：\n' },
  { label: '看报错', text: '这个报错是什么原因，怎么修：\n' },
  { label: '写提交信息', text: '根据当前改动写一条 commit message' },
]

const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const quickOpen = ref(false)
const transferText = ref('')
const transferProgress = ref(0)
const textareaScrollable = ref(false)
const hasNative = typeof window !== 'undefined' && !!window.CoomiAndroid

const canSend = computed(() => text.value.trim().length > 0)
const isJumpIn = computed(() => session.isBusy && canSend.value)
const showStop = computed(() => session.isBusy && !canSend.value)
const modeLabel = computed(() => PERMISSION_MODES.find(m => m.mode === config.permissionMode)?.label ?? '')

function autoGrow() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  const scrollHeight = el.scrollHeight
  textareaScrollable.value = scrollHeight > 132
  el.style.height = Math.min(scrollHeight, 132) + 'px'
}

async function submit() {
  if (!canSend.value) return
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
  // Enter 默认换行（需求：换行键就换行）；Ctrl/Cmd+Enter 仍可快捷发送。
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
}

function cycleMode() { session.setPermissionMode(config.cyclePermissionMode()) }

async function insert(t: string) {
  text.value = text.value.trim() ? text.value.replace(/\s+$/, '') + '\n' + t : t
  quickOpen.value = false
  await nextTick()
  autoGrow()
  textarea.value?.focus()
}

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
onMounted(() => {
  window.addEventListener('coomi:file-transfer-progress', onTransferProgress)
  window.addEventListener('coomi:files-imported', onFilesImported)
  window.addEventListener('coomi:file-exported', onFileExported)
  loadDraft()
})
onBeforeUnmount(() => {
  window.removeEventListener('coomi:file-transfer-progress', onTransferProgress)
  window.removeEventListener('coomi:files-imported', onFilesImported)
  window.removeEventListener('coomi:file-exported', onFileExported)
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
    <div v-if="transferText" class="transfer">
      <span>{{ transferText }}</span><progress :value="transferProgress" max="100" />
    </div>
    <div v-if="quickOpen" class="quick-scrim" @click="quickOpen = false" />
    <div v-if="quickOpen" class="quick">
      <p class="qhead">快捷指令</p>
      <div v-if="hasNative" class="file-actions">
        <button class="qchip file" @click="importFiles"><CoomiIcon name="fileRead" :size="15" />选择文件</button>
        <button class="qchip file" @click="authorizeFolder"><CoomiIcon name="folder" :size="15" />授权目录</button>
      </div>
      <div class="qgrid">
        <button v-for="q in QUICKS" :key="q.label" class="qchip" @click="insert(q.text)">{{ q.label }}</button>
      </div>
    </div>

    <div class="field" :class="{ busy: session.isBusy }">
      <div class="input-clip">
        <textarea
          ref="textarea"
          v-model="text"
          class="input"
          :class="{ scrollable: textareaScrollable }"
          rows="1"
          :placeholder="session.isBusy ? '插队补充指令…' : '给 Coomi 下达任务…'"
          @input="autoGrow"
          @keydown="onKeydown"
        />
      </div>

      <div class="bar">
        <button class="pill" :class="{ on: config.planMode }" @click="session.togglePlanMode()">
          <CoomiIcon name="target" :size="14" />
          <span>计划</span>
        </button>
        <button class="pill" :class="{ on: config.permissionMode === 'auto', 'warn-on': config.permissionMode === 'full' }" @click="cycleMode">
          <CoomiIcon name="shield" :size="14" />
          <span>{{ modeLabel }}</span>
        </button>

        <span class="spacer" />

        <button class="act" aria-label="快捷指令" @click="quickOpen = !quickOpen">
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
.composer { position: relative; padding: 6px 10px calc(var(--safe-bottom) + 8px); background: var(--bg); }
.transfer { display: flex; align-items: center; gap: 8px; margin: 0 2px 6px; font-size: 11.5px; color: var(--text-2); }
.transfer span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transfer progress { width: 76px; height: 4px; accent-color: var(--blue); }

.field {
  padding: 4px 6px 6px 8px;
  border: 1px solid var(--border);
  border-radius: 26px;
  background: var(--fill);
  transition: border-color .16s;
}
.field:focus-within { border-color: var(--blue-border); background: var(--bg); }
.field.busy { border-color: var(--border-strong); }

.input-clip { overflow: hidden; border-radius: 18px 18px 8px 8px; }
.input {
  display: block; width: 100%; max-height: 132px; overflow-y: hidden;
  padding: 9px 10px 5px 6px; border: 0; background: none; outline: none; resize: none;
  font: inherit; font-size: 15.5px; line-height: 1.5; color: var(--text);
  scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent;
}
.input.scrollable { overflow-y: auto; }
.input::placeholder { color: var(--text-3); }
.input:not(.scrollable)::-webkit-scrollbar { display: none; width: 0; }
.input.scrollable::-webkit-scrollbar { width: 3px; }
.input.scrollable::-webkit-scrollbar-track { margin-block: 12px 7px; background: transparent; }
.input.scrollable::-webkit-scrollbar-thumb { border-radius: 3px; background: var(--border-strong); }

.bar { display: flex; align-items: center; gap: 6px; padding: 2px 0 0 2px; }
.spacer { flex: 1; }

.act {
  display: grid; place-items: center; width: 34px; height: 34px;
  border: 0; border-radius: 50%; background: none; color: var(--text-2);
}
.act:active { background: var(--fill-press); }

.send {
  display: grid; place-items: center; flex-shrink: 0;
  width: 36px; height: 36px;
  border: 0; border-radius: 50%;
  background: var(--blue); color: #fff;
  transition: background .16s, transform .06s;
}
.send.jump { background: var(--orange); }
.send.stop { background: var(--text); }
.send:disabled { background: var(--border-strong); pointer-events: none; }
.send:active { transform: scale(.92); }

/* 快捷指令浮层 */
.quick-scrim { position: fixed; inset: 0; z-index: 1; }
.quick {
  position: absolute; z-index: 2; left: 10px; right: 10px; bottom: calc(100% - 6px);
  padding: 10px 12px 12px;
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
  animation: coomi-cascade .18s ease both;
}
.qhead { margin-bottom: 8px; font-size: 12px; font-weight: 600; color: var(--text-3); }
.qgrid { display: flex; flex-wrap: wrap; gap: 7px; }
.file-actions { display: flex; gap: 7px; margin-bottom: 8px; }
.qchip.file { display: inline-flex; align-items: center; gap: 5px; color: var(--blue); }
.qchip {
  height: 32px; padding: 0 13px;
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--bg); font-size: 13.5px; color: var(--text-2);
}
.qchip:active { background: var(--blue-soft); border-color: var(--blue-border); color: var(--blue); }
</style>
