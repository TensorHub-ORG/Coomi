<script setup lang="ts">
/**
 * Git 面板：状态栏 + 改动 / 分支 / 历史 / Stash / 远端 五个标签页。
 * 全部数据来自 /api/git/*（见 src/bridge/git.ts），diff 用 <pre> 渲染并做行级 +/- 着色。
 */
import { computed, onMounted, ref, watch } from 'vue'
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

const router = useRouter()

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
  { key: 'stash', label: 'Stash' },
  { key: 'remotes', label: '远端' },
]
const activeTab = ref<Tab>('changes')

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

const GROUPS: { key: ChangeGroup; title: string }[] = [
  { key: 'staged', title: '暂存区' },
  { key: 'unstaged', title: '工作区' },
  { key: 'untracked', title: '未跟踪' },
  { key: 'conflicted', title: '冲突' },
]

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
    notice.value = short ? `已提交 ${short}` : '已提交'
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
const aiPanelOpen = ref(true)
const aiBusy = ref(false)
const aiKind = ref<AiKind>('summary')
const aiText = ref('')
const aiError = ref('')
// AI Review 结构化问题清单（来自 /api/git/ai/fix/suggest）；null 表示未获得结构化结果。
const aiIssues = ref<ReviewIssue[] | null>(null)
const expandedIssue = ref(-1)
const applyingIssue = ref(-1)
const applyingAll = ref(false)

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
  <div class="page">
    <PageHead title="Git 面板" @back="goBack(router, '/settings')">
      <template #right>
        <button class="icon-btn" aria-label="刷新" @click="loadAll"><CoomiIcon name="refresh" :size="17" /></button>
      </template>
    </PageHead>
    <main class="body">
      <!-- 顶部状态栏 -->
      <section class="status-card">
        <div class="status-main">
          <span class="branch">
            <CoomiIcon name="git" :size="16" />
            <span class="branch-name mono">{{ status?.branch || '未在仓库' }}</span>
          </span>
          <span v-if="hasRepo && (status?.ahead || status?.behind)" class="ab">
            <span v-if="status?.ahead" class="ab-ahead">↑{{ status.ahead }}</span>
            <span v-if="status?.behind" class="ab-behind">↓{{ status.behind }}</span>
          </span>
          <span v-if="gitVersion" class="version mono">git {{ gitVersion }}</span>
        </div>
        <div v-if="project" class="chips">
          <span v-for="d in project.detected" :key="d" class="chip">{{ d }}</span>
          <button v-if="hasRepo" class="chip-btn" :disabled="aiBusy" @click="doReadme">
            <CoomiIcon name="fileWrite" :size="13" />生成 README
          </button>
        </div>
      </section>

      <!-- 未在仓库：git init 引导 -->
      <section v-if="status && !hasRepo" class="init-card">
        <p class="init-title">当前目录还不是 Git 仓库</p>
        <p class="init-copy">在引擎的工作目录中执行 <code class="code-inline">git init</code> 初始化仓库后，改动、分支、历史、Stash 与远端能力会自动可用。</p>
        <button class="btn btn-primary init-btn" @click="loadAll"><CoomiIcon name="refresh" :size="15" />刷新状态</button>
      </section>

      <p v-if="error" class="notice err">{{ error }}</p>
      <p v-if="notice" class="notice">{{ notice }}</p>

      <template v-if="hasRepo">
        <div class="tabs">
          <button v-for="t in TABS" :key="t.key" class="tab" :class="{ on: activeTab === t.key }" @click="activeTab = t.key">{{ t.label }}</button>
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
              <span class="ai-actions" @click.stop>
                <button class="mini-btn" :disabled="aiBusy" @click="doSummarize">AI 变更总结</button>
                <button class="mini-btn" :disabled="aiBusy" @click="doReview()">AI Review</button>
                <button class="mini-btn" :disabled="aiBusy || aiAdversarialBusy" @click="doAdversarialReview">{{ aiAdversarialBusy ? '评审中…' : '对抗式评审' }}</button>
                <span class="rc-group">
                  <input v-model="rootCauseCommit" class="rc-input mono" placeholder="commit hash（留空=当前 HEAD）" :disabled="aiBusy || aiRootCauseBusy" @keyup.enter="doRootCause" />
                  <button class="mini-btn" :disabled="aiBusy || aiRootCauseBusy" @click="doRootCause">{{ aiRootCauseBusy ? '分析中…' : '根因分析' }}</button>
                </span>
              </span>
              <CoomiIcon class="chev" :name="aiPanelOpen ? 'chevronDown' : 'chevronRight'" :size="14" />
            </div>
            <div v-if="aiPanelOpen" class="ai-body">
              <p class="hint dim ai-model-tip">AI 功能调用「模型服务」中的活跃 Provider（支持 OpenAI 兼容、DeepSeek 账号、Anthropic、Gemini）；未配置 API Key 或未登录时输出为本地降级结果。</p>
              <p v-if="aiBusy" class="hint">AI 生成中…</p>
              <template v-else-if="aiError">
                <p class="notice err">{{ aiError }}</p>
                <p class="hint dim">AI 能力暂不可用，可手动填写提交信息或自行检查代码。</p>
              </template>
              <template v-else-if="aiIssues !== null">
                <template v-if="aiIssues.length">
                  <div class="issue-head-row">
                    <span class="ai-kind">AI Review · 问题清单</span>
                    <span class="issue-count">{{ aiIssues.length }} 个问题</span>
                    <button class="mini-btn" :disabled="applyingAll || applyingIssue !== -1" @click="applyAllIssues">{{ applyingAll ? '应用中…' : '全部应用' }}</button>
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
                <p v-else class="hint dim">未发现问题或模型不可用</p>
              </template>
              <template v-else-if="aiText">
                <div class="ai-result-head">
                  <span class="ai-kind">{{ AI_KIND_LABEL[aiKind] }}</span>
                  <button class="mini-btn" @click="copyAiText"><CoomiIcon name="copy" :size="13" />复制</button>
                </div>
                <pre class="ai-text">{{ aiText }}</pre>
                <p v-if="aiKind === 'readme'" class="hint dim">README 为预览内容，点击「复制」后粘贴到项目根目录 README.md。</p>
              </template>
              <p v-else class="hint dim">点击上方按钮让 AI 生成变更总结、代码审查或 README 预览。</p>
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

          <!-- ── 定时快照（P1-3）── -->
          <section class="card">
            <div class="card-head">
              <span class="card-title">定时快照</span>
              <span v-if="scheduleLoading" class="card-side">加载中…</span>
              <span v-else class="card-side">{{ scheduleEnabled ? '已启用' : '未启用' }}</span>
            </div>
            <div class="sched-row">
              <span>启用定时快照</span>
              <button class="switch" :class="{ on: scheduleEnabled }" :disabled="scheduleLoading || scheduleSaving" @click="scheduleEnabled = !scheduleEnabled"><i /></button>
            </div>
            <div class="inline-form">
              <input v-model="scheduleCron" class="text-input mono" placeholder="cron 表达式，如 0 3 * * *（每天 3 点）" @keyup.enter="saveSchedule" />
            </div>
            <div class="inline-form">
              <input v-model.number="scheduleRetain" class="text-input num-input" type="number" min="1" max="200" placeholder="保留快照数量（1-200）" @keyup.enter="saveSchedule" />
              <button class="btn btn-primary" :disabled="scheduleSaving || scheduleLoading" @click="saveSchedule">{{ scheduleSaving ? '保存中…' : '保存设置' }}</button>
            </div>
            <p class="form-note">cron 使用 5 段标准格式（分 时 日 月 周）；启用后引擎按表达式自动创建快照，并仅保留最近 N 份。语法校验由后端完成。</p>
            <p v-if="scheduleError" class="notice err card-notice">{{ scheduleError }}</p>
          </section>

          <!-- ── PR 集成（P1-4）── -->
          <section class="card">
            <div class="card-head">
              <span class="card-title">PR 集成</span>
              <span class="card-side">{{ branchList.length }} 个分支</span>
            </div>
            <div class="inline-form">
              <input v-model="prBase" class="text-input mono" placeholder="基础分支（main，上游仓库的分支）" />
              <select v-model="prHead" class="text-input" aria-label="目标分支">
                <option value="">目标分支（当前分支）</option>
                <option v-for="b in branchList" :key="b" :value="b">{{ b }}</option>
              </select>
            </div>
            <div class="inline-form">
              <input v-model="prUpstream" class="text-input mono" placeholder="上游仓库：remote 名（upstream）或完整 URL（跨仓库 PR）" />
              <input v-model="prRemote" class="text-input mono" placeholder="来源 remote（origin）" />
            </div>
            <div class="inline-form">
              <input v-model="prHeadRepo" class="text-input mono" placeholder="fork 所有者（留空自动取来源 remote 的 owner）" />
              <input v-model="prToken" class="text-input mono" type="password" placeholder="Token（可选，留空使用已保存的令牌）" @keyup.enter="describePr" />
            </div>
            <p v-if="prRepoHint" class="form-note repo-hint">{{ prRepoHint }}</p>
            <div class="inline-form">
              <button class="btn" :disabled="prBusy !== ''" @click="describePr">{{ prBusy === 'describe' ? '生成中…' : '生成 PR 描述' }}</button>
              <button class="btn btn-primary" :disabled="prBusy !== ''" @click="createPr">{{ prBusy === 'create' ? '创建中…' : '创建 PR' }}</button>
            </div>
            <div class="inline-form">
              <input v-model="prTitle" class="text-input mono" placeholder="PR 标题（生成描述后自动从首行提取，可修改）" />
            </div>
            <div class="pr-body">
              <textarea v-model="prDescription" class="pr-textarea mono" rows="6" placeholder="点击「生成 PR 描述」自动填写；也可手动编辑标题与正文 Markdown。" />
            </div>
            <div v-if="prCreated" class="pr-result">
              <span class="pr-ok">PR #{{ prCreated.number }} 已创建</span>
              <a class="pr-link" :href="prCreated.url" target="_blank" rel="noopener"><CoomiIcon name="external" :size="13" />{{ prCreated.url }}</a>
            </div>
            <p class="form-note">描述由 AI 生成中文标题与正文（Markdown）；创建 PR 时若后端未配置令牌可在此填写，仅本次请求使用。</p>
            <p v-if="prError" class="notice err card-notice">{{ prError }}</p>
          </section>

          <!-- ── A/B 实验对比（P2-5）── -->
          <section class="card">
            <div class="card-head">
              <span class="card-title">A/B 实验对比</span>
              <span class="card-side">{{ branchList.length }} 个分支</span>
            </div>
            <div class="inline-form">
              <select v-model="abBranchA" class="text-input" aria-label="分支 A">
                <option value="" disabled>分支 A</option>
                <option v-for="b in branchList" :key="'a' + b" :value="b">{{ b }}</option>
              </select>
              <select v-model="abBranchB" class="text-input" aria-label="分支 B">
                <option value="" disabled>分支 B</option>
                <option v-for="b in branchList" :key="'b' + b" :value="b">{{ b }}</option>
              </select>
              <button class="btn btn-primary" :disabled="abBusy" @click="doAbCompare">{{ abBusy ? '生成中…' : '生成对比报告' }}</button>
            </div>
            <div v-if="abText || abError || abBusy" class="ab-body">
              <p v-if="abBusy" class="hint">生成中…</p>
              <template v-else>
                <div v-if="abText" class="ai-result-head">
                  <span class="ai-kind">A/B 对比报告 · {{ abBranchA }} ↔ {{ abBranchB }}</span>
                  <button class="mini-btn" @click="copyAbText"><CoomiIcon name="copy" :size="13" />复制</button>
                </div>
                <pre v-if="abText" class="ai-text">{{ abText }}</pre>
                <p v-if="abError" class="notice err card-notice">{{ abError }}</p>
              </template>
            </div>
            <p class="form-note">选择两个分支后生成中文 A/B 实验分析报告；默认取分支列表前两个，结果可复制保存。</p>
          </section>

          <div class="groups">
            <div v-for="g in GROUPS" :key="g.key" class="group-col">
              <div class="group-head">
                <span class="group-title">{{ g.title }}</span>
                <span class="group-count">{{ entriesOf(g.key).length }}</span>
                <span class="group-actions">
                  <button v-if="g.key === 'staged' && entriesOf(g.key).length" class="mini-btn" :disabled="actionBusy" @click="unstagePaths([], true)">全部取消暂存</button>
                  <button v-else-if="(g.key === 'unstaged' || g.key === 'untracked') && entriesOf(g.key).length" class="mini-btn" :disabled="actionBusy" @click="stagePaths([], true)">全部暂存</button>
                </span>
              </div>
              <div v-if="!entriesOf(g.key).length" class="group-empty">无改动</div>
              <div v-for="entry in entriesOf(g.key)" :key="g.key + '-' + entry.path" class="file-row" :class="{ expanded: isExpanded(g.key, entry.path) }">
                <div class="file-main" @click="toggleChange(g.key, entry)">
                  <span class="status-chip">{{ entry.status }}</span>
                  <span class="file-path mono" :title="entry.path">{{ entry.path }}</span>
                  <CoomiIcon class="chev" :name="isExpanded(g.key, entry.path) ? 'chevronDown' : 'chevronRight'" :size="14" />
                </div>
                <button v-if="g.key === 'staged'" class="mini-btn" :disabled="actionBusy" @click="unstagePaths([entry.path])">取消暂存</button>
                <button v-else class="mini-btn" :disabled="actionBusy" @click="stagePaths([entry.path])">暂存</button>
                <button v-if="g.key === 'conflicted'" class="mini-btn ai-mini" :disabled="aiBusy" @click="doConflict(entry.path)">冲突解决助手</button>
                <button v-else class="mini-btn ai-mini" :disabled="aiBusy" @click="doReview(entry.path)">AI Review</button>
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

          <div class="commit-bar">
            <input v-model="commitMessage" class="commit-input" placeholder="提交信息，如 feat: 新增 XX" @keyup.enter="commit" />
            <button class="btn ai-btn" :disabled="aiBusy" @click="doCommitMessage">✨ AI 提交信息</button>
            <button class="btn btn-primary commit-btn" :disabled="committing || !entriesOf('staged').length" @click="commit">{{ committing ? '提交中…' : '提交' }}</button>
          </div>
          <p class="commit-note">提交前先暂存文件；冲突未解决时提交会失败。</p>
        </section>

        <!-- ── 分支 ── -->
        <section v-if="activeTab === 'branches'" class="tab-panel">
          <div class="card">
            <div class="card-head">
              <span class="card-title">分支列表</span>
              <span class="card-side mono" v-if="branchInfo?.current">当前：{{ branchInfo.current }}</span>
            </div>
            <div v-if="!branchInfo?.branches?.length" class="empty">暂无分支</div>
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
            <div class="inline-form">
              <input v-model="newBranchName" class="text-input mono" placeholder="分支名，如 feat/xxx" @keyup.enter="createBranch" />
              <button class="btn btn-primary" :disabled="switchingBranch !== ''" @click="createBranch">创建并切换</button>
            </div>
          </div>
        </section>

        <!-- ── 历史 ── -->
        <section v-if="activeTab === 'history'" class="tab-panel">
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

        <!-- ── Stash ── -->
        <section v-if="activeTab === 'stash'" class="tab-panel">
          <div class="card">
            <div class="card-head">
              <span class="card-title">Stash</span>
              <span class="card-side">{{ stashes.length }} 条</span>
            </div>
            <div v-if="!stashes.length" class="empty">暂无 Stash</div>
            <div v-for="s in stashes" :key="s.index" class="stash-row">
              <div class="stash-main">
                <span class="hash mono">stash@{ {{ s.index }} }</span>
                <span class="subject">{{ s.message || '无消息' }}</span>
              </div>
              <div class="stash-actions">
                <button class="mini-btn" :disabled="stashBusy !== ''" @click="stashPop(s.index)">pop</button>
                <button class="mini-btn danger" :disabled="stashBusy !== ''" @click="stashDrop(s.index)">drop</button>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">保存到 Stash</span></div>
            <div class="inline-form">
              <input v-model="stashMessage" class="text-input" placeholder="消息（可选，将包含未跟踪文件）" @keyup.enter="stashPush" />
              <button class="btn btn-primary" :disabled="stashBusy !== ''" @click="stashPush">push</button>
            </div>
          </div>
        </section>

        <!-- ── 远端 ── -->
        <section v-if="activeTab === 'remotes'" class="tab-panel">
          <div class="card">
            <div class="card-head">
              <span class="card-title">远端仓库</span>
              <span class="card-side">{{ remotes.length }} 个</span>
            </div>
            <div v-if="!remotes.length" class="empty">尚未配置远端</div>
            <div v-for="r in remotes" :key="r.name" class="remote-row">
              <div class="remote-main">
                <span class="remote-name mono">{{ r.name }}</span>
                <span class="remote-url mono">{{ r.url }}</span>
                <span class="chip">{{ r.platform }}</span>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">添加远端</span></div>
            <div class="inline-form">
              <input v-model="remoteName" class="text-input mono" placeholder="名称（如 origin）" />
              <input v-model="remoteUrl" class="text-input mono" placeholder="URL（https://… 或 git@…）" @keyup.enter="addRemote" />
              <button class="btn btn-primary" :disabled="remoteBusy !== ''" @click="addRemote">添加</button>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">同步</span></div>
            <div class="sync-block">
              <button class="btn" :disabled="remoteBusy !== ''" @click="doFetch"><CoomiIcon name="refresh" :size="15" />fetch</button>
            </div>
            <div class="inline-form">
              <input v-model="pullRemote" class="text-input mono" placeholder="remote（origin）" />
              <input v-model="pullBranch" class="text-input mono" placeholder="拉取分支（如 main）" @keyup.enter="doPull" />
              <button class="btn btn-primary" :disabled="remoteBusy !== ''" @click="doPull">pull</button>
            </div>
            <div class="inline-form">
              <input v-model="pushRemote" class="text-input mono" placeholder="remote（origin）" />
              <input v-model="pushBranch" class="text-input mono" placeholder="推送分支（如 main）" />
              <input v-model="pushToken" class="text-input mono" type="password" placeholder="Token（可选）" @keyup.enter="doPush" />
              <button class="btn btn-primary" :disabled="remoteBusy !== ''" @click="doPush">push</button>
            </div>
            <p class="form-note">push 时可输入访问令牌，仅本次请求使用，不会写入 remote URL 或凭据文件。</p>
          </div>
        </section>
      </template>

      <p v-if="loading && !status" class="hint">加载中…</p>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px calc(var(--safe-bottom) + 24px); }

