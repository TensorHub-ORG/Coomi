<script setup lang="ts">
/**
 * Git 面板：状态栏 + 改动 / 分支 / 历史 / Stash / 远端 五个标签页。
 * 全部数据来自 /api/git/*（见 src/bridge/git.ts），diff 用 <pre> 渲染并做行级 +/- 着色。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { goBack } from '@/bridge/navigation'
import { apiGet } from '@/bridge/http'
import {
  aiCommitMessage,
  aiConflict,
  aiReadme,
  aiReview,
  aiSummarize,
  type AiText,
} from '@/bridge/ai'
import {
  gitAiAdversarialReview,
  gitAiCompare,
  gitAiConfigGet,
  gitAiConfigSave,
  gitAiConfigTest,
  gitAiFixApply,
  gitAiFixSuggest,
  gitAiRootCause,
  gitBranchCreate,
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCompare,
  gitDiff,
  gitFetch,
  gitLog,
  gitPrCreate,
  gitPrDescribe,
  gitProjectInfo,
  gitPull,
  gitPush,
  gitRemoteAdd,
  gitRemotes,
  gitSnapshotSchedule,
  gitSnapshotScheduleUpdate,
  gitStage,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStatus,
  gitUnstage,
  type GitAiConfig,
  type BranchInfo,
  type CommitInfo,
  type DiffInfo,
  type FileEntry,
  type GitStatus,
  type PrCreateResult,
  type ProjectInfo,
  type RemoteInfo,
  type ReviewIssue,
  type StashEntry,
} from '@/bridge/git'

const props = defineProps<{ embedded?: boolean }>()
const router = useRouter()
const confirmation = ref<{ message: string; resolve: (accepted: boolean) => void } | null>(null)
function requestConfirmation(message: string): Promise<boolean> {
  if (!props.embedded) return Promise.resolve(window.confirm(message))
  confirmation.value?.resolve(false)
  return new Promise(resolve => { confirmation.value = { message, resolve } })
}
function answerConfirmation(accepted: boolean) {
  confirmation.value?.resolve(accepted)
  confirmation.value = null
}
onBeforeUnmount(() => answerConfirmation(false))

// ── 状态栏数据 ──────────────────────────────────────────────
const status = ref<GitStatus | null>(null)
const project = ref<ProjectInfo | null>(null)
const gitVersion = ref('')
const loading = ref(true)
const error = ref('')
const notice = ref('')

interface RuntimeDoctor { facts?: { git?: string | null } | null }

async function loadGitVersion() {
  try {
    const doctor = await apiGet<RuntimeDoctor>('/api/runtime/doctor')
    gitVersion.value = doctor.facts?.git?.replace(/^git version\s*/, '') ?? ''
  } catch { gitVersion.value = '' }
}

async function loadAll() {
  loading.value = true
  error.value = ''
  notice.value = ''
  try {
    const [s, p] = await Promise.all([gitStatus(), gitProjectInfo()])
    status.value = s
    project.value = p
    if (s.is_repo) {
      // 打开面板即加载分支（PR 集成需要）、定时快照配置与远端列表（PR 仓库信息展示）。
      void loadBranches()
      void loadSchedule()
      void loadRemotes()
    }
    void loadAiConfig()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadStatus() {
  try { status.value = await gitStatus() } catch (e) { notice.value = `状态刷新失败：${e instanceof Error ? e.message : e}` }
}

const hasRepo = computed(() => status.value?.is_repo === true)

// ── 标签页 ─────────────────────────────────────────────────
type Tab = 'changes' | 'branches' | 'history' | 'stash' | 'remotes'
const TABS: { key: Tab; label: string }[] = [
  { key: 'changes', label: '改动' },
  { key: 'branches', label: '分支' },
  { key: 'history', label: '历史' },
  { key: 'stash', label: '贮藏' },
  { key: 'remotes', label: '远程' },
]
const activeTab = ref<Tab>('changes')

// ── 标签滑块：弹簧滑动指示条（活泼动效） ─────────────────────
const tabBar = ref<HTMLElement | null>(null)
const tabEls = new Map<Tab, HTMLElement>()
const thumbStyle = ref<Record<string, string>>({ opacity: '0' })
// 缓存上一次滑块位置：syncThumb 只在实际位移时更新，避免「更新 → 重渲染 → 函数 ref 回调 → 再更新」死循环。
let lastLeft = -1
let lastWidth = -1

function setTabEl(key: Tab, el: unknown) {
  // Vue 3 函数 ref 在每次组件重渲染后都会重新调用；这里只登记元素，不触发任何状态更新。
  if (el instanceof HTMLElement) tabEls.set(key, el)
}

function syncThumb() {
  const el = tabEls.get(activeTab.value)
  const bar = tabBar.value
  if (!el || !bar) return
  const left = el.offsetLeft
  const width = el.offsetWidth
  if (left === lastLeft && width === lastWidth) return
  lastLeft = left
  lastWidth = width
  thumbStyle.value = {
    opacity: '1',
    left: `${left}px`,
    width: `${width}px`,
  }
}

watch(activeTab, () => void nextTick(syncThumb))
onMounted(() => {
  void nextTick(syncThumb)
  window.addEventListener('resize', syncThumb)
})
onBeforeUnmount(() => window.removeEventListener('resize', syncThumb))

// ── 顶部状态白话文案 ───────────────────────────────────────
const statusSummary = computed(() => {
  const s = status.value
  if (!s) return ''
  if (!s.is_repo) return '尚未建立 Git 仓库'
  if (s.conflicted.length) return `${s.conflicted.length} 处冲突待解决`
  const total = s.staged.length + s.unstaged.length + s.untracked.length
  if (total === 0) return '工作区干净'
  return `${total} 处未提交改动`
})

const statusSub = computed(() => {
  const s = status.value
  if (!s || !s.is_repo) return ''
  const parts: string[] = []
  if (s.branch) parts.push(`当前分支：${s.branch}`)
  if (s.ahead > 0) parts.push(`领先远程 ${s.ahead}`)
  if (s.behind > 0) parts.push(`落后远程 ${s.behind}`)
  if (s.ahead === 0 && s.behind === 0) parts.push('与远程同步')
  return parts.join(' · ')
})

/** 高级功能折叠（定时快照 / PR / A/B 对比），默认收起。 */
const advancedOpen = ref(false)

/** Git 术语帮助（折叠块）。 */
const helpOpen = ref(false)
/** PR 高级设置折叠（upstream / fork owner / token）。 */
const prAdvancedOpen = ref(false)
const HELP_ROWS: { term: string; def: string }[] = [
  { term: '提交（Commit）', def: '把当前改动记录为一个版本，可随时回看与还原。' },
  { term: '暂存（Stage）', def: '勾选本次提交要包含的文件，暂存后随提交一起写入版本。' },
  { term: '分支（Branch）', def: '相互独立的工作线，切换分支即切换对应版本。' },
  { term: '远程（Remote）', def: 'GitHub / Gitee 等平台上的仓库副本，推送上传、拉取同步。' },
  { term: 'PR（Pull Request）', def: '请求原项目维护者审核并合并你的分支改动。' },
  { term: '贮藏（Stash）', def: '临时收起未提交的改动，稍后恢复继续处理。' },
  { term: '冲突（Conflict）', def: '双方修改了同一处内容，需手动决定保留哪一侧。' },
]

watch(activeTab, (tab) => {
  if (!hasRepo.value) return
  if (tab === 'changes') void loadStatus()
  else if (tab === 'branches') void loadBranches()
  else if (tab === 'history') void loadLog()
  else if (tab === 'stash') void loadStash()
  else void loadRemotes()
})

// ── diff 行级着色 ──────────────────────────────────────────
type DiffKind = 'add' | 'del' | 'hunk' | 'meta' | 'plain'
interface DiffLine { text: string; kind: DiffKind }

function splitDiffLines(raw: string): DiffLine[] {
  return raw.split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) return { text: line, kind: 'meta' as const }
    if (line.startsWith('+')) return { text: line, kind: 'add' as const }
    if (line.startsWith('-')) return { text: line, kind: 'del' as const }
    if (line.startsWith('@@')) return { text: line, kind: 'hunk' as const }
    if (/^(diff --git|index |new file|deleted file|rename |similarity |dissimilarity |Binary files)/.test(line)) {
      return { text: line, kind: 'meta' as const }
    }
    return { text: line, kind: 'plain' as const }
  })
}

// ── 改动标签页 ─────────────────────────────────────────────
type ChangeGroup = 'staged' | 'unstaged' | 'untracked' | 'conflicted'

const GROUPS: { key: ChangeGroup; title: string; sub: string }[] = [
  { key: 'staged', title: '已暂存', sub: '将包含在本次提交中' },
  { key: 'unstaged', title: '未暂存', sub: '已修改，暂存后随提交写入' },
  { key: 'untracked', title: '未跟踪', sub: '新文件，尚未纳入版本控制' },
  { key: 'conflicted', title: '冲突', sub: '合并冲突，需先解决' },
]

/** 无暂存改动时的提交提示。 */
const stagedCount = computed(() => entriesOf('staged').length)

function entriesOf(group: ChangeGroup): FileEntry[] {
  const s = status.value
  if (!s) return []
  if (group === 'staged') return s.staged
  if (group === 'unstaged') return s.unstaged
  if (group === 'untracked') return s.untracked
  return s.conflicted
}

const expandedKey = ref('')
const diffCache = ref<Record<string, DiffInfo | null>>({})
const diffLoading = ref<Record<string, boolean>>({})
const actionBusy = ref(false)

function changeKey(group: ChangeGroup, path: string): string { return `${group}\u0000${path}` }
function isExpanded(group: ChangeGroup, path: string): boolean { return expandedKey.value === changeKey(group, path) }
function diffOf(group: ChangeGroup, path: string): DiffInfo | null { return diffCache.value[changeKey(group, path)] ?? null }
function diffBusy(group: ChangeGroup, path: string): boolean { return diffLoading.value[changeKey(group, path)] ?? false }
function statLines(group: ChangeGroup, path: string): DiffLine[] { return splitDiffLines(diffOf(group, path)?.stat ?? '') }
function diffLines(group: ChangeGroup, path: string): DiffLine[] { return splitDiffLines(diffOf(group, path)?.diff ?? '') }

async function toggleChange(group: ChangeGroup, entry: FileEntry) {
  const key = changeKey(group, entry.path)
  if (expandedKey.value === key) { expandedKey.value = ''; return }
  expandedKey.value = key
  if (group === 'untracked' || diffCache.value[key] !== undefined || diffLoading.value[key]) return
  diffLoading.value[key] = true
  try {
    diffCache.value[key] = await gitDiff({ path: entry.path, cached: group === 'staged' })
  } catch (e) {
    diffCache.value[key] = null
    notice.value = `diff 加载失败：${e instanceof Error ? e.message : e}`
  } finally {
    diffLoading.value[key] = false
  }
}

async function stagePaths(paths: string[], all = false) {
  if (actionBusy.value) return
  actionBusy.value = true
  try {
    await gitStage({ paths, all })
    notice.value = all ? '已全部暂存' : `已暂存 ${paths.length} 项`
    expandedKey.value = ''
    await loadStatus()
  } catch (e) {
    notice.value = `暂存失败：${e instanceof Error ? e.message : e}`
  } finally {
    actionBusy.value = false
  }
}

async function unstagePaths(paths: string[], all = false) {
  if (actionBusy.value) return
  actionBusy.value = true
  try {
    await gitUnstage({ paths, all })
    notice.value = all ? '已全部取消暂存' : `已取消暂存 ${paths.length} 项`
    expandedKey.value = ''
    await loadStatus()
  } catch (e) {
    notice.value = `取消暂存失败：${e instanceof Error ? e.message : e}`
  } finally {
    actionBusy.value = false
  }
}

