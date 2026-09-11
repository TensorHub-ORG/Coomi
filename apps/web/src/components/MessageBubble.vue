<script setup lang="ts">
/**
 * 消息气泡。
 *
 * 助手消息按段落切块渲染 —— 这是「瀑布流」的关键：
 * 已经写完的段落是稳定 DOM，只有最后一块随 token 重绘，
 * 新段落出现时自己做一次 8px 上浮。整条消息整体重排会闪，切块之后不会。
 * marked 的调用同时被 60ms 节流，流式期间不会一秒解析几十次 markdown。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { AssistantMessage, UserMessage } from '@/stores/viewModel'
import { useSessionStore } from '@/stores/session'
import { renderMarkdown } from '@/utils/markdown'
import { speak } from '@/bridge/tts'
import { apiSend } from '@/bridge/http'
import CoomiIcon from './CoomiIcon.vue'
import FileInline from './FileInline.vue'

const props = defineProps<{ msg: AssistantMessage | UserMessage }>()
const session = useSessionStore()

const RATE = 60
const blocks = ref<string[]>([])
const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null
let last = 0

const isUser = computed(() => props.msg.kind === 'user')
const isAssistant = computed(() => props.msg.kind === 'assistant')
/** 生命体主动消息（气泡/开场问候）：带生命体标记的渲染样式。 */
const isLife = computed(() => isAssistant.value && (props.msg as AssistantMessage).life === true)
/** 生命体主动消息的投递触发类型（life_delivered 事件回填）。 */
const lifeTrigger = computed(() => (props.msg as AssistantMessage).lifeTrigger)
const isMorning = computed(() => lifeTrigger.value === 'morning')
const isEgg = computed(() => lifeTrigger.value === 'egg')
/** 早安播报 / 每日彩蛋：带小标题的卡片形态（其余 life 消息保持现状）。 */
const isLifeCard = computed(() => isLife.value && (isMorning.value || isEgg.value))
/** 只有最新一条用户消息可编辑重发。 */
const isLastUser = computed(() => isUser.value && session.lastUserMessage === props.msg)
/** 只有最新一条助手消息可回撤。 */
const isLastAssistant = computed(() => isAssistant.value && session.lastAssistantMessage === props.msg)
const streaming = computed(() => props.msg.kind === 'assistant' && props.msg.streaming)
const src = computed(() => props.msg.content)

/** 编辑：把该消息文本回填到输入框，发送时覆盖该轮重新执行。 */
function editUserMessage() {
  const mid = (props.msg as { mid?: string }).mid ?? ''
  session.startEditMessage(mid, props.msg.content)
}

/** 回撤：先弹确认，清空该轮执行（含工具过程），回到这轮开始之前。 */
function undoAssistant() {
  const mid = (props.msg as { mid?: string }).mid ?? ''
  session.requestUndo(mid)
}

/**
 * 从助手文本中识别本地文件路径（供 FileInline 渲染为可点击文件卡片）。
 * 兼容绝对路径、相对路径、./ 与 ../ 前缀；相对路径用会话 cwd 拼成绝对路径
 * （引擎 fs 接口只接受绝对路径，此前 ./build/x.apk 会被截断成 /build/x.apk 导致「文件不存在」）。
 */
const filePaths = computed(() => {
  if (props.msg.kind !== 'assistant' || props.msg.streaming) return []
  const seen = new Set<string>()
  const out: string[] = []
  const cwd = session.cwd || ''
  // 匹配路径 token：可带 ./ ../ 前缀或多个目录段，以 文件名.扩展名 结尾。
  const re = /(?:\.{1,2}\/)*(?:[\w.+\-]+\/)+[\w.+\-]+\.[A-Za-z0-9]{1,8}(?=\s|$|[,，。;；)】」"'<>])/g
  for (const m of src.value.matchAll(re)) {
    let p = m[0].trim()
    if (p.length < 8) continue
    if (p.includes('://')) continue
    if (p.startsWith('~/')) continue // 引擎 home 目录未知，跳过避免误导
    // 相对路径拼 cwd；无 cwd 时相对路径无法解析，跳过。
    const full = p.startsWith('/') ? p : (cwd ? cwd + '/' + p : '')
    if (!full.startsWith('/')) continue
    // 规范化：去掉 /./，解析 /../ 与多余斜杠。
    const parts: string[] = []
    for (const seg of full.split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    const norm = '/' + parts.join('/')
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
    if (out.length >= 8) break
  }
  return out
})

/** 按空行切块，但围栏代码块整体保留。 */
function splitBlocks(text: string): string[] {
  const out: string[] = []
  let buf: string[] = []
  let fence: string | null = null
  const flush = () => {
    const t = buf.join('\n').trim()
    if (t) out.push(t)
    buf = []
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      buf.push(line)
      if (m && line.trim().startsWith(fence)) { fence = null; flush() }
      continue
    }
    if (m) { flush(); fence = m[1]; buf.push(line); continue }
    if (line.trim() === '') { flush(); continue }
    buf.push(line)
  }
  flush()
  return out
}

function rebuild() {
  blocks.value = splitBlocks(src.value).map(renderMarkdown)
}

/** 批次五 #6：代码块「复制」按钮的事件委托（v-html 内容不带 Vue 绑定）。 */
async function onBlockClick(event: Event) {
  const target = event.target as HTMLElement
  const button = target.closest('button[data-copy-code]')
  if (!button) return
  const pre = button.closest('.code-wrap')?.querySelector('pre')
  if (!pre) return
  const text = pre.textContent ?? ''
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* 放弃 */ }
    document.body.removeChild(ta)
  }
  button.textContent = '已复制'
  setTimeout(() => { button.textContent = '复制' }, 1400)
}