/* ── 状态栏 ── */
.status-card { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; padding: 12px 13px; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.status-main { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.branch { display: inline-flex; align-items: center; gap: 6px; color: var(--blue); }
.branch-name { font-size: 14px; font-weight: 650; color: var(--text); }
.ab { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-variant-numeric: tabular-nums; }
.ab-ahead { color: var(--ok); }
.ab-behind { color: var(--warn); }
.version { margin-left: auto; font-size: 11.5px; color: var(--text-3); }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { padding: 2px 8px; border-radius: var(--r-pill); background: var(--blue-soft); color: var(--blue); font-size: 11px; font-weight: 550; }

.init-card { margin-bottom: 10px; padding: 14px; border-radius: var(--r-card); background: var(--orange-soft); color: var(--text-2); }
.init-title { margin: 0 0 4px; font-size: 14px; font-weight: 650; color: var(--orange); }
.init-copy { margin: 0 0 10px; font-size: 12.5px; line-height: 1.65; }
.code-inline { padding: 1px 6px; border-radius: 5px; background: var(--orange-border); font-family: var(--font-mono); font-size: 12px; }
.init-btn { min-height: 36px; padding: 0 14px; font-size: 13px; }

/* ── 提示 ── */
.notice { margin: 0 0 10px; padding: 8px 12px; border-radius: var(--r-sm); background: var(--ok-soft); color: var(--ok); font-size: 12.5px; line-height: 1.5; word-break: break-all; }
.notice.err { background: var(--danger-soft); color: var(--danger); }
.hint { padding: 14px 4px; color: var(--text-3); font-size: 12.5px; text-align: center; }
.hint.dim { padding: 4px; font-size: 11.5px; }
.empty { padding: 16px 4px; color: var(--text-3); font-size: 12.5px; text-align: center; }

/* ── 标签页 ── */
.tabs { display: flex; gap: 4px; margin-bottom: 10px; padding: 4px; border-radius: var(--r-md); background: var(--fill-strong); }
.tab { flex: 1; min-width: 0; min-height: 34px; border-radius: 8px; color: var(--text-2); font-size: 12.5px; font-weight: 550; white-space: nowrap; }
.tab.on { background: var(--bg); color: var(--blue); box-shadow: var(--shadow-1); }
.tab-panel { display: flex; flex-direction: column; gap: 10px; }

/* ── 卡片 ── */
.card { border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.card-head { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 8px 13px; border-bottom: 1px solid var(--border); }
.card-title { font-size: 13.5px; font-weight: 650; color: var(--text); }
.card-side { margin-left: auto; font-size: 12px; color: var(--text-3); }

/* ── 改动分组 ── */
.groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 10px; }
.group-col { border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
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
.ai-card { border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.ai-head { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 8px 11px; flex-wrap: wrap; }
.ai-ic { color: var(--blue); flex-shrink: 0; }
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
.switch i { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .18s; box-shadow: 0 1px 3px rgba(0, 0, 0, .2); }
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

@media (max-width: 430px) {
  .commit-main { grid-template-columns: auto minmax(0, 1fr) auto; }
  .commit-main .author { display: none; }
}
</style>