// 提交
const commitMessage = ref('')
const committing = ref(false)

async function commit() {
  const message = commitMessage.value.trim()
  if (!message) { notice.value = '请输入提交信息'; return }
  if (committing.value) return
  committing.value = true
  try {
    const result = await gitCommit(message)
    const short = result.hash ? result.hash.slice(0, 7) : ''
    notice.value = short ? `已保存 ✔（提交 ${short}）` : '已保存 ✔'
    commitMessage.value = ''
    expandedKey.value = ''
    await loadStatus()
  } catch (e) {
    notice.value = `提交失败：${e instanceof Error ? e.message : e}`
  } finally {
    committing.value = false
  }
}

// ── AI 助手 ────────────────────────────────────────────────
// 所有 AI 结果展示在 diff 区域上方的可折叠面板里；失败时提示降级文本。
type AiKind = 'summary' | 'review' | 'conflict' | 'readme' | 'commit'
const AI_KIND_LABEL: Record<AiKind, string> = {
  summary: 'AI 变更总结',
  review: 'AI Review',
  conflict: '冲突解决建议',
  readme: 'README 预览',
  commit: 'AI 提交信息',
}
const aiPanelOpen = ref(false)
const aiBusy = ref(false)
const aiKind = ref<AiKind>('summary')
const aiText = ref('')
const aiError = ref('')
// AI Review 结构化问题清单（来自 /api/git/ai/fix/suggest）；null 表示未获得结构化结果。
const aiIssues = ref<ReviewIssue[] | null>(null)
const expandedIssue = ref(-1)
const applyingIssue = ref(-1)
const applyingAll = ref(false)

// ── Git AI 独立模型配置（不依赖全局 Provider，单独一套 key/url/model）──
const aiConfigOpen = ref(false)
const aiConfig = ref<GitAiConfig>({ enabled: false, kind: 'openai_compatible', base_url: '', api_key: '', model: '' })
const aiConfigLoaded = ref(false)
const aiConfigSaving = ref(false)
const aiConfigTesting = ref(false)
const aiConfigMsg = ref('')
const aiConfigMsgErr = ref(false)