function schedule() {
  if (props.msg.kind !== 'assistant') return
  if (!props.msg.streaming) {
    if (timer) { clearTimeout(timer); timer = null }
    last = Date.now()
    rebuild()
    return
  }
  if (timer) return
  const wait = Math.max(0, RATE - (Date.now() - last))
  timer = setTimeout(() => { timer = null; last = Date.now(); rebuild() }, wait)
}

watch(src, schedule, { immediate: true })
watch(streaming, schedule)
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

async function copyAll() {
  try { await navigator.clipboard.writeText(props.msg.content) } catch { /* 剪贴板不可用就算了 */ }
  copied.value = true
  setTimeout(() => { copied.value = false }, 1400)
}

/** 简单去掉 markdown 符号，得到适合朗读的纯文本。 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')              // 代码块整体略过
    .replace(/`([^`]*)`/g, '$1')                  // 行内代码取文字
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')     // 图片取 alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')      // 链接取文案
    .replace(/^#{1,6}\s+/gm, '')                  // 标题符号
    .replace(/[*_~>|]/g, '')                      // 强调/引用/表格符号
    .replace(/\s+/g, ' ')
    .trim()
}

/** F8 语音陪伴：朗读整条消息（流式中不提供，内容还没定稿）。 */
function readAloud() {
  speak(stripMarkdown(props.msg.content))
}

const saving = ref(false)
const savedText = ref('')

/** 收藏进记忆：把整条消息写入 memory.jsonl（供「最近记忆」展示）。 */
async function saveToMemory() {
  if (saving.value) return
  saving.value = true
  savedText.value = ''
  try {
    await apiSend<{ ok: boolean }>('/api/life/memory', 'POST', { text: props.msg.content })
    session.pushNotice('success', '已收藏进记忆')
    savedText.value = '已收藏'
    setTimeout(() => { savedText.value = '' }, 1400)
  } catch (reason) {
    session.pushNotice('error', `收藏失败：${reason instanceof Error ? reason.message : String(reason)}`)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="isUser" class="row user">
    <div class="wrap user-wrap">
      <div class="bubble cascade">{{ msg.content }}</div>
      <div class="acts user-acts">
        <button class="act" @click="copyAll">
          <CoomiIcon :name="copied ? 'check' : 'copy'" :size="15" />
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
        <button v-if="isLastUser" class="act" @click="editUserMessage">
          <CoomiIcon name="pencil" :size="15" />
          <span>编辑</span>
        </button>
      </div>
    </div>
  </div>

  <div v-else class="assistant" :class="{ life: isLife }">
    <!-- 早安播报 / 每日彩蛋：顶部小标题 + 正文的卡片形态，右上角朗读。 -->
    <div v-if="isLifeCard" class="life-card" :class="lifeTrigger">
      <div class="life-card-head">
        <span class="life-card-title">
          <CoomiIcon :name="isMorning ? 'sun' : 'sparkle'" :size="14" />
          <span>{{ isMorning ? '早安播报' : '每日彩蛋' }}</span>
        </span>
        <button v-if="!streaming" class="act speak-act" @click="readAloud">
          <CoomiIcon name="play" :size="13" />
          <span>朗读</span>
        </button>
      </div>
      <div v-for="(h, i) in blocks" :key="i" class="md blk card-blk cascade" v-html="h" @click="onBlockClick" />
      <FileInline v-if="filePaths.length" :paths="filePaths" />
      <span v-if="streaming" class="stream-caret" />
      <div v-if="isEgg" class="life-card-foot">
        <button class="act save-act" :disabled="saving" @click="saveToMemory">
          <CoomiIcon name="memory" :size="13" />
          <span>{{ saving ? '收藏中…' : savedText || '收藏进记忆' }}</span>
        </button>
      </div>
    </div>

    <template v-else>
      <div v-if="isLife" class="life-head">
        <div class="life-tag"><CoomiIcon name="lifeRings" :size="12" /><span>生命体</span></div>
        <button v-if="!streaming" class="act speak-act" @click="readAloud">
          <CoomiIcon name="play" :size="13" />
          <span>朗读</span>
        </button>
      </div>
      <div v-for="(h, i) in blocks" :key="i" class="md blk cascade" v-html="h" @click="onBlockClick" />
      <FileInline v-if="filePaths.length" :paths="filePaths" />
      <span v-if="streaming" class="stream-caret" />
    </template>

    <div class="acts">
      <button class="act" @click="copyAll">
        <CoomiIcon :name="copied ? 'check' : 'copy'" :size="15" />
        <span>{{ copied ? '已复制' : '复制' }}</span>
      </button>
      <!-- 回撤会清空整轮执行：只在输出完成后提供，流式中不出现。 -->
      <button v-if="isLastAssistant && !streaming" class="act" @click="undoAssistant">
        <CoomiIcon name="arrowLeft" :size="15" />
        <span>回撤</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; }
.row.user { justify-content: flex-end; }
.bubble {
  max-width: 100%;
  padding: 10px 15px;
  border-radius: 19px 19px 7px 19px;
  background: var(--blue); color: #fff;
  font-size: 15.5px; line-height: 1.55; word-break: break-word;
  white-space: pre-wrap; text-align: left;
}

.assistant { max-width: 100%; color: var(--text); }
.blk + .blk { margin-top: 10px; }

/* 批次五 #6：代码块复制按钮（v-html 内容需 :deep 穿透） */
.blk :deep(.code-wrap) { position: relative; }
.blk :deep(.code-copy) {
  position: absolute; top: 6px; right: 6px; z-index: 1;
  padding: 3px 10px; border: 0; border-radius: var(--r-sm, 6px);
  background: var(--fill-strong, rgba(127,127,127,.18));
  color: var(--text-2); font-size: 11px; font-weight: 600;
}
.blk :deep(.code-copy):active { background: var(--blue-soft); color: var(--blue); }

/* 生命体主动消息：左侧渐变边条 + 柔和底色，弱化“这是一条系统消息”的距离感。 */
.assistant.life { padding: 2px 0 4px; }
.assistant.life .life-tag {
  display: inline-flex; align-items: center; gap: 4px;
  margin: 0 0 6px; padding: 3px 9px 3px 7px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--accent-soft) 70%, var(--bg));
  color: var(--accent); font-size: 11px; font-weight: 650;
}
.assistant.life .blk {
  padding: 10px 13px;
  border-left: 3px solid color-mix(in srgb, var(--accent) 55%, var(--border));
  border-radius: 4px 13px 13px 4px;
  background: color-mix(in srgb, var(--accent-soft) 30%, var(--bg));
}
.assistant.life .blk + .blk { margin-top: 8px; }