/** 协议选项：label 显示名 + kind 存储值 + 占位提示。 */
const AI_KIND_OPTIONS: { kind: string; label: string; url: string; model: string }[] = [
  { kind: 'openai_compatible', label: 'OpenAI 兼容', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { kind: 'anthropic', label: 'Anthropic', url: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  { kind: 'gemini', label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
]
const aiKindOption = computed(() => AI_KIND_OPTIONS.find(o => o.kind === aiConfig.value.kind) ?? AI_KIND_OPTIONS[0])

/** 协议切换时自动填入该协议常见 base_url 与模型名。 */
function pickAiKind(kind: string) {
  const opt = AI_KIND_OPTIONS.find(o => o.kind === kind)
  if (!opt) return
  aiConfig.value.kind = kind
  if (!aiConfig.value.base_url || aiConfig.value.base_url === aiKindOption.value?.url) {
    aiConfig.value.base_url = opt.url
  }
  if (!aiConfig.value.model) aiConfig.value.model = opt.model
}

async function loadAiConfig() {
  try {
    const saved = await gitAiConfigGet()
    aiConfig.value = saved
  } catch { /* 引擎未就绪时保持默认空配置 */ }
  aiConfigLoaded.value = true
}

async function saveAiConfig() {
  if (aiConfigSaving.value || aiConfigTesting.value) return
  const c = aiConfig.value
  if (!c.base_url.trim() || !c.api_key.trim() || !c.model.trim()) {
    aiConfigMsg.value = '请先填写完整的 Base URL、API Key 与模型名'
    aiConfigMsgErr.value = true
    return
  }
  aiConfigSaving.value = true
  aiConfigMsg.value = ''
  try {
    aiConfig.value = await gitAiConfigSave({ ...c, base_url: c.base_url.trim(), api_key: c.api_key.trim(), model: c.model.trim() })
    aiConfigMsg.value = aiConfig.value.enabled ? '已保存并启用，AI 助手将优先使用这套独立配置' : '已保存（未启用，AI 助手仍走全局模型）'
    aiConfigMsgErr.value = false
  } catch (e) {
    aiConfigMsg.value = `保存失败：${e instanceof Error ? e.message : e}`
    aiConfigMsgErr.value = true
  } finally {
    aiConfigSaving.value = false
  }
}

/** 连通性测试：用表单当前内容发一次请求（不保存），成功/失败给行内反馈。 */
async function testAiConfig() {
  if (aiConfigTesting.value || aiConfigSaving.value) return
  const c = aiConfig.value
  if (!c.base_url.trim() || !c.api_key.trim() || !c.model.trim()) {
    aiConfigMsg.value = '请先填写完整的 Base URL、API Key 与模型名，再点「测试」'
    aiConfigMsgErr.value = true
    return
  }
  aiConfigTesting.value = true
  aiConfigMsg.value = ''
  try {
    const r = await gitAiConfigTest(c)
    if (r.ok) {
      aiConfigMsg.value = '测试成功：模型已连通，配置可用'
      aiConfigMsgErr.value = false
    } else {
      aiConfigMsg.value = `测试失败：${r.error ?? '未知错误'}`
      aiConfigMsgErr.value = true
    }
  } catch (e) {
    aiConfigMsg.value = `测试失败：${e instanceof Error ? e.message : e}`
    aiConfigMsgErr.value = true
  } finally {
    aiConfigTesting.value = false
  }
}

/** 统一执行 AI 动作：切到改动标签页并展开面板，结果写入面板，失败给行内错误。 */
async function runAi(kind: AiKind, fn: () => Promise<AiText>) {
  if (aiBusy.value) return
  activeTab.value = 'changes'
  aiPanelOpen.value = true
  aiBusy.value = true
  aiKind.value = kind
  aiText.value = ''
  aiError.value = ''
  try {
    const r = await fn()
    aiText.value = r.text
  } catch (e) {
    aiError.value = `AI 生成失败：${e instanceof Error ? e.message : e}`
  } finally {
    aiBusy.value = false
  }
}

function doSummarize() {
  void runAi('summary', () => aiSummarize())
}

/** AI Review：优先请求结构化问题清单；后端不支持时回退旧版纯文本 review。 */
async function doReview(path?: string) {
  if (aiBusy.value) return
  activeTab.value = 'changes'
  aiPanelOpen.value = true
  aiBusy.value = true
  aiKind.value = 'review'
  aiText.value = ''
  aiError.value = ''
  aiIssues.value = null
  expandedIssue.value = -1
  applyingIssue.value = -1
  applyingAll.value = false
  try {
    const r = await gitAiFixSuggest(path)
    // 结构校验：issues 必须是数组才视为结构化结果，否则按旧版纯文本处理。
    aiIssues.value = Array.isArray(r.issues) ? r.issues : null
    if (aiIssues.value === null) throw new Error('suggest 未返回结构化 issues')
  } catch {
    aiIssues.value = null
    try {
      const r = await aiReview(path)
      aiText.value = r.text
    } catch (e) {
      aiError.value = `AI 生成失败：${e instanceof Error ? e.message : e}`
    }
  } finally {
    aiBusy.value = false
  }
}

function issueKey(issue: ReviewIssue, index: number): string {
  return `${issue.path}\u0000${index}`
}

/** severity 文案 → 标签配色（高=红、中=橙、低=灰，其余归为低）。 */
function sevClass(severity: string): string {
  const s = severity.trim()
  if (s === '高') return 'sev-high'
  if (s === '中') return 'sev-mid'
  return 'sev-low'
}

function toggleIssue(index: number) {
  expandedIssue.value = expandedIssue.value === index ? -1 : index
}

async function applyIssue(index: number) {
  if (applyingIssue.value !== -1 || applyingAll.value) return
  const issue = aiIssues.value?.[index]
  if (!issue) return
  if (!issue.patch) { notice.value = '该问题没有可应用的补丁'; return }
  applyingIssue.value = index
  try {
    await gitAiFixApply({ patch: issue.patch, path: issue.path })
    notice.value = '修复已应用，修复前已自动创建快照，可随时回滚'
    await loadStatus()
  } catch (e) {
    notice.value = `应用修复失败：${e instanceof Error ? e.message : e}`
  } finally {
    applyingIssue.value = -1
  }
}

async function applyAllIssues() {
  if (applyingAll.value || applyingIssue.value !== -1) return
  const issues = (aiIssues.value ?? []).filter(i => i.patch !== null)
  if (!issues.length) { notice.value = '没有可应用的修复补丁'; return }
  applyingAll.value = true
  let okCount = 0
  try {
    for (const issue of issues) {
      try {
        await gitAiFixApply({ patch: issue.patch as string, path: issue.path })
        okCount++
      } catch (e) {
        notice.value = `应用 ${issue.path} 失败：${e instanceof Error ? e.message : e}，已停止`
        break
      }
    }
    if (okCount > 0) {
      notice.value = `已应用 ${okCount}/${issues.length} 项修复，修复前已自动创建快照，可随时回滚`
      await loadStatus()
    }
  } finally {
    applyingAll.value = false
  }
}

function doConflict(path: string) {
  void runAi('conflict', () => aiConflict(path))
}

function doReadme() {
  void runAi('readme', () => aiReadme())
}

/** AI 提交信息：填充提交消息输入框（不放进结果面板）。 */
async function doCommitMessage() {
  if (aiBusy.value) return
  activeTab.value = 'changes'
  aiBusy.value = true
  aiKind.value = 'commit'
  aiText.value = ''
  aiError.value = ''
  try {
    // 把暂存文件路径作为上下文，帮助模型生成更有针对性的提交信息。
    const staged = status.value?.staged ?? []
    const context = staged.length ? staged.map(e => e.path).join(', ') : undefined
    const r = await aiCommitMessage(context)
    commitMessage.value = r.text
    notice.value = 'AI 已生成提交信息，可修改后提交'
  } catch (e) {
    aiError.value = `AI 生成失败：${e instanceof Error ? e.message : e}，请手动填写提交信息`
    aiPanelOpen.value = true
  } finally {
    aiBusy.value = false
  }
}

async function copyText(text: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    notice.value = '已复制到剪贴板'
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      notice.value = '已复制到剪贴板'
    } catch {
      notice.value = '复制失败，请手动选择文本'
    }
    document.body.removeChild(ta)
  }
}

async function copyAiText() {
  await copyText(aiText.value)
}

// ── P2-6 对抗式评审 / P2-7 根因分析 ────────────────────────
// 结果写入独立文本区 aiText2，不覆盖主面板的 aiText / aiIssues 结果。
const aiText2 = ref('')
const ai2Kind = ref('对抗式评审')
const ai2Error = ref('')
const aiAdversarialBusy = ref(false)
const aiRootCauseBusy = ref(false)
const rootCauseCommit = ref('')

async function doAdversarialReview() {
  if (aiBusy.value || aiAdversarialBusy.value) return
  activeTab.value = 'changes'
  aiPanelOpen.value = true
  aiAdversarialBusy.value = true
  ai2Error.value = ''
  ai2Kind.value = '对抗式评审'
  try {
    const r = await gitAiAdversarialReview()
    aiText2.value = r.text
  } catch (e) {
    ai2Error.value = `对抗式评审失败：${e instanceof Error ? e.message : e}`
  } finally {
    aiAdversarialBusy.value = false
  }
}

async function doRootCause() {
  if (aiBusy.value || aiRootCauseBusy.value) return
  activeTab.value = 'changes'
  aiPanelOpen.value = true
  aiRootCauseBusy.value = true
  ai2Error.value = ''
  ai2Kind.value = '根因分析'
  try {
    const r = await gitAiRootCause(rootCauseCommit.value.trim() || undefined)
    aiText2.value = r.text
  } catch (e) {
    ai2Error.value = `根因分析失败：${e instanceof Error ? e.message : e}`
  } finally {
    aiRootCauseBusy.value = false
  }
}

async function copyAiText2() {
  await copyText(aiText2.value)
}

// ── P2-5 A/B 实验对比 ──────────────────────────────────────
// 两个分支下拉复用 branchList；默认取分支列表前两个。
const abBranchA = ref('')
const abBranchB = ref('')
const abBusy = ref(false)
const abText = ref('')
const abError = ref('')

function initAbBranches() {
  const list = branchList.value
  if (list.length) abBranchA.value = abBranchA.value || list[0]
  if (list.length > 1) abBranchB.value = abBranchB.value || list[1]
}

// branchList 在下方声明；默认分支初始化放在 loadBranches() 成功后执行。

async function doAbCompare() {
  const a = abBranchA.value.trim()
  const b = abBranchB.value.trim()
  if (!a || !b) { abError.value = '请选择两个分支'; return }
  if (a === b) { abError.value = '请选择两个不同的分支'; return }
  if (abBusy.value) return
  abBusy.value = true
  abError.value = ''
  abText.value = ''
  try {
    const r = await gitAiCompare({ branch_a: a, branch_b: b })
    abText.value = r.text
    notice.value = 'A/B 对比报告已生成'
  } catch (e) {
    abError.value = `生成对比报告失败：${e instanceof Error ? e.message : e}`
  } finally {
    abBusy.value = false
  }
}

async function copyAbText() {
  await copyText(abText.value)
}

// ── 定时快照（P1-3）────────────────────────────────────────
const scheduleEnabled = ref(false)
const scheduleCron = ref('')
const scheduleRetain = ref(10)
const scheduleLoading = ref(false)
const scheduleSaving = ref(false)
const scheduleError = ref('')

async function loadSchedule() {
  scheduleLoading.value = true
  scheduleError.value = ''
  try {
    const s = await gitSnapshotSchedule()
    scheduleEnabled.value = s.enabled
    scheduleCron.value = s.cron ?? ''
    scheduleRetain.value = s.retain
  } catch (e) {
    scheduleError.value = `定时快照配置加载失败：${e instanceof Error ? e.message : e}`
  } finally {
    scheduleLoading.value = false
  }
}

async function saveSchedule() {
  const retain = Math.round(scheduleRetain.value)
  if (!Number.isFinite(retain) || retain < 1 || retain > 200) {
    scheduleError.value = '保留数量需在 1-200 之间'
    return
  }
  if (scheduleSaving.value) return
  scheduleSaving.value = true
  scheduleError.value = ''
  try {
    const s = await gitSnapshotScheduleUpdate({
      enabled: scheduleEnabled.value,
      cron: scheduleCron.value.trim() || null,
      retain,
    })
    scheduleEnabled.value = s.enabled
    scheduleCron.value = s.cron ?? ''
    scheduleRetain.value = s.retain
    notice.value = '定时快照设置已保存'
  } catch (e) {
    scheduleError.value = `保存失败：${e instanceof Error ? e.message : e}`
  } finally {
    scheduleSaving.value = false
  }
}

// ── PR 集成（P1-4）─────────────────────────────────────────
const prBase = ref('main')
const prHead = ref('')
const prHeadRepo = ref('')
const prRemote = ref('origin')
const prUpstream = ref('')
const prToken = ref('')
const prTitle = ref('')
const prDescription = ref('')
const prBusy = ref('') // '' | 'describe' | 'create'
const prError = ref('')
const prCreated = ref<PrCreateResult | null>(null)

/** PR 仓库信息提示：从已配置的 remote 推导来源（fork）与目标（上游）仓库。 */
const prRepoHint = computed(() => {
  const parts: string[] = []
  const source = remotes.value.find(r => r.name === (prRemote.value.trim() || 'origin')) ?? remotes.value[0]
  if (source) parts.push(`来源：${source.name} → ${source.url}（${source.platform}）`)
  const upstreamName = prUpstream.value.trim()
  const target = remotes.value.find(r => r.name === (upstreamName || 'upstream'))
    ?? (upstreamName && (upstreamName.includes('://') || upstreamName.startsWith('git@'))
      ? { name: 'upstream', url: upstreamName, platform: '' } as RemoteInfo
      : null)
  if (target) parts.push(`目标：${target.name} → ${target.url}（${target.platform || '自动识别'}）`)
  else if (source) parts.push(`目标（未指定上游）：${source.name}，按同仓库 PR 处理`)
  return parts.join(' · ')
})

/** 分支标签页的 branchInfo 复用给 PR 的目标分支选择。 */
const branchList = computed(() => branchInfo.value?.branches ?? [])

/** 从描述文本提取标题：首个非空、非代码块围栏的行，去掉开头的 # 前缀。 */
function extractTitle(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('```'))
  return line ? line.replace(/^#+\s*/, '') : ''
}

async function describePr() {
  const base = prBase.value.trim()
  if (!base) { prError.value = '请输入基础分支'; return }
  if (prBusy.value) return
  prBusy.value = 'describe'
  prError.value = ''
  prCreated.value = null
  try {
    const r = await gitPrDescribe({ base, head: prHead.value || undefined })
    prDescription.value = r.text
    prTitle.value = extractTitle(r.text)
    notice.value = 'PR 描述已生成，可编辑后创建'
  } catch (e) {
    prError.value = `生成描述失败：${e instanceof Error ? e.message : e}`
  } finally {
    prBusy.value = ''
  }
}

async function createPr() {
  const base = prBase.value.trim()
  if (!base) { prError.value = '请输入基础分支'; return }
  if (prBusy.value) return
  const title = prTitle.value.trim() || extractTitle(prDescription.value)
  if (!await requestConfirmation(`确定要把改动提交给原作者吗？\n\n标题：${title || '（未填写）'}\n\n创建后可在 GitHub / Gitee 上继续修改。`)) return
  prBusy.value = 'create'
  prError.value = ''
  try {
    const body = prDescription.value.trim()
    const title = prTitle.value.trim() || extractTitle(body)
    const r = await gitPrCreate({
      base,
      head: prHead.value || undefined,
      headRepo: prHeadRepo.value.trim() || undefined,
      title: title || undefined,
      body: body || undefined,
      remote: prRemote.value.trim() || undefined,
      upstream: prUpstream.value.trim() || undefined,
      token: prToken.value.trim() || undefined,
    })
    prCreated.value = r
    prToken.value = ''
    notice.value = `PR 已创建 #${r.number}`
  } catch (e) {
    prError.value = `创建 PR 失败：${e instanceof Error ? e.message : e}`
  } finally {
    prBusy.value = ''
  }
}

// ── 分支标签页 ─────────────────────────────────────────────
const branchInfo = ref<BranchInfo | null>(null)
const newBranchName = ref('')
const switchingBranch = ref('')

async function loadBranches() {
  try {
    branchInfo.value = await gitBranches()
    initAbBranches()
  } catch (e) { notice.value = `分支加载失败：${e instanceof Error ? e.message : e}` }
}

async function createBranch() {
  const name = newBranchName.value.trim()
  if (!name) { notice.value = '请输入分支名'; return }
  if (switchingBranch.value) return
  switchingBranch.value = name
  try {
    await gitBranchCreate(name)
    newBranchName.value = ''
    notice.value = `已创建并切换到 ${name}`
    await Promise.all([loadStatus(), loadBranches()])
  } catch (e) {
    notice.value = `创建分支失败：${e instanceof Error ? e.message : e}`
  } finally {
    switchingBranch.value = ''
  }
}

async function switchBranch(name: string) {
  if (switchingBranch.value) return
  const pending = status.value
  if (pending && (pending.staged.length + pending.unstaged.length + pending.untracked.length + pending.conflicted.length) > 0) {
    if (!await requestConfirmation(`当前还有未保存的改动。切换到「${name}」分支后这些改动会跟着走，如果两边改了同一处可能出错。\n\n建议先点「保存改动」把改动存下来再切换。确定继续切换吗？`)) return
  }
  switchingBranch.value = name
  try {
    await gitCheckout(name)
    notice.value = `已切换到 ${name}`
    await Promise.all([loadStatus(), loadBranches()])
  } catch (e) {
    notice.value = `切换分支失败：${e instanceof Error ? e.message : e}`
  } finally {
    switchingBranch.value = ''
  }
}

// ── 历史标签页 ─────────────────────────────────────────────
const commits = ref<CommitInfo[]>([])
const logLoading = ref(false)
const expandedCommit = ref('')
const commitDiff = ref<DiffInfo | null>(null)
const commitDiffLoading = ref(false)
const commitDiffError = ref('')

async function loadLog() {
  logLoading.value = true
  try { commits.value = await gitLog({ limit: 50 }) } catch (e) { notice.value = `历史加载失败：${e instanceof Error ? e.message : e}` } finally { logLoading.value = false }
}

async function toggleCommit(commit: CommitInfo) {
  if (expandedCommit.value === commit.hash) {
    expandedCommit.value = ''
    commitDiff.value = null
    commitDiffError.value = ''
    return
  }
  expandedCommit.value = commit.hash
  commitDiff.value = null
  commitDiffError.value = ''
  commitDiffLoading.value = true
  try {
    // 无单提交 diff 端点，用 compare 端点对比 父提交→当前提交（首个提交无父提交时后端会报错）。
    commitDiff.value = await gitCompare(`${commit.hash}^`, commit.hash)
  } catch (e) {
    commitDiffError.value = `无法加载该提交的 diff（首个提交没有父提交）：${e instanceof Error ? e.message : e}`
  } finally {
    commitDiffLoading.value = false
  }
}

function fmtTime(sec: string): string {
  const n = Number(sec)
  if (!Number.isFinite(n)) return ''
  const d = new Date(n * 1000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ── Stash 标签页 ───────────────────────────────────────────
const stashes = ref<StashEntry[]>([])
const stashMessage = ref('')
const stashBusy = ref('')

async function loadStash() {
  try { stashes.value = await gitStashList() } catch (e) { notice.value = `Stash 加载失败：${e instanceof Error ? e.message : e}` }
}

async function stashPush() {
  if (stashBusy.value) return
  stashBusy.value = 'push'
  try {
    await gitStashPush(stashMessage.value.trim() || undefined)
    stashMessage.value = ''
    notice.value = '已保存到 Stash（含未跟踪文件）'
    await Promise.all([loadStash(), loadStatus()])
  } catch (e) {
    notice.value = `Stash 失败：${e instanceof Error ? e.message : e}`
  } finally {
    stashBusy.value = ''
  }
}

async function stashPop(index: number) {
  if (stashBusy.value) return
  stashBusy.value = `pop:${index}`
  try {
    await gitStashPop(index)
    notice.value = `已恢复 stash@{${index}}`
    await Promise.all([loadStash(), loadStatus()])
  } catch (e) {
    notice.value = `pop 失败：${e instanceof Error ? e.message : e}`
  } finally {
    stashBusy.value = ''
  }
}

async function stashDrop(index: number) {
  if (stashBusy.value) return
  if (!await requestConfirmation('确定丢弃这条贮藏？丢弃后无法找回。')) return
  stashBusy.value = `drop:${index}`
  try {
    await gitStashDrop(index)
    notice.value = `已丢弃 stash@{${index}}`
    await loadStash()
  } catch (e) {
    notice.value = `drop 失败：${e instanceof Error ? e.message : e}`
  } finally {
    stashBusy.value = ''
  }
}

// ── 远端标签页 ─────────────────────────────────────────────
const remotes = ref<RemoteInfo[]>([])
const remoteName = ref('')
const remoteUrl = ref('')
const pullRemote = ref('origin')
const pullBranch = ref('')
const pushRemote = ref('origin')
const pushBranch = ref('')
const pushToken = ref('')
const remoteBusy = ref('')

async function loadRemotes() {
  try { remotes.value = await gitRemotes() } catch (e) { notice.value = `远端加载失败：${e instanceof Error ? e.message : e}` }
}

async function addRemote() {
  const name = remoteName.value.trim()
  const url = remoteUrl.value.trim()
  if (!name || !url) { notice.value = '请输入远端名称与 URL'; return }
  if (remoteBusy.value) return
  remoteBusy.value = 'add'
  try {
    await gitRemoteAdd(name, url)
    remoteName.value = ''
    remoteUrl.value = ''
    notice.value = `已添加远端 ${name}`
    await loadRemotes()
  } catch (e) {
    notice.value = `添加远端失败：${e instanceof Error ? e.message : e}`
  } finally {
    remoteBusy.value = ''
  }
}

async function doFetch() {
  if (remoteBusy.value) return
  remoteBusy.value = 'fetch'
  try {
    await gitFetch()
    notice.value = '已拉取远端引用'
  } catch (e) {
    notice.value = `fetch 失败：${e instanceof Error ? e.message : e}`
  } finally {
    remoteBusy.value = ''
  }
}

async function doPull() {
  const branch = pullBranch.value.trim()
  if (!branch) { notice.value = '请输入要拉取的分支'; return }
  if (remoteBusy.value) return
  remoteBusy.value = 'pull'
  try {
    await gitPull(pullRemote.value.trim() || 'origin', branch)
    notice.value = '拉取完成'
    await Promise.all([loadStatus(), loadRemotes()])
  } catch (e) {
    notice.value = `pull 失败：${e instanceof Error ? e.message : e}`
  } finally {
    remoteBusy.value = ''
  }
}

async function doPush() {
  const branch = pushBranch.value.trim()
  if (!branch) { notice.value = '请输入要推送的分支'; return }
  if (remoteBusy.value) return
  remoteBusy.value = 'push'
  try {
    await gitPush(pushRemote.value.trim() || 'origin', branch, pushToken.value.trim() || undefined)
    pushToken.value = ''
    notice.value = '推送完成'
    await Promise.all([loadStatus(), loadRemotes()])
  } catch (e) {
    notice.value = `push 失败：${e instanceof Error ? e.message : e}`
  } finally {
    remoteBusy.value = ''
  }
}

onMounted(() => {
  void loadGitVersion()
  void loadAll()
})
</script>

<template>
  <div class="page" :class="{ embedded: props.embedded }">
    <PageHead v-if="!props.embedded" class="page-head" title="Git 面板" @back="goBack(router, '/settings')">
      <template #right>
        <button class="icon-btn" aria-label="刷新" @click="loadAll"><CoomiIcon name="refresh" :size="17" /></button>
      </template>
    </PageHead>
    <section v-if="props.embedded && confirmation" class="inline-confirm">
      <p>{{ confirmation.message }}</p>
      <div class="config-actions">
        <button class="btn" @click="answerConfirmation(false)">取消</button>
        <button class="btn btn-primary" @click="answerConfirmation(true)">确认继续</button>
      </div>
    </section>
    <main v-show="!props.embedded || (!aiConfigOpen && !confirmation)" class="body">
      <div v-if="props.embedded" class="embedded-toolbar"><button class="mini-btn" aria-label="刷新" @click="loadAll"><CoomiIcon name="refresh" :size="13" /> 刷新</button></div>
      <!-- 顶部状态栏 -->
      <section class="status-card">
        <div class="status-main">
          <span class="status-dot" :class="{ dirty: (status && (status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length) > 0) }" />
          <span class="status-summary">{{ statusSummary || '正在读取状态…' }}</span>
          <span v-if="gitVersion" class="version mono">git {{ gitVersion }}</span>
        </div>
        <p v-if="statusSub" class="status-sub">{{ statusSub }}</p>
        <div v-if="project" class="chips">
          <span v-for="d in project.detected" :key="d" class="chip">{{ d }}</span>
          <button v-if="hasRepo" class="chip-btn" :disabled="aiBusy" @click="doReadme">
            <CoomiIcon name="fileWrite" :size="13" />生成 README
          </button>
        </div>
      </section>

      <!-- Git 术语速查 -->
      <section class="help-card">
        <div class="help-head" @click="helpOpen = !helpOpen">
          <CoomiIcon name="fileRead" :size="14" class="help-ic" />
          <span class="help-title">Git 术语速查</span>
          <CoomiIcon class="chev" :name="helpOpen ? 'chevronDown' : 'chevronRight'" :size="14" />
        </div>
        <div v-if="helpOpen" class="help-body">
          <div v-for="row in HELP_ROWS" :key="row.term" class="help-row">
            <span class="help-term">{{ row.term }}</span>
            <span class="help-def">{{ row.def }}</span>
          </div>
          <p class="help-tip">面板内按钮均标注了作用，不确定的操作可先查看「历史」中的记录。</p>
        </div>
      </section>

      <!-- 非仓库引导 -->
      <section v-if="status && !hasRepo" class="init-card">
        <p class="init-title">当前目录不是 Git 仓库</p>
        <p class="init-copy">Git 面板用于管理代码仓库的版本记录。请先在会话中让 Agent 执行 <code class="code-inline">git init</code> 初始化仓库，或切换到已包含仓库的工作目录，再点「刷新状态」重试。</p>
        <button class="btn btn-primary init-btn" @click="loadAll"><CoomiIcon name="refresh" :size="15" />刷新状态</button>
      </section>

      <p v-if="error" class="notice err">{{ error }}</p>
      <p v-if="notice" class="notice">{{ notice }}</p>

      <template v-if="hasRepo">
        <div ref="tabBar" class="tabs">
          <span class="tab-thumb" :style="thumbStyle" aria-hidden="true" />
          <button v-for="t in TABS" :key="t.key" :ref="(el) => setTabEl(t.key, el)" class="tab" :class="{ on: activeTab === t.key }" @click="activeTab = t.key">{{ t.label }}</button>
        </div>

        <!-- ── 改动 ── -->
        <section v-if="activeTab === 'changes'" class="tab-panel">
          <!-- AI 助手：可折叠面板，展示总结 / Review / 冲突建议 / README 预览 -->
          <div class="ai-card">
            <div class="ai-head" @click="aiPanelOpen = !aiPanelOpen">
              <CoomiIcon name="sparkle" :size="15" class="ai-ic" />
              <span class="ai-title">AI 助手</span>
              <span v-if="aiBusy" class="ai-state">生成中…</span>
              <span v-else-if="aiError" class="ai-state err">生成失败</span>
              <span v-else-if="aiText" class="ai-state">{{ AI_KIND_LABEL[aiKind] }}</span>
              <span v-else-if="aiConfig.enabled" class="ai-state ok">独立模型已启用</span>
              <span class="ai-actions" @click.stop>
                <button class="mini-btn" :disabled="aiBusy" @click="doSummarize">变更总结</button>
                <button class="mini-btn" :disabled="aiBusy" @click="doReview()">代码审查</button>
                <button class="mini-btn" :disabled="aiBusy || aiAdversarialBusy" @click="doAdversarialReview">{{ aiAdversarialBusy ? '评审中…' : '深度评审' }}</button>
                <span class="rc-group">
                  <input v-model="rootCauseCommit" class="rc-input mono" placeholder="某个提交的编号（留空=最近一次）" :disabled="aiBusy || aiRootCauseBusy" @keyup.enter="doRootCause" />
                  <button class="mini-btn" :disabled="aiBusy || aiRootCauseBusy" @click="doRootCause">{{ aiRootCauseBusy ? '分析中…' : '根因分析' }}</button>
                </span>
                <button class="mini-btn ai-config-btn" :class="{ on: aiConfig.enabled }" @click="aiConfigOpen = true">
                  <CoomiIcon name="settings" :size="13" />模型设置
                </button>
              </span>
              <CoomiIcon class="chev" :name="aiPanelOpen ? 'chevronDown' : 'chevronRight'" :size="14" />
            </div>
            <div v-if="aiPanelOpen" class="ai-body">
              <p class="hint dim ai-model-tip">
                AI 助手使用独立的 Git AI 模型配置，与全局模型互不影响；未配置时输出为本地降级结果。
              </p>
              <p v-if="aiBusy" class="hint">AI 生成中…</p>
              <template v-else-if="aiError">
                <p class="notice err">{{ aiError }}</p>
                <p class="hint dim">AI 能力暂不可用，可手动填写提交信息或自行检查代码。</p>
              </template>
              <template v-else-if="aiIssues !== null">
                <template v-if="aiIssues.length">
                  <div class="issue-head-row">
                    <span class="ai-kind">检查结果 · 问题清单</span>
                    <span class="issue-count">{{ aiIssues.length }} 个问题</span>
                    <button class="mini-btn" :disabled="applyingAll || applyingIssue !== -1" @click="applyAllIssues">{{ applyingAll ? '修复中…' : '全部修复' }}</button>
                  </div>
                  <div v-for="(issue, i) in aiIssues" :key="issueKey(issue, i)" class="issue-card" :class="{ open: expandedIssue === i }">
                    <div class="issue-head" @click="toggleIssue(i)">
                      <span class="sev" :class="sevClass(issue.severity)">{{ issue.severity }}</span>
                      <span class="issue-path mono" :title="issue.path">{{ issue.path }}</span>
                      <span class="issue-summary">{{ issue.summary }}</span>
                      <CoomiIcon class="chev" :name="expandedIssue === i ? 'chevronDown' : 'chevronRight'" :size="14" />
                    </div>
                    <div v-if="expandedIssue === i" class="issue-body">
                      <pre v-if="issue.patch" class="ai-text issue-patch">{{ issue.patch }}</pre>
                      <p v-else class="hint dim">该问题没有可应用的补丁</p>
                      <div class="issue-actions">
                        <button class="mini-btn ai-mini" :disabled="applyingAll || applyingIssue !== -1" @click.stop="applyIssue(i)">
                          {{ applyingIssue === i ? '应用中…' : '应用此修复' }}
                        </button>
                      </div>
                    </div>
                  </div>
                </template>
                <p v-else class="hint dim">没发现问题（或 AI 暂不可用）</p>
              </template>
              <template v-else-if="aiText">
                <div class="ai-result-head">
                  <span class="ai-kind">{{ AI_KIND_LABEL[aiKind] }}</span>
                  <button class="mini-btn" @click="copyAiText"><CoomiIcon name="copy" :size="13" />复制</button>
                </div>
                <pre class="ai-text">{{ aiText }}</pre>
                <p v-if="aiKind === 'readme'" class="hint dim">README 为预览内容，点击「复制」后粘贴到项目根目录 README.md。</p>
              </template>
              <p v-else class="hint dim">点上方按钮：总结改动、检查代码，或让 AI 写 README。</p>
              <!-- 独立结果区：对抗式评审 / 根因分析（不覆盖主面板的 review 结果） -->
              <div v-if="aiText2 || ai2Error || aiAdversarialBusy || aiRootCauseBusy" class="ai-sec">
                <div class="ai-result-head">
                  <span class="ai-kind">{{ ai2Kind }}</span>
                  <button v-if="aiText2" class="mini-btn" @click="copyAiText2"><CoomiIcon name="copy" :size="13" />复制</button>
                </div>
                <p v-if="aiAdversarialBusy || aiRootCauseBusy" class="hint">生成中…</p>
                <pre v-else-if="aiText2" class="ai-text">{{ aiText2 }}</pre>
                <p v-if="ai2Error" class="notice err">{{ ai2Error }}</p>
              </div>
            </div>
          </div>

          <div class="groups">
            <div v-for="g in GROUPS" :key="g.key" class="group-col">
              <div class="group-head">
                <div class="group-head-text">
                  <span class="group-title">{{ g.title }}</span>
                  <span class="group-sub">{{ g.sub }}</span>
                </div>
                <span class="group-count">{{ entriesOf(g.key).length }}</span>
                <span class="group-actions">
                  <button v-if="g.key === 'staged' && entriesOf(g.key).length" class="mini-btn" :disabled="actionBusy" @click="unstagePaths([], true)">全部取消暂存</button>
                  <button v-else-if="(g.key === 'unstaged' || g.key === 'untracked') && entriesOf(g.key).length" class="mini-btn" :disabled="actionBusy" @click="stagePaths([], true)">全部暂存</button>
                </span>
              </div>
              <div v-if="!entriesOf(g.key).length" class="group-empty">这里没有改动</div>
              <div v-for="entry in entriesOf(g.key)" :key="g.key + '-' + entry.path" class="file-row" :class="{ expanded: isExpanded(g.key, entry.path) }">
                <div class="file-main" @click="toggleChange(g.key, entry)">
                  <span class="status-chip">{{ entry.status }}</span>
                  <span class="file-path mono" :title="entry.path">{{ entry.path }}</span>
                  <CoomiIcon class="chev" :name="isExpanded(g.key, entry.path) ? 'chevronDown' : 'chevronRight'" :size="14" />
                </div>
                <button v-if="g.key === 'staged'" class="mini-btn" :disabled="actionBusy" @click="unstagePaths([entry.path])">取消暂存</button>
                <button v-else class="mini-btn" :disabled="actionBusy" @click="stagePaths([entry.path])">暂存</button>
                <button v-if="g.key === 'conflicted'" class="mini-btn ai-mini" :disabled="aiBusy" @click="doConflict(entry.path)">解决冲突</button>
                <button v-else class="mini-btn ai-mini" :disabled="aiBusy" @click="doReview(entry.path)">AI 审查</button>
                <div v-if="isExpanded(g.key, entry.path)" class="diff-box">
                  <p v-if="diffBusy(g.key, entry.path)" class="hint">diff 加载中…</p>
                  <p v-else-if="g.key === 'untracked'" class="hint dim">未跟踪文件没有差异内容，先暂存后再查看。</p>
                  <template v-else-if="diffOf(g.key, entry.path)">
                    <pre v-if="diffOf(g.key, entry.path)!.stat" class="diff-pre stat-pre"><span v-for="(l, i) in statLines(g.key, entry.path)" :key="'st' + i" class="dl-plain">{{ l.text }}</span></pre>
                    <pre class="diff-pre"><template v-for="(l, i) in diffLines(g.key, entry.path)" :key="'d' + i"><span :class="'dl-' + l.kind">{{ l.text }}</span></template></pre>
                    <p v-if="diffOf(g.key, entry.path)!.truncated" class="hint dim">diff 过长，已截断显示。</p>
                  </template>
                  <p v-else class="hint dim">无差异内容</p>
                </div>
              </div>
            </div>
          </div>

          <!-- ── 提交卡片 ── -->
          <div class="commit-card">
            <div class="card-head">
              <span class="card-title">提交更改</span>
              <span class="card-side">{{ stagedCount }} 项已暂存</span>
            </div>
            <p class="commit-guide">先暂存要提交的文件，填写提交说明后点击「提交」。</p>
            <div class="commit-bar">
              <input v-model="commitMessage" class="commit-input" placeholder="写一句话，例如：修复了登录页面崩溃" @keyup.enter="commit" />
              <button class="btn ai-btn" :disabled="aiBusy" @click="doCommitMessage">AI 生成提交信息</button>
              <button class="btn btn-primary commit-btn" :disabled="committing || !stagedCount" @click="commit">{{ committing ? '提交中…' : '提交' }}</button>
            </div>
            <p v-if="!stagedCount" class="commit-hint">暂无已暂存的改动，请先在上方文件列表中点「暂存」。</p>
            <p v-else class="commit-note">提交后可在「历史」标签页查看；推送到远程仓库请到「远程」标签页。</p>
          </div>

          <!-- ── 高级功能（折叠，不常用可跳过）── -->
          <section class="adv-card">
            <div class="adv-head" @click="advancedOpen = !advancedOpen">
              <CoomiIcon name="wrench" :size="14" class="adv-ic" />
              <span class="adv-title">高级功能</span>
              <CoomiIcon class="chev" :name="advancedOpen ? 'chevronDown' : 'chevronRight'" :size="14" />
            </div>
            <template v-if="advancedOpen">
              <!-- ── 自动备份（定时快照）── -->
              <section class="card">
                <div class="card-head">
                  <span class="card-title">定时快照</span>
                  <span v-if="scheduleLoading" class="card-side">加载中…</span>
                  <span v-else class="card-side">{{ scheduleEnabled ? '已启用' : '未启用' }}</span>
                </div>
                <div class="sched-row">
                  <span>按定时规则自动创建快照</span>
                  <button class="switch" :class="{ on: scheduleEnabled }" :disabled="scheduleLoading || scheduleSaving" @click="scheduleEnabled = !scheduleEnabled"><i /></button>
                </div>
                <div class="inline-form">
                  <input v-model="scheduleCron" class="text-input mono" placeholder="cron 表达式，如 0 3 * * *（每天 3 点）" @keyup.enter="saveSchedule" />
                </div>
                <div class="inline-form">
                  <input v-model.number="scheduleRetain" class="text-input num-input" type="number" min="1" max="200" placeholder="保留数量（1-200）" @keyup.enter="saveSchedule" />
                  <button class="btn btn-primary" :disabled="scheduleSaving || scheduleLoading" @click="saveSchedule">{{ scheduleSaving ? '保存中…' : '保存设置' }}</button>
                </div>
                <p class="form-note">标准 cron 格式（分 时 日 月 周）。开启后引擎按时自动打快照，仅保留最近 N 份。</p>
                <p v-if="scheduleError" class="notice err card-notice">{{ scheduleError }}</p>
              </section>

              <!-- ── 提交给原作者（PR）── -->
              <section class="card">
                <div class="card-head">
                  <span class="card-title">创建 PR</span>
                  <span class="card-side">{{ branchList.length }} 个分支</span>
                </div>
                <p class="form-note pr-intro">向 GitHub / Gitee / AtomGit 原项目发起 Pull Request，请维护者审核合并。</p>
                <div class="inline-form">
                  <input v-model="prBase" class="text-input mono" placeholder="目标分支（一般为 main）" />
                  <select v-model="prHead" class="text-input" aria-label="目标分支">
                    <option value="">源分支（默认当前分支）</option>
                    <option v-for="b in branchList" :key="b" :value="b">{{ b }}</option>
                  </select>
                </div>
                <div class="adv-detail">
                  <p class="adv-detail-title" @click="prAdvancedOpen = !prAdvancedOpen">
                    <CoomiIcon class="chev" :name="prAdvancedOpen ? 'chevronDown' : 'chevronRight'" :size="13" />
                    高级设置（一般不用填）
                  </p>
                  <template v-if="prAdvancedOpen">
                    <div class="inline-form">
                      <input v-model="prUpstream" class="text-input mono" placeholder="原项目仓库地址（远程名或完整 URL）" />
                      <input v-model="prRemote" class="text-input mono" placeholder="你的仓库（默认 origin）" />
                    </div>
                    <div class="inline-form">
                      <input v-model="prHeadRepo" class="text-input mono" placeholder="你的账号名（一般不用填）" />
                      <input v-model="prToken" class="text-input mono" type="password" placeholder="访问令牌（选填）" @keyup.enter="describePr" />
                    </div>
                  </template>
                </div>
                <p v-if="prRepoHint" class="form-note repo-hint">{{ prRepoHint }}</p>
                <div class="inline-form">
                  <button class="btn" :disabled="prBusy !== ''" @click="describePr">{{ prBusy === 'describe' ? '生成中…' : '让 AI 写描述' }}</button>
                  <button class="btn btn-primary" :disabled="prBusy !== ''" @click="createPr">{{ prBusy === 'create' ? '创建中…' : '创建 PR' }}</button>
                </div>
                <div class="inline-form">
                  <input v-model="prTitle" class="text-input mono" placeholder="PR 标题（生成描述后自动填写，可修改）" />
                </div>
                <div class="pr-body">
                  <textarea v-model="prDescription" class="pr-textarea mono" rows="6" placeholder="点「让 AI 写描述」自动填写；也可手动编辑。" />
                </div>
                <div v-if="prCreated" class="pr-result">
                  <span class="pr-ok">PR #{{ prCreated.number }} 已创建</span>
                  <a class="pr-link" :href="prCreated.url" target="_blank" rel="noopener"><CoomiIcon name="external" :size="13" />{{ prCreated.url }}</a>
                </div>
                <p class="form-note">AI 生成中文标题与正文；创建 PR 需要平台访问令牌，未填时使用已保存的令牌。</p>
                <p v-if="prError" class="notice err card-notice">{{ prError }}</p>
              </section>

              <!-- ── 对比两个分支（A/B）── -->
              <section class="card">
                <div class="card-head">
                  <span class="card-title">分支对比（A/B）</span>
                  <span class="card-side">{{ branchList.length }} 个分支</span>
                </div>
                <p class="form-note">选择两个分支，由 AI 对比两套方案的差异并给出建议。</p>
                <div class="inline-form">
                  <select v-model="abBranchA" class="text-input" aria-label="分支 A">
                    <option value="" disabled>方案 A（分支）</option>
                    <option v-for="b in branchList" :key="'a' + b" :value="b">{{ b }}</option>
                  </select>
                  <select v-model="abBranchB" class="text-input" aria-label="分支 B">
                    <option value="" disabled>方案 B（分支）</option>
                    <option v-for="b in branchList" :key="'b' + b" :value="b">{{ b }}</option>
                  </select>
                  <button class="btn btn-primary" :disabled="abBusy" @click="doAbCompare">{{ abBusy ? '生成中…' : '生成对比报告' }}</button>
                </div>
                <div v-if="abText || abError || abBusy" class="ab-body">
                  <p v-if="abBusy" class="hint">生成中…</p>
                  <template v-else>
                    <div v-if="abText" class="ai-result-head">
                      <span class="ai-kind">对比报告 · {{ abBranchA }} ↔ {{ abBranchB }}</span>
                      <button class="mini-btn" @click="copyAbText"><CoomiIcon name="copy" :size="13" />复制</button>
                    </div>
                    <pre v-if="abText" class="ai-text">{{ abText }}</pre>
                    <p v-if="abError" class="notice err card-notice">{{ abError }}</p>
                  </template>
                </div>
              </section>
            </template>
          </section>
        </section>

        <!-- ── 分支 ── -->
        <section v-if="activeTab === 'branches'" class="tab-panel">
          <div class="card">
            <div class="card-head">
              <span class="card-title">分支</span>
              <span class="card-side mono" v-if="branchInfo?.current">当前在：{{ branchInfo.current }}</span>
            </div>
            <p class="form-note card-note">点击分支名即可切换；存在未提交改动时会先确认。</p>
            <div v-if="!branchInfo?.branches?.length" class="empty">还没有分支</div>
            <div v-for="b in branchInfo?.branches ?? []" :key="b" class="branch-row" :class="{ cur: b === branchInfo?.current }" @click="switchBranch(b)">
              <CoomiIcon name="git" :size="15" class="br-ic" />
              <span class="br-name mono">{{ b }}</span>
              <span v-if="switchingBranch === b" class="busy-text">切换中…</span>
              <CoomiIcon v-else-if="b === branchInfo?.current" name="check" :size="15" class="tick" />
              <CoomiIcon v-else name="chevronRight" :size="14" class="chev" />
            </div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">新建分支</span></div>
            <p class="form-note card-note">在新分支上修改不影响其他分支。建议使用简短英文名，如 fix-login。</p>
            <div class="inline-form">
              <input v-model="newBranchName" class="text-input mono" placeholder="分支名，如 fix-login" @keyup.enter="createBranch" />
              <button class="btn btn-primary" :disabled="switchingBranch !== ''" @click="createBranch">创建并切换</button>
            </div>
          </div>
        </section>

        <!-- ── 历史 ── -->
        <section v-if="activeTab === 'history'" class="tab-panel">
          <p class="form-note card-note">每次提交都会记录在这里，点击可查看该次变更内容。</p>
          <p v-if="logLoading" class="hint">加载中…</p>
          <p v-else-if="!commits.length" class="hint">暂无提交记录</p>
          <div v-else class="card commit-list">
            <div v-for="c in commits" :key="c.hash" class="commit-row" :class="{ expanded: expandedCommit === c.hash }" @click="toggleCommit(c)">
              <div class="commit-main">
                <span class="hash mono">{{ c.short }}</span>
                <span class="subject">{{ c.subject }}</span>
                <span class="author">{{ c.author }}</span>
                <span class="date">{{ fmtTime(c.date) }}</span>
                <CoomiIcon class="chev" :name="expandedCommit === c.hash ? 'chevronDown' : 'chevronRight'" :size="14" />
              </div>
              <div v-if="expandedCommit === c.hash" class="commit-diff">
                <p v-if="commitDiffLoading" class="hint">diff 加载中…</p>
                <p v-else-if="commitDiffError" class="notice err">{{ commitDiffError }}</p>
                <template v-else-if="commitDiff">
                  <pre v-if="commitDiff.stat" class="diff-pre stat-pre"><span v-for="(l, i) in splitDiffLines(commitDiff.stat)" :key="'st' + i" class="dl-plain">{{ l.text }}</span></pre>
                  <pre class="diff-pre"><template v-for="(l, i) in splitDiffLines(commitDiff.diff)" :key="'d' + i"><span :class="'dl-' + l.kind">{{ l.text }}</span></template></pre>
                  <p v-if="commitDiff.truncated" class="hint dim">diff 过长，已截断显示。</p>
                </template>
              </div>
            </div>
          </div>
        </section>

        <!-- ── 临时收纳（Stash）── -->
        <section v-if="activeTab === 'stash'" class="tab-panel">
          <div class="card">
            <div class="card-head">
              <span class="card-title">贮藏（Stash）</span>
              <span class="card-side">{{ stashes.length }} 条</span>
            </div>
            <p class="form-note card-note">暂时收起未提交的改动，之后可随时恢复。</p>
            <div v-if="!stashes.length" class="empty">暂无贮藏记录</div>
            <div v-for="s in stashes" :key="s.index" class="stash-row">
              <div class="stash-main">
                <span class="hash mono">stash@{ {{ s.index }} }</span>
                <span class="subject">{{ s.message || '无消息' }}</span>
              </div>
              <div class="stash-actions">
                <button class="mini-btn" :disabled="stashBusy !== ''" @click="stashPop(s.index)">恢复</button>
                <button class="mini-btn danger" :disabled="stashBusy !== ''" @click="stashDrop(s.index)">丢弃</button>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">新建贮藏</span></div>
            <div class="inline-form">
              <input v-model="stashMessage" class="text-input" placeholder="备注（可选）" @keyup.enter="stashPush" />
              <button class="btn btn-primary" :disabled="stashBusy !== ''" @click="stashPush">贮藏</button>
            </div>
          </div>
        </section>

        <!-- ── 远端（同步）── -->
        <section v-if="activeTab === 'remotes'" class="tab-panel">
          <div class="card">
            <div class="card-head">
              <span class="card-title">远程仓库</span>
              <span class="card-side">{{ remotes.length }} 个</span>
            </div>
            <p class="form-note card-note">推送（Push）上传本地提交，拉取（Pull）同步远程更新。</p>
            <div v-if="!remotes.length" class="empty">尚未配置远程仓库</div>
            <div v-for="r in remotes" :key="r.name" class="remote-row">
              <div class="remote-main">
                <span class="remote-name mono">{{ r.name }}</span>
                <span class="remote-url mono">{{ r.url }}</span>
                <span class="chip">{{ r.platform }}</span>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">添加远程仓库</span></div>
            <p class="form-note card-note">先在 GitHub / Gitee 等平台创建仓库，再将其地址添加到这里。origin 是默认远程名。</p>
            <div class="inline-form">
              <input v-model="remoteName" class="text-input mono" placeholder="名称（一般填 origin）" />
              <input v-model="remoteUrl" class="text-input mono" placeholder="网址（https://… 或 git@…）" @keyup.enter="addRemote" />
              <button class="btn btn-primary" :disabled="remoteBusy !== ''" @click="addRemote">添加</button>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">同步</span></div>
            <p class="form-note card-note">拉取将远程更新同步到本地，推送将本地提交上传到远程。</p>
            <div class="sync-block">
              <button class="btn" :disabled="remoteBusy !== ''" @click="doFetch"><CoomiIcon name="refresh" :size="15" />Fetch</button>
            </div>
            <div class="inline-form">
              <input v-model="pullRemote" class="text-input mono" placeholder="远程（默认 origin）" />
              <input v-model="pullBranch" class="text-input mono" placeholder="分支名（如 main）" @keyup.enter="doPull" />
              <button class="btn btn-primary" :disabled="remoteBusy !== ''" @click="doPull">下载最新改动</button>
            </div>
            <div class="inline-form">
              <input v-model="pushRemote" class="text-input mono" placeholder="远程（默认 origin）" />
              <input v-model="pushBranch" class="text-input mono" placeholder="要上传的分支（如 main）" />
              <input v-model="pushToken" class="text-input mono" type="password" placeholder="访问令牌（选填）" @keyup.enter="doPush" />
              <button class="btn btn-primary" :disabled="remoteBusy !== ''" @click="doPush">推送（Push）</button>
            </div>
            <p class="form-note">推送可填访问令牌（GitHub / Gitee 生成的 token），仅本次使用，不会保存。</p>
          </div>
        </section>
      </template>

      <p v-if="loading && !status" class="hint">加载中…</p>
    </main>

    <!-- ── Git AI 独立模型配置弹层 ── -->
    <Teleport to="body" :disabled="props.embedded">
      <Transition name="sheet-fade">
        <div v-if="aiConfigOpen" class="ai-config-mask" @click.self="aiConfigOpen = false">
          <div class="ai-config-sheet">
            <div class="config-head">
              <div class="config-head-text">
                <span class="config-title">AI 助手 · 模型设置</span>
                <span class="config-sub">这套配置只给 Git 面板的 AI 助手用，与全局模型互不影响</span>
              </div>
              <button class="config-close" aria-label="关闭" @click="aiConfigOpen = false"><CoomiIcon name="close" :size="16" /></button>
            </div>

            <div class="config-body">
              <label class="switch-row">
                <span class="switch-label">启用独立模型</span>
                <span class="switch-desc">开启后 AI 助手优先使用下面的配置，不再读取全局模型</span>
                <span class="switch" :class="{ on: aiConfig.enabled }" role="switch" :aria-checked="aiConfig.enabled" @click="aiConfig.enabled = !aiConfig.enabled"><i /></span>
              </label>

              <label class="cfg-field">
                <span class="cfg-label">服务商 / 协议</span>
                <div class="kind-row">
                  <button
                    v-for="opt in AI_KIND_OPTIONS" :key="opt.kind"
                    class="kind-chip" :class="{ on: aiConfig.kind === opt.kind }"
                    @click="pickAiKind(opt.kind)"
                  >{{ opt.label }}</button>
                </div>
              </label>

              <label class="cfg-field">
                <span class="cfg-label">Base URL（接口地址）</span>
                <input v-model="aiConfig.base_url" class="cfg-input mono" type="text" placeholder="https://api.deepseek.com/v1" spellcheck="false" autocomplete="off" />
              </label>

              <label class="cfg-field">
                <span class="cfg-label">API Key</span>
                <input v-model="aiConfig.api_key" class="cfg-input mono" type="password" placeholder="sk-…（只保存在本机）" spellcheck="false" autocomplete="off" />
              </label>

              <label class="cfg-field">
                <span class="cfg-label">模型名</span>
                <input v-model="aiConfig.model" class="cfg-input mono" type="text" placeholder="deepseek-chat" spellcheck="false" autocomplete="off" />
              </label>

              <p v-if="aiConfigMsg" class="config-msg" :class="{ err: aiConfigMsgErr }">{{ aiConfigMsg }}</p>
            </div>

            <div class="config-actions">
              <button class="btn ghost" :disabled="aiConfigSaving || aiConfigTesting" @click="aiConfigOpen = false">取消</button>
              <button class="btn ghost blue" :disabled="aiConfigSaving || aiConfigTesting" @click="testAiConfig">{{ aiConfigTesting ? '测试中…' : '测试连接' }}</button>
              <button class="btn primary" :disabled="aiConfigSaving || aiConfigTesting" @click="saveAiConfig">{{ aiConfigSaving ? '保存中…' : '保存配置' }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.page-head { position: relative; z-index: 5; flex-shrink: 0; }
.body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 12px 12px calc(var(--safe-bottom) + 24px); }

/* ── 状态栏 ── */
.status-card { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; padding: 11px 13px; border: 1px solid color-mix(in srgb, var(--border) 62%, transparent); border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.status-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex-shrink: 0; }
.status-dot.dirty { background: var(--warn); }
.status-summary { font-size: 13.5px; font-weight: 650; color: var(--text); line-height: 1.35; }
.status-sub { margin: 0; font-size: 12px; color: var(--text-3); line-height: 1.55; }
.version { margin-left: auto; font-size: 11.5px; color: var(--text-3); }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { padding: 2px 8px; border-radius: var(--r-pill); background: var(--fill-strong); color: var(--text-2); font-size: 11px; font-weight: 550; }

.init-card { margin-bottom: 10px; padding: 13px; border: 1px solid color-mix(in srgb, var(--border) 62%, transparent); border-radius: var(--r-card); background: var(--bg); color: var(--text-2); box-shadow: var(--shadow-1); }
.init-title { margin: 0 0 4px; font-size: 13.5px; font-weight: 650; color: var(--text); }
.init-copy { margin: 0 0 10px; font-size: 12.5px; line-height: 1.65; }
.code-inline { padding: 1px 6px; border-radius: 5px; background: var(--fill-strong); font-family: var(--font-mono); font-size: 12px; }
.init-btn { min-height: 36px; padding: 0 14px; font-size: 13px; }

/* ── 提示 ── */
.notice { margin: 0 0 10px; padding: 8px 12px; border-radius: var(--r-sm); background: var(--ok-soft); color: var(--ok); font-size: 12.5px; line-height: 1.5; word-break: break-all; }
.notice.err { background: var(--danger-soft); color: var(--danger); }
.hint { padding: 14px 4px; color: var(--text-3); font-size: 12.5px; text-align: center; }
.hint.dim { padding: 4px; font-size: 11.5px; }
.empty { padding: 16px 4px; color: var(--text-3); font-size: 12.5px; text-align: center; }

/* ── 标签页 ── */
.tabs { position: relative; display: flex; gap: 4px; margin-bottom: 10px; padding: 4px; border-radius: var(--r-md); background: var(--fill-strong); }
.tab-thumb {
  position: absolute; top: 4px; bottom: 4px; left: 4px; width: 0;
  background: var(--bg); border-radius: 8px; box-shadow: var(--shadow-1);
  transition: left 0.36s var(--spring), width 0.36s var(--spring), opacity 0.2s;
  pointer-events: none;
}
.tab {
  flex: 1; min-width: 0; min-height: 34px; border-radius: 8px;
  color: var(--text-2); font-size: 12.5px; font-weight: 550; white-space: nowrap;
  position: relative; z-index: 1;
  transition: color 0.18s, transform 0.3s var(--spring);
}
.tab.on { background: none; box-shadow: none; color: var(--blue); }
.tab:active { transform: scale(0.92); }
.tab-panel {
  display: flex; flex-direction: column; gap: 10px;
  animation: coomi-cascade 0.3s var(--ease-out-quart) both;
}

/* ── 卡片 ── */
.card { border: 1px solid color-mix(in srgb, var(--border) 62%, transparent); border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.card-head { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 8px 13px; border-bottom: 1px solid var(--border); }
.card-title { font-size: 13.5px; font-weight: 650; color: var(--text); }
.card-side { margin-left: auto; font-size: 12px; color: var(--text-3); }

/* ── 改动分组 ── */
.groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 10px; }
.group-col { border: 1px solid color-mix(in srgb, var(--border) 62%, transparent); border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.group-head { display: flex; align-items: center; gap: 7px; min-height: 40px; padding: 7px 11px; border-bottom: 1px solid var(--border); }
.group-title { font-size: 13px; font-weight: 650; color: var(--text); }
.group-count { padding: 1px 7px; border-radius: var(--r-pill); background: var(--fill-strong); color: var(--text-2); font-size: 11px; font-variant-numeric: tabular-nums; }
.group-actions { margin-left: auto; }
.group-empty { padding: 18px 4px; color: var(--text-3); font-size: 12px; text-align: center; }
.file-row { padding: 0 8px; border-bottom: 1px solid var(--border); }
.file-row:last-child { border-bottom: none; }
.file-row.expanded { background: var(--fill); }
.file-main { display: flex; align-items: center; gap: 7px; min-height: 42px; width: 100%; text-align: left; }
.status-chip { flex-shrink: 0; min-width: 30px; padding: 1px 5px; border-radius: 5px; background: var(--blue-soft); color: var(--blue); font-family: var(--font-mono); font-size: 10.5px; text-align: center; }
.file-path { flex: 1; min-width: 0; overflow: hidden; color: var(--text); font-size: 12.3px; text-overflow: ellipsis; white-space: nowrap; }
.chev { flex-shrink: 0; color: var(--text-3); }
.mini-btn { flex-shrink: 0; min-height: 26px; padding: 0 8px; border-radius: 6px; background: var(--fill-strong); color: var(--text-2); font-size: 11px; }
.mini-btn:active { background: var(--fill-press); }
.mini-btn:disabled { opacity: .4; }
.mini-btn.danger { color: var(--danger); background: var(--danger-soft); }
.diff-box { padding: 8px 2px 10px; }

/* ── diff 渲染 ── */
.diff-pre { margin: 0 0 6px; padding: 9px 10px; border-radius: var(--r-sm); background: var(--code-bg); color: var(--code-text); font-family: var(--font-mono); font-size: 11.6px; line-height: 1.5; overflow-x: auto; white-space: pre; -webkit-overflow-scrolling: touch; }
.diff-pre:last-child { margin-bottom: 0; }
.diff-pre span { display: block; }
.stat-pre { color: var(--text-2); }
.dl-add { background: color-mix(in srgb, var(--ok) 13%, transparent); }
.dl-del { background: color-mix(in srgb, var(--danger) 13%, transparent); }
.dl-hunk { background: var(--blue-soft); color: var(--blue); }
.dl-meta { color: var(--text-3); }
.dl-plain { color: var(--code-text); }

/* ── AI 助手面板 ── */
.ai-card { border: 1px solid color-mix(in srgb, var(--border) 62%, transparent); border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.ai-head { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 8px 11px; flex-wrap: wrap; }
.ai-ic { color: var(--text-3); flex-shrink: 0; }
.ai-title { font-size: 13px; font-weight: 650; color: var(--text); }
.ai-state { font-size: 11px; color: var(--text-3); }
.ai-state.err { color: var(--danger); }
.ai-actions { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.ai-head .chev { flex-shrink: 0; }
.ai-body { padding: 0 11px 11px; border-top: 1px solid var(--border); }
.ai-result-head { display: flex; align-items: center; gap: 8px; padding: 9px 0 6px; }
.ai-kind { font-size: 12px; font-weight: 650; color: var(--blue); }
.ai-result-head .mini-btn { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; }
.ai-text { margin: 0 0 4px; max-height: 44vh; overflow: auto; padding: 9px 10px; border-radius: var(--r-sm); background: var(--code-bg); color: var(--code-text); font-family: var(--font-mono); font-size: 11.6px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; -webkit-overflow-scrolling: touch; }
.ai-mini { color: var(--blue); background: var(--blue-soft); }
.ai-mini:disabled { opacity: .4; }

/* ── 对抗式评审 / 根因分析（独立结果区） ── */
.rc-group { display: inline-flex; align-items: center; gap: 6px; }
.rc-input { width: 172px; min-height: 26px; padding: 0 8px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-input); color: var(--text); font-size: 11px; }
.ai-sec { margin-top: 10px; padding-top: 2px; border-top: 1px solid var(--border); }

/* ── A/B 实验对比 ── */
.ab-body { padding: 2px 13px 10px; }

/* ── AI Review 问题清单 ── */
.issue-head-row { display: flex; align-items: center; gap: 8px; padding: 9px 0 6px; }
.issue-count { margin-left: auto; font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.issue-head-row .mini-btn { flex-shrink: 0; margin-left: 6px; }
.issue-card { margin-top: 6px; border: 1px solid var(--border); border-radius: var(--r-sm); overflow: hidden; }
.issue-head { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 6px 9px; }
.issue-head:active { background: var(--fill); }
.issue-card.open { background: var(--fill); }
.sev { flex-shrink: 0; min-width: 30px; padding: 1px 6px; border-radius: 5px; font-size: 11px; font-weight: 650; text-align: center; }
.sev-high { background: var(--danger-soft); color: var(--danger); }
.sev-mid { background: var(--warn-soft); color: var(--warn); }
.sev-low { background: var(--fill-strong); color: var(--text-3); }
.issue-path { flex-shrink: 0; max-width: 42%; overflow: hidden; color: var(--blue); font-size: 11.6px; text-overflow: ellipsis; white-space: nowrap; }
.issue-summary { flex: 1; min-width: 0; overflow: hidden; color: var(--text-2); font-size: 12px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.issue-body { padding: 8px 9px 9px; border-top: 1px solid var(--border); }
.issue-patch { max-height: 32vh; }
.issue-actions { display: flex; justify-content: flex-end; padding-top: 6px; }
.ai-btn { flex-shrink: 0; min-height: 42px; padding: 0 11px; border-radius: var(--r-sm); background: var(--fill-strong); color: var(--text-2); font-size: 12.3px; white-space: nowrap; }
.chip-btn { display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 0 9px; border-radius: var(--r-pill); background: var(--fill-strong); color: var(--text-2); font-size: 11px; font-weight: 550; }
.chip-btn:active { background: var(--fill-press); }
.chip-btn:disabled { opacity: .5; }

/* ── 提交栏 ── */
.commit-bar { display: flex; gap: 8px; position: sticky; bottom: 0; margin-top: 4px; padding: 9px 2px; background: var(--page); }
.commit-input { flex: 1; min-width: 0; min-height: 42px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg); color: var(--text); font-size: 13px; }
.commit-btn { flex-shrink: 0; min-height: 42px; }
.commit-note { margin: -4px 2px 0; font-size: 11.5px; color: var(--text-3); }

/* ── 分支 ── */
.branch-row { display: flex; align-items: center; gap: 9px; min-height: 46px; padding: 8px 13px; border-bottom: 1px solid var(--border); }
.branch-row:last-child { border-bottom: none; }
.branch-row:active { background: var(--fill); }
.branch-row.cur { background: var(--blue-soft); }
.br-ic { color: var(--text-3); flex-shrink: 0; }
.branch-row.cur .br-ic { color: var(--blue); }
.br-name { flex: 1; min-width: 0; overflow: hidden; color: var(--text); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.tick { flex-shrink: 0; color: var(--blue); }
.busy-text { flex-shrink: 0; font-size: 11px; color: var(--text-3); }

/* ── 历史 ── */
.commit-list { padding: 4px 0; }
.commit-row { padding: 0 13px; border-bottom: 1px solid var(--border); }
.commit-row:last-child { border-bottom: none; }
.commit-row.expanded { background: var(--fill); }
.commit-main { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto auto; align-items: center; gap: 8px; min-height: 50px; }
.hash { font-size: 11.5px; color: var(--blue); }
.subject { overflow: hidden; color: var(--text); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.author { color: var(--text-3); font-size: 11.5px; }
.date { color: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.commit-diff { padding: 4px 0 10px; }

/* ── Stash ── */
.stash-row { display: flex; align-items: center; gap: 9px; min-height: 48px; padding: 8px 13px; border-bottom: 1px solid var(--border); }
.stash-row:last-child { border-bottom: none; }
.stash-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.stash-actions { display: flex; gap: 6px; flex-shrink: 0; }

/* ── 远端 ── */
.remote-row { padding: 9px 13px; border-bottom: 1px solid var(--border); }
.remote-row:last-child { border-bottom: none; }
.remote-main { display: flex; flex-direction: column; gap: 3px; }
.remote-name { font-size: 13px; color: var(--text); font-weight: 600; }
.remote-url { overflow: hidden; color: var(--text-3); font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.remote-main .chip { align-self: flex-start; }
.sync-block { padding: 10px 13px 2px; }
.inline-form { display: flex; gap: 7px; flex-wrap: wrap; padding: 10px 13px; border-top: 1px solid var(--border); }
.inline-form:first-of-type { border-top: none; }
.text-input { flex: 1; min-width: 120px; min-height: 38px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg-input); color: var(--text); font-size: 12.5px; }
.inline-form .btn { min-height: 38px; padding: 0 15px; font-size: 13px; }
.form-note { margin: 0; padding: 0 13px 12px; font-size: 11.5px; color: var(--text-3); line-height: 1.6; }

/* ── 定时快照 / PR 集成 ── */
.sched-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 12px 13px 2px; font-size: 12.5px; color: var(--text-2); }
.switch { width: 42px; height: 24px; border-radius: 12px; border: 0; position: relative; background: var(--fill-strong, #c9cfdd); cursor: pointer; transition: background .18s; flex-shrink: 0; }
.switch i { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left 0.3s var(--spring), transform 0.3s var(--spring); box-shadow: 0 1px 3px rgba(0, 0, 0, .2); }
.switch:active i { transform: scale(0.85); }
.switch.on { background: var(--blue); }
.switch.on i { left: 20px; }
.switch:disabled { opacity: .5; }
.num-input { max-width: 190px; }
.pr-body { padding: 0 13px 10px; }
.pr-textarea { width: 100%; min-height: 120px; padding: 9px 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--code-bg); color: var(--code-text); font-family: var(--font-mono); font-size: 11.6px; line-height: 1.6; resize: vertical; }
.pr-textarea::placeholder { color: var(--text-3); }
.pr-result { display: flex; flex-direction: column; gap: 4px; padding: 0 13px 10px; }
.pr-ok { font-size: 12.5px; font-weight: 650; color: var(--ok); }
.pr-link { display: inline-flex; align-items: center; gap: 5px; color: var(--blue); font-size: 12px; word-break: break-all; }
.card-notice { margin: 0 13px 12px; }

/* ── 术语速查 ── */
.help-card { margin-bottom: 10px; border-radius: var(--r-card); background: var(--fill-strong); overflow: hidden; }
.help-head { display: flex; align-items: center; gap: 7px; min-height: 42px; padding: 0 13px; cursor: pointer; }
.help-ic { color: var(--text-3); flex-shrink: 0; }
.help-title { flex: 1; font-size: 13px; font-weight: 650; color: var(--text-2); }
.help-body { padding: 2px 13px 12px; }
.help-row { display: flex; gap: 10px; padding: 5px 0; border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent); }
.help-row:first-child { border-top: none; }
.help-term { flex-shrink: 0; min-width: 104px; font-size: 12px; font-weight: 650; color: var(--text); }
.help-def { font-size: 12px; color: var(--text-2); line-height: 1.55; }
.help-tip { margin: 8px 0 0; font-size: 11.5px; color: var(--text-3); line-height: 1.6; }

/* ── 改动分组 ── */
.group-head-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.group-sub { font-size: 10.5px; color: var(--text-3); line-height: 1.4; }

/* ── 提交卡片 ── */
.commit-card { border: 1px solid color-mix(in srgb, var(--border) 62%, transparent); border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.commit-guide { margin: 0; padding: 9px 13px 2px; font-size: 12px; color: var(--text-2); line-height: 1.65; }
.commit-card .commit-bar { margin: 0; padding: 9px 13px; }
.commit-hint { margin: 0; padding: 0 13px 12px; font-size: 11.5px; color: var(--warn); line-height: 1.6; }
.commit-card .commit-note { margin: 0; padding: 0 13px 12px; }

/* ── 高级功能折叠 ── */
.adv-card { border-radius: var(--r-card); background: var(--fill-strong); overflow: hidden; }
.adv-head { display: flex; align-items: center; gap: 7px; min-height: 42px; padding: 0 13px; cursor: pointer; }
.adv-ic { color: var(--text-3); flex-shrink: 0; }
.adv-title { flex: 1; font-size: 13px; font-weight: 650; color: var(--text-2); }
.adv-card .card { margin: 0 0 10px; border-radius: var(--r-card); }
.adv-card .card:first-of-type { margin-top: 10px; }
.adv-card .card:last-of-type { margin-bottom: 10px; }
.adv-detail { border-top: 1px solid var(--border); }
.adv-detail-title { display: flex; align-items: center; gap: 5px; margin: 0; padding: 10px 13px 2px; font-size: 12px; color: var(--text-3); cursor: pointer; }
.adv-detail .inline-form { padding-top: 8px; }

/* ── 杂项 ── */
.card-note { padding-top: 9px; }
.pr-intro { padding-top: 9px; }

@media (max-width: 430px) {
  .commit-main { grid-template-columns: auto minmax(0, 1fr) auto; }
  .commit-main .author { display: none; }
}

/* ── Git AI 独立模型配置弹层 ── */
.ai-config-mask {
  position: fixed; inset: 0; z-index: 90;
  display: flex; align-items: flex-end; justify-content: center;
  background: rgba(10, 14, 20, 0.45);
}
.ai-config-sheet {
  width: 100%; max-width: 480px; max-height: 88vh; overflow-y: auto;
  display: flex; flex-direction: column;
  border-radius: 24px 24px 0 0;
  background: var(--bg-card);
  box-shadow: var(--shadow-sheet);
  padding-bottom: calc(12px + var(--safe-bottom));
}
.config-head {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 18px 16px 12px;
  border-bottom: 1px solid var(--border);
}
.config-head-text { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.config-title { font-size: 16px; font-weight: 700; color: var(--text); }
.config-sub { font-size: 12px; color: var(--text-3); line-height: 1.5; }
.config-close {
  display: grid; place-items: center; flex-shrink: 0;
  width: 32px; height: 32px; border-radius: 50%;
  background: var(--fill); color: var(--text-2);
}
.config-close:active { background: var(--fill-press); }
.config-body { display: flex; flex-direction: column; gap: 14px; padding: 4px 16px 14px; }
.switch-row {
  display: flex; flex-direction: column; gap: 2px; position: relative;
  padding: 11px 12px;
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill);
}
.switch-label { font-size: 13.5px; font-weight: 650; color: var(--text); }
.switch-desc { font-size: 11.5px; color: var(--text-3); line-height: 1.5; padding-right: 52px; }
.switch-row .switch {
  position: absolute; right: 12px; top: 14px;
  width: 42px; height: 24px; border-radius: 12px; border: 0;
  background: var(--border-strong); cursor: pointer; transition: background .18s; flex-shrink: 0;
}
.switch-row .switch i {
  position: absolute; top: 2px; left: 2px; width: 20px; height: 20px;
  border-radius: 50%; background: #fff;
  transition: left 0.3s var(--spring), transform 0.3s var(--spring);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .2);
}
.switch-row .switch:active i { transform: scale(0.85); }
.switch-row .switch.on { background: var(--blue); }
.switch-row .switch.on i { left: 20px; }
.cfg-field { display: flex; flex-direction: column; gap: 6px; }
.cfg-label { font-size: 12.5px; font-weight: 600; color: var(--text-2); }
.kind-row { display: flex; flex-wrap: wrap; gap: 6px; }
.kind-chip {
  min-height: 32px; padding: 0 12px;
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--bg); color: var(--text-2); font-size: 12.5px;
}
.kind-chip.on { background: var(--blue-soft); border-color: var(--blue-border); color: var(--blue); font-weight: 650; }
.cfg-input {
  width: 100%; min-height: 42px; padding: 0 12px;
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  background: var(--bg-input); color: var(--text);
  font-size: 13px;
}
.cfg-input:focus { border-color: var(--blue-border); background: var(--bg); }
.config-msg { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--ok); }
.config-msg.err { color: var(--danger); }
.config-actions { display: flex; gap: 8px; padding: 8px 16px 0; }
.config-actions .btn { flex: 1; min-height: 42px; font-size: 13.5px; }
.btn.ghost.blue { background: var(--blue-soft); color: var(--blue); }
.btn.primary { background: linear-gradient(135deg, var(--blue), color-mix(in srgb, var(--blue) 84%, var(--blue-press))); color: #fff; box-shadow: 0 2px 12px color-mix(in srgb, var(--blue) 28%, transparent); }
.sheet-fade-enter-active, .sheet-fade-leave-active { transition: opacity .22s ease; }
.sheet-fade-enter-active .ai-config-sheet, .sheet-fade-leave-active .ai-config-sheet { transition: transform .26s cubic-bezier(.22, .68, .19, 1); }
.sheet-fade-enter-from, .sheet-fade-leave-to { opacity: 0; }
.sheet-fade-enter-from .ai-config-sheet, .sheet-fade-leave-to .ai-config-sheet { transform: translateY(28px); }

/* ── AI 状态徽标与配置按钮 ── */
.ai-state.ok { color: var(--ok); }
.ai-config-btn { color: var(--text-2); }
.ai-config-btn.on { background: var(--blue-soft); color: var(--blue); }

/* Tool content can live inside the launcher card or fill a routed page. */
.page { min-width: 0; min-height: 0; overflow: hidden; container-type: inline-size; }
.page.embedded { flex: 1; height: 100%; background: var(--bg); }
.embedded .body { padding: 10px 12px 14px; }
.embedded .card { border: 0; border-radius: 0; box-shadow: none; background: transparent; }
.embedded .card + .card { border-top: 1px solid var(--border); }
.embedded .notice { background: var(--fill); }
.embedded .tabs { background: transparent; padding: 0 0 6px; border-bottom: 1px solid var(--border); border-radius: 0; gap: 2px; }
.embedded .tab { padding-inline: 8px; font-size: 11px; min-height: 32px; }
.embedded .tab.on { background: var(--fill); color: var(--text); box-shadow: none; }
.embedded .card-head { padding-inline: 0; }
.embedded .card-title { font-size: 12.5px; }
.embedded .card-side { font-size: 11px; }
.embedded :is(input, select, textarea) { max-width: 100%; box-sizing: border-box; }
.embedded :is(.inline-form, .filter-row, .card-actions, .sched-form, .compare-form) { padding-inline: 0; }
.embedded :is(.text-input, .sel) { min-width: 0; flex-basis: 130px; }
.embedded :is(.btn, .button) { font-size: 12px; padding-inline: 10px; }
.embedded .embedded-toolbar { display: flex; justify-content: flex-end; margin-bottom: 6px; }
.embedded-toolbar .mini-btn { display: inline-flex; align-items: center; gap: 4px; min-height: 30px; padding: 5px 9px; border-radius: var(--r-sm); background: var(--fill); color: var(--text-2); font-size: 11px; white-space: nowrap; }
@container (max-width: 340px) {
  .card-head { flex-wrap: wrap; gap: 5px; }
  .body { padding-inline: 10px; }
  .card-side { font-size: 11px; }
  .range-meta { flex-direction: column; }
  .usage-row { grid-template-columns: minmax(0, 1fr) auto; gap: 5px; }
  .usage-tokens { grid-column: 1 / -1; }
  .summary-grid { grid-template-columns: 1fr; }
  .compare-form { flex-direction: column; align-items: stretch; }
  .compare-form .sel { flex-basis: auto; width: 100%; }
}


/* Quiet sections use the same neutral surfaces as the usage menu. */
.page :is(.status-card, .init-card, .card, .group-col, .ai-card, .commit-card, .help-card, .adv-card) {
  border: 0; border-radius: 0; background: transparent; box-shadow: none;
}
.status-card { padding: 6px 0 12px; border-bottom: 1px solid var(--border) !important; }
.page :is(.help-head, .adv-head) { padding-inline: 0; }
.page :is(.help-card, .adv-card, .ai-card, .commit-card) { border-bottom: 1px solid var(--border); }
.page :is(.notice, .branch-row.cur) { background: var(--fill); }
.page :is(.ai-mini, .ai-config-btn.on, .chip-btn, .status-chip) { background: var(--fill); color: var(--text-2); }
.page .btn.primary { background: var(--blue); box-shadow: none; }
.groups { grid-template-columns: repeat(auto-fit, minmax(min(100%, 270px), 1fr)); }
.embedded .tab-thumb { background: var(--fill); box-shadow: none; top: 0; bottom: 6px; }
.embedded .tab.on { background: transparent; }
.embedded .commit-bar { position: static; background: transparent; flex-wrap: wrap; padding-inline: 0; }
.embedded .commit-input { flex-basis: 100%; }
.embedded .rc-group { width: 100%; min-width: 0; }
.embedded .rc-input { flex: 1; min-width: 0; width: auto; }
.embedded .ai-actions { width: 100%; justify-content: flex-start; margin: 0; }
.embedded .ai-config-mask { position: static; display: flex; flex: 1; min-height: 0; overflow: auto; background: transparent; align-items: stretch; }
.embedded .ai-config-sheet { max-height: none; max-width: none; border-radius: 0; background: var(--bg); box-shadow: none; padding: 0 0 12px; }
.embedded .config-actions { flex-wrap: wrap; padding-inline: 12px; }
.embedded .config-actions .btn { flex: 1 1 80px; }
.inline-confirm { flex: 1; min-height: 0; padding: 12px; overflow: auto; }
.inline-confirm p { white-space: pre-wrap; font-size: 12px; line-height: 1.7; }
@container (max-width: 390px) {
  .commit-main { grid-template-columns: auto minmax(0, 1fr) auto; gap: 6px; }
  .commit-main .author { display: none; }
  .commit-main .date { grid-column: 2; grid-row: 2; padding-bottom: 6px; }
  .help-row { flex-direction: column; gap: 3px; }
  .stash-row { flex-wrap: wrap; }
  .stash-main { flex-basis: 100%; }
  .issue-head { flex-wrap: wrap; }
  .issue-summary { flex-basis: 100%; white-space: normal; }
}
</style>