.user-wrap { display: flex; flex-direction: column; align-items: flex-end; max-width: 84%; }
.user-acts { justify-content: flex-end; }
.acts { display: flex; gap: 4px; margin-top: 8px; }
.act {
  display: inline-flex; align-items: center; gap: 5px;
  height: 30px; padding: 0 10px;
  border: 0; border-radius: var(--r-pill); background: none;
  font-size: 12.5px; color: var(--text-3);
}
.act:active { background: var(--fill); color: var(--blue); }

/* ── 生命体消息头部：tag 居左 + 朗读居右 ── */
.life-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-bottom: 6px;
}
.life-head .life-tag { margin: 0; }

/* F8 语音陪伴：右上角小「朗读」按钮（复用 act 基础样式，仅缩小强化）。 */
.speak-act {
  height: 26px; padding: 0 8px;
  background: color-mix(in srgb, var(--accent-soft) 45%, var(--bg));
  color: var(--accent); font-size: 11.5px; font-weight: 650;
}
.speak-act:active { background: var(--accent-soft); color: var(--accent); }

/* ── 早安播报 / 每日彩蛋卡片：顶部小标题 + 渐变高亮，移动端友好 ── */
.life-card {
  overflow: hidden;
  padding: 10px 13px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--border));
  border-radius: 14px;
  background: linear-gradient(150deg, color-mix(in srgb, var(--accent-soft) 55%, var(--bg)), var(--bg) 58%);
}
.life-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: -10px -13px 2px; padding: 7px 9px 7px 12px;
  background: color-mix(in srgb, var(--accent-soft) 78%, var(--bg));
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
}
.life-card-title {
  display: inline-flex; align-items: center; gap: 5px;
  color: var(--accent); font-size: 12.5px; font-weight: 700;
}
/* 卡片内正文：去掉单条 life 消息的左边条/底色，交给卡片统一承载。 */
.assistant.life .life-card .card-blk {
  padding: 0; border-left: 0; border-radius: 0; background: transparent;
}
.life-card .card-blk + .card-blk { margin-top: 8px; }
.life-card .stream-caret { margin-top: 6px; }
.life-card-foot {
  display: flex; justify-content: flex-end; margin-top: 5px;
}
/* 每日彩蛋右下角「收藏进记忆」：accent 描边胶囊，触屏友好。 */
.save-act {
  height: 28px; padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  background: color-mix(in srgb, var(--accent-soft) 45%, var(--bg));
  color: var(--accent); font-size: 12px; font-weight: 650;
}
.save-act:active { background: var(--accent-soft); color: var(--accent); }
.save-act:disabled { opacity: .55; }
</style>

