import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, RefreshCw, Check } from 'lucide-react'
import { toast } from 'sonner'
import { useEngine } from '../../stores/engine'
import { ipc } from '../../lib/ipc'
import { cn } from '../../lib/cn'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Input, Field } from '../ui/Input'
import { Switch, Spinner } from '../ui/Controls'
import { Select } from '../ui/Select'
import { withDisplayName } from '../../lib/stormProbe'

/**
 * 厂商向导：两步 —— ①连通性与基本信息 ②模型清单与能力。
 *
 * 为什么行要拆成 memo 组件：模型多起来（十几二十个）时，任何一次按键如果让整张表重渲染，
 * 输入就会明显发顿。ModelRow 用**行本地 state** 承接输入，只在失焦/回车时回写上层，
 * 上层回写函数全 useCallback、行 key 用稳定 uid，于是打字时只有当前那一行重渲染。
 */

interface Provider {
  id: string
  name?: string
  model?: string
  active?: boolean
  type?: string
  baseUrl?: string
  models?: string[]
  modelContextWindows?: Record<string, number>
  modelDescriptions?: Record<string, string>
  modelParameters?: Record<string, { max_output_tokens?: number }>
  capabilityOverrides?: Record<string, Record<string, boolean>>
}

/** 每行一个稳定 id：手填的行 id 可能为空串，直接用 id 当 key 会撞。 */
interface ModelDraft {
  uid: string
  id: string
  name: string
  context: string
  maxOutput: string
  caps: Record<string, boolean>
}

const CAPS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'reasoning', label: '推理', hint: '模型支持思维链输出' },
  { key: 'vision', label: '视觉', hint: '支持图片输入' },
  { key: 'webSearch', label: '联网', hint: '支持联网检索' },
  { key: 'tools', label: '工具', hint: '支持函数调用' },
  { key: 'cache', label: '缓存', hint: '支持上下文缓存' },
]

/* 接口类型：**这里的 value 必须与引擎的白名单逐字一致**
   （apps/coomi-rs/ui/src/web/mod.rs 的 upsert_provider）：
   openai_compatible / openai_responses / anthropic_messages / gemini_native。
   2026-09-29 真机事故：这里以前是 openai / anthropic / gemini / custom 这套 UI 值，直接当
   type 发给引擎 → 新建厂商必然 HTTP 400 "unsupported provider compatibility mode"
   （只有「编辑」老厂商时因为回填的是规范值才侥幸能过）。两边从此一一对应。 */
const TYPES = [
  { value: 'openai_compatible', label: 'OpenAI 兼容' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic_messages', label: 'Anthropic' },
  { value: 'gemini_native', label: 'Gemini' },
]

/** 老配置里可能存着历史 UI 值（openai/custom…）：读进来时归一到引擎规范名，
    否则下拉会显示空白，且再存一次又会被引擎拒。 */
const LEGACY_TYPES: Record<string, string> = {
  openai: 'openai_compatible',
  custom: 'openai_compatible',
  anthropic: 'anthropic_messages',
  gemini: 'gemini_native',
}
function normalizeEngineType(value: string | undefined | null): string {
  const text = (value ?? '').trim()
  if (TYPES.some((type) => type.value === text)) return text
  return LEGACY_TYPES[text.toLowerCase()] ?? 'openai_compatible'
}

/* ── 厂商标识（id）──
   界面上的「厂商名称」是给人看的，引擎要的是 id（providers.json 的键、切换模型 / 拉取模型 /
   删除接口都按它走）。向导以前只发 name 不发 id，于是**新建厂商永远停在引擎的第一条校验**
   "provider id is required" 上（2026-09-29）。现在前端自己按名称生成一个：
     · 英文/数字 → slug（小写、非字母数字折叠成 -）；
     · 中文或纯符号 → slug 为空 → 退回 provider-<时间戳后 6 位>；
     · 与已有 id 撞 → 依次追加 -2、-3…
   引擎侧也有一份等价兜底（任何客户端漏发 id 都不会再撞墙）。 */
function slugifyProviderId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
}

function uniqueProviderId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix <= 100; suffix += 1) {
    const candidate = base + '-' + suffix
    if (!taken.has(candidate)) return candidate
  }
  return base + '-' + String(Date.now()).slice(-6)
}

/** 新建厂商时用的标识；编辑态永远沿用原来的 id（改 id 等于新建另一个厂商）。 */
function providerIdFor(name: string, taken: ReadonlySet<string>): string {
  const slug = slugifyProviderId(name)
  const base = slug || 'provider-' + String(Date.now()).slice(-6)
  return uniqueProviderId(base, taken)
}

/** 上下文窗口的合法区间（与引擎 validate 的 32000..=1048576 同一口径）。 */
const CONTEXT_MIN = 32_000
const CONTEXT_MAX = 1_048_576

/** 本机地址（本机服务通常不需要 API Key，引擎侧同样放行）。 */
function isLoopbackBase(url: string): boolean {
  const match = url.trim().match(/^https?:\/\/([^/?#]+)/i)
  if (!match) return false
  const host = match[1].split('@').pop()!.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
}

/** 引擎的英文错误 → 能照着改的中文（2026-09-29：以前原样弹「HTTP 400 {...}」，用户读不出该改哪一格）。 */
const ERROR_HINTS: Array<{ match: RegExp; hint: string }> = [
  {
    match: /unsupported provider compatibility mode/i,
    hint: '接口类型不受支持。请选：OpenAI 兼容 / OpenAI Responses / Anthropic / Gemini（引擎只认这四个规范名）。',
  },
  {
    match: /model context window must be between/i,
    hint: '上下文窗口必须在 32000 ~ 1048576 之间（第二步每个模型的「上下文 token」那一格）。',
  },
  {
    match: /provider must have an API key before activation/i,
    hint: '这个地址需要 API Key 才能设为当前厂商；本机地址（127.0.0.1 / localhost）可以不填。',
  },
  {
    match: /provider must have a model before activation/i,
    hint: '还没有可用模型：先在第二步「拉取模型」或「手动添加」至少一个模型。',
  },
  {
    match: /active provider cannot have an empty model list/i,
    hint: '当前厂商的模型列表不能为空。',
  },
  {
    match: /provider id is required/i,
    hint: '厂商标识没生成出来（它按厂商名称自动生成）。请把名称改成含字母或数字的形式再保存，或把这个提示发给我们。',
  },
  {
    match: /base URL is required/i,
    hint: '接口地址（Base URL）不能为空。',
  },
]

/** 把引擎原文翻成「可照做」的一句；认不出来时原样带上，至少不丢信息。 */
function explainProviderError(raw: string): string {
  for (const entry of ERROR_HINTS) {
    if (entry.match.test(raw)) return entry.hint + '（引擎原文：' + raw + '）'
  }
  return raw
}

let uidSeed = 0
const nextUid = (): string => 'm' + (++uidSeed) + '-' + Math.random().toString(36).slice(2, 7)

function toDraft(id: string, provider: Provider | null): ModelDraft {
  return {
    uid: nextUid(),
    id,
    name: provider?.modelDescriptions?.[id] ?? '',
    context: provider?.modelContextWindows?.[id] ? String(provider.modelContextWindows[id]) : '',
    maxOutput: provider?.modelParameters?.[id]?.max_output_tokens ? String(provider.modelParameters[id]?.max_output_tokens) : '',
    caps: { ...Object.fromEntries(CAPS.map(cap => [cap.key, cap.key !== "vision"])), ...(provider?.capabilityOverrides?.[id] ?? {}) },
  }
}

/** 单行模型：本地 state 承接输入，失焦/回车才回写上层（打字时不惊动整张表）。 */
const ModelRow = (props: {
  row: ModelDraft
  isDefault: boolean
  expanded: boolean
  onPatch: (uid: string, patch: Partial<ModelDraft>) => void
  onRemove: (uid: string) => void
  onDefault: (id: string) => void
  onToggleExpand: (uid: string) => void
}) => {
  const { row, isDefault, expanded, onPatch, onRemove, onDefault, onToggleExpand } = props
  const [local, setLocal] = useState({ id: row.id, name: row.name, context: row.context, maxOutput: row.maxOutput })

  // 外部（重新拉取模型列表）换过这一行时同步一次，避免显示旧值。
  useEffect(() => {
    setLocal({ id: row.id, name: row.name, context: row.context, maxOutput: row.maxOutput })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.uid])

  const flush = (): void => {
    if (local.id !== row.id || local.name !== row.name || local.context !== row.context || local.maxOutput !== row.maxOutput) {
      onPatch(row.uid, local)
    }
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') { e.preventDefault(); flush() }
    if (e.key === 'Escape') setLocal({ id: row.id, name: row.name, context: row.context, maxOutput: row.maxOutput })
  }

  const activeCount = CAPS.filter((c) => row.caps[c.key]).length
  // 上下文窗口越界就地提示（引擎只接受 32000~1048576，越界保存时会被夹紧）
  const contextValue = Number(local.context)
  const contextOutOfRange = local.context.trim() !== ''
    && Number.isFinite(contextValue)
    && contextValue > 0
    && (contextValue < CONTEXT_MIN || contextValue > CONTEXT_MAX)

  return (
    <>
      <tr className='border-b border-line-soft last:border-b-0 hover:bg-hover'>
        <td className='px-2 py-1.5'>
          <button
            type='button'
            title={isDefault ? '当前默认模型' : '设为当前模型'}
            aria-label='设为当前模型'
            onClick={() => onDefault(local.id || row.id)}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-full border transition-colors',
              isDefault ? 'border-primary bg-primary text-primary-ink' : 'border-line-strong text-transparent hover:border-primary',
            )}
          >
            <Check size={12} />
          </button>
        </td>
        <td className='px-2 py-1.5'>
          <Input
            value={local.id}
            onKeyDown={onKey}
            onChange={(e) => setLocal((s) => ({ ...s, id: e.target.value }))}
            onBlur={flush}
            className='h-8 font-mono text-12'
            aria-label='模型 ID'
          />
        </td>
        <td className='px-2 py-1.5'>
          <Input
            value={local.name}
            onKeyDown={onKey}
            onChange={(e) => setLocal((s) => ({ ...s, name: e.target.value }))}
            onBlur={flush}
            className='h-8 text-12'
            placeholder='显示名称（可留空）'
            aria-label='显示名称'
          />
        </td>
        <td className='px-2 py-1.5'>
          <Input
            value={local.context}
            onKeyDown={onKey}
            onChange={(e) => setLocal((s) => ({ ...s, context: e.target.value.replace(/[^0-9]/g, '') }))}
            onBlur={flush}
            className={cn('h-8 text-12 tabular-nums', contextOutOfRange && 'border-warn')}
            placeholder='≥ 32000'
            aria-label='上下文长度'
            title={contextOutOfRange
              ? '上下文窗口要在 32000 ~ 1048576 之间；保存时会自动夹到这个区间'
              : '模型的上下文窗口（token）'}
          />
          {contextOutOfRange ? <p className='mt-0.5 text-11 text-warn'>区间 32000~1048576</p> : null}
        </td>
        <td className='px-2 py-1.5'>
          <Input
            value={local.maxOutput}
            onKeyDown={onKey}
            onChange={(e) => setLocal((s) => ({ ...s, maxOutput: e.target.value.replace(/[^0-9]/g, '') }))}
            onBlur={flush}
            className='h-8 text-12 tabular-nums'
            placeholder='最长输出'
            aria-label='最长输出'
          />
        </td>
        <td className='px-2 py-1.5'>
          <button
            type='button'
            onClick={() => onToggleExpand(row.uid)}
            className='flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-12 text-ink-3 hover:bg-hover hover:text-ink'
          >
            <span>{activeCount ? activeCount + ' 项能力' : '默认能力'}</span>
          </button>
        </td>
        <td className='px-2 py-1.5 text-right'>
          <Button variant='ghost' size='icon-sm' title='删除这个模型' onClick={() => onRemove(row.uid)}>
            <Trash2 size={13} className='text-ink-3 hover:text-danger' />
          </Button>
        </td>
      </tr>
      {expanded ? (
        <tr className='border-b border-line-soft bg-muted/40'>
          <td colSpan={7} className='px-3 py-2'>
            <div className='flex flex-wrap items-center gap-x-5 gap-y-2'>
              <span className='text-12 text-ink-3'>能力开关</span>
              {CAPS.map((c) => (
                <label key={c.key} className='flex items-center gap-2 text-12 text-ink-2' title={c.hint}>
                  <Switch
                    checked={!!row.caps[c.key]}
                    onCheckedChange={(v) => onPatch(row.uid, { caps: { ...row.caps, [c.key]: v } })}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

const MemoModelRow = ModelRow

export function ProviderWizard({ open, onOpenChange, editing, onSaved, existingIds }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  editing: Provider | null
  onSaved: () => void
  /** 已有厂商的 id 列表：新建时用来给自动生成的标识避重（见 providerIdFor）。 */
  existingIds?: string[]
}) {
  const api = useEngine((s) => s.api)
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [type, setType] = useState('openai_compatible')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [modelIds, setModelIds] = useState<string[]>([])
  const [rows, setRows] = useState<ModelDraft[]>([])
  const discoveredEfforts = useRef<Record<string, string[]>>({})
  const [expanded, setExpanded] = useState<string>('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const draftsRef = useRef<Record<string, Partial<ModelDraft>>>({})

  // 打开时按「正在编辑的那一条」重置；editing 由上层 memo，所以同一条厂商不会反复重置。
  useEffect(() => {
    if (!open) return
    setStep(0)
    setError('')
    setNotice('')
    setBusy('')
    setExpanded('')
    draftsRef.current = {}
    if (editing) {
      setName(editing.name ?? '')
      setType(normalizeEngineType(editing.type))
      setBaseUrl(editing.baseUrl ?? '')
      setApiKey('')
      const list = editing.models?.length ? editing.models : editing.model ? [editing.model] : []
      setModel(editing.model ?? '')
      setModelIds(list)
      setRows(list.map((id) => toDraft(id, editing)))
    } else {
      setName('')
      setType('openai_compatible')
      setBaseUrl('')
      setApiKey('')
      setModel('')
      setModelIds([])
      setRows([])
    }
  }, [open, editing])

  const patch = useCallback((uid: string, p: Partial<ModelDraft>) => {
    draftsRef.current[uid] = { ...(draftsRef.current[uid] ?? {}), ...p }
    setRows((list) => list.map((r) => (r.uid === uid ? { ...r, ...p } : r)))
  }, [])
  const removeRow = useCallback((uid: string) => {
    delete draftsRef.current[uid]
    setRows((list) => list.filter((r) => r.uid !== uid))
  }, [])
  const toggleExpand = useCallback((uid: string) => {
    setExpanded((cur) => (cur === uid ? '' : uid))
  }, [])

  /** 拉取模型清单。
      2026-09-29：以前这里对**新厂商**直接拦掉（"先保存一次再回来拉取"），用户被迫
      「随手填一个模型 ID → 保存 → 再编辑 → 再拉取」。现在新厂商走
      /api/providers/discover-models-preview —— 用第一步填的地址+Key 直接探上游，
      **不落盘、不改配置**；已有厂商仍走原来那条（能顺便把清单写回配置）。 */
  const discover = async (): Promise<void> => {
    if (!editing?.id && !baseUrl.trim()) {
      setNotice('先把接口地址填上，才能向上游拉取模型清单')
      setStep(0)
      return
    }
    setBusy('discover'); setError(''); setNotice('')
    try {
      const res = editing?.id
        ? await api<{ models?: string[] }>('/api/providers/' + encodeURIComponent(editing.id) + '/discover-models', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persist: true }),
          })
        : await api<{ models?: string[]; note?: string }>('/api/providers/discover-models-preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() }),
          })
      const metadata = (res as { metadata?: Record<string, { contextWindow?: number; maxOutputTokens?: number; vision?: boolean; reasoningEfforts?: string[] }> }).metadata ?? {}
      for (const [id, meta] of Object.entries(metadata)) { if (meta.reasoningEfforts?.length) discoveredEfforts.current[id] = meta.reasoningEfforts }
      const ids = res.models ?? []
      setModelIds(ids)
      setRows((list) => {
        const known = new Set(list.map((r) => r.id))
        const added = ids.filter((id) => !known.has(id)).map((id) => {
          const row = toDraft(id, editing)
          const meta = metadata[id]
          if (meta?.contextWindow && !row.context) row.context = String(meta.contextWindow)
          if (meta?.maxOutputTokens && !row.maxOutput) row.maxOutput = String(meta.maxOutputTokens)
          if (typeof meta?.vision === "boolean") row.caps.vision = meta.vision
          return row
        })
        return [...list, ...added]
      })
      const note = (res as { note?: string }).note ?? ''
      setNotice(ids.length
        ? '已拉取 ' + ids.length + ' 个模型' + (note ? '（' + note + '）' : '')
        : (note || '上游没有返回模型清单：可以点「手动添加」直接填模型 ID'))
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setError('拉取失败：' + explainProviderError(raw) + '（也可以点「手动添加」直接填模型 ID）')
    } finally { setBusy('') }
  }

  /** 这一条最终会用的标识：编辑态＝原 id；新建＝按名称生成（并在已有 id 之间避重）。 */
  const currentId = useMemo(
    () => editing?.id ?? providerIdFor(name, new Set(existingIds ?? [])),
    [editing?.id, name, existingIds],
  )

  const save = async (): Promise<void> => {
    // 提交前把未失焦的草稿合并进来，避免「打完字直接点保存」丢最后一笔输入。
    const merged = rows.map((r) => ({ ...r, ...(draftsRef.current[r.uid] ?? {}) }))
    const ids = merged.map((r) => r.id.trim()).filter(Boolean)
    /* 提交前**一次列全**所有问题（2026-09-29 的教训：以前是修一个冒一个 ——
       引擎先拦 id、再拦接口类型、再拦上下文窗口，用户一次只看到一条）。
       这里本地先查一遍，把能查出来的都摆出来，再决定要不要发请求。 */
    const problems: string[] = []
    if (!name.trim()) problems.push('厂商名称为空')
    if (!baseUrl.trim()) problems.push('接口地址（Base URL）为空')
    if (!currentId) problems.push('厂商标识生成失败（请手工改一个名称后重试）')
    if (!ids.length) problems.push('还没有模型（第二步至少保留一个）')
    const outOfRange = merged
      .filter((r) => {
        const value = Number(r.context)
        return r.context.trim() !== '' && Number.isFinite(value) && value > 0 && (value < CONTEXT_MIN || value > CONTEXT_MAX)
      })
      .map((r) => r.id.trim() || '(未命名模型)')
    if (outOfRange.length) problems.push('上下文窗口越界（保存时会自动夹到 32000~1048576）：' + outOfRange.join('、'))
    // 越界会被夹紧，不算阻塞；其余问题阻塞提交。
    const blocking = problems.filter((text) => !text.startsWith('上下文窗口越界'))
    if (blocking.length) {
      setError('还不能保存：' + blocking.join('；'))
      if (!name.trim() || !baseUrl.trim() || !currentId) setStep(0)
      return
    }

    const modelDescriptions: Record<string, string> = {}
    const modelContextWindows: Record<string, number> = {}
    const modelParameters: Record<string, { max_output_tokens?: number }> = { ...(editing?.modelParameters ?? {}) }
    const capabilityOverrides: Record<string, Record<string, boolean>> = {}
    /// 被夹紧过的上下文窗口（保存后如实告诉用户改了哪几个）。
    const adjusted: string[] = []
    for (const r of merged) {
      const id = r.id.trim()
      if (!id) continue
      if (r.name.trim()) modelDescriptions[id] = r.name.trim()
      const ctx = Number(r.context)
      if (Number.isFinite(ctx) && ctx > 0) {
        // 引擎只接受 32000~1048576，越界以前直接 400（用户完全看不出是哪一格的问题）。
        // 现在按区间夹紧，并把「改过哪几个模型」在保存后如实提示。
        const fixed = Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, Math.round(ctx)))
        modelContextWindows[id] = fixed
        if (fixed !== Math.round(ctx)) adjusted.push(id + ' ' + Math.round(ctx) + ' → ' + fixed)
      }
      const out = Number(r.maxOutput)
      if (Number.isFinite(out) && out > 0) {
        modelParameters[id] = { ...(modelParameters[id] ?? {}), max_output_tokens: out }
      }
      const on = Object.entries(r.caps).filter(([, v]) => v).map(([k]) => k)
      if (on.length !== CAPS.length) {
        const all: Record<string, boolean> = {}
        for (const c of CAPS) all[c.key] = !!r.caps[c.key]
        capabilityOverrides[id] = all
      }
    }
    for (const id of ids) {
      const levels = discoveredEfforts.current[id]
      if (levels?.length && type.startsWith("openai") && !(modelParameters[id] as Record<string, unknown> | undefined)?.reasoningMapping) {
        const mapping = Object.fromEntries(levels.filter(level => ["low", "medium", "high", "xhigh", "ultra"].includes(level)).map(level => [level, level]))
        if (Object.keys(mapping).length) modelParameters[id] = { ...modelParameters[id], reasoningField: type.includes("responses") ? "reasoning.effort" : "reasoning_effort", reasoningMapping: mapping } as typeof modelParameters[string]
      }
    }
    const current = model.trim() && ids.includes(model.trim()) ? model.trim() : ids[0]
    /* activate：有 API Key 才自动设为当前厂商；没 key 时只有**本机地址**才激活
       （引擎侧同样只对本机地址放行）—— 否则会撞上
       "provider must have an API key before activation"，本地模型这条路就堵死了。 */
    const wantActivate = !!apiKey.trim() || isLoopbackBase(baseUrl)
    // 生成的标识也回显一次：用户以后在配置文件 / 日志里看到的就是它。
    if (!editing?.id && currentId !== slugifyProviderId(name)) {
      setNotice('厂商标识：' + currentId + '（按名称自动生成）')
    }

    setBusy('save'); setError('')
    try {
      const body: Record<string, unknown> = {
        // 一定要带上 id：引擎按它做 providers.json 的键（以前这里是 editing?.id，
        // 新建时是 undefined → 键被 JSON.stringify 丢掉 → 引擎 400 provider id is required）。
        id: currentId,
        name: name.trim(),
        type,
        baseUrl: baseUrl.trim(),
        model: current,
        models: ids,
        modelDescriptions,
        modelContextWindows,
        modelParameters,
        capabilityOverrides,
        activate: wantActivate,
      }
      if (apiKey.trim()) body.apiKey = apiKey.trim()
      await api('/api/providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      onSaved()
      onOpenChange(false)
      if (!wantActivate) {
        toast.message('已保存 ' + (name.trim() || '这个厂商') + '，但还没设为当前厂商', {
          description: '没填 API Key。云端接口需要 Key 才能激活；本机地址（127.0.0.1 / localhost）不需要。',
          duration: 9000,
        })
      }
      if (adjusted.length) {
        toast.message('已把超出范围的上下文窗口夹到 32000~1048576', {
          description: adjusted.slice(0, 4).join('；') + (adjusted.length > 4 ? ' 等 ' + adjusted.length + ' 个模型' : ''),
          duration: 9000,
        })
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setError('保存失败：' + explainProviderError(raw))
      // 留现场：诊断文件会带上这条（脱敏——只记有没有 key，不记 key 本身）。
      void ipc('frontend_note', {
        scope: editing ? '编辑厂商' : '添加厂商',
        message: JSON.stringify({
          id: editing?.id ?? '',
          type,
          baseUrl: baseUrl.trim(),
          models: ids.length,
          hasKey: !!apiKey.trim(),
          hasId: !!currentId,
          activate: wantActivate,
        }) + ' | ' + raw.slice(0, 400),
      }).catch(() => { /* 不在壳里（浏览器调试）时忽略 */ })
    } finally { setBusy('') }
  }

  const rowNodes = useMemo(() => rows.map((r) => (
    <MemoModelRow
      key={r.uid}
      row={r}
      isDefault={(model || modelIds[0]) === r.id}
      expanded={expanded === r.uid}
      onPatch={patch}
      onRemove={removeRow}
      onDefault={(id) => setModel(id)}
      onToggleExpand={toggleExpand}
    />
  )), [rows, model, modelIds, expanded, patch, removeRow, toggleExpand])

  const footer = step === 0 ? (
    <div className='flex items-center gap-2'>
      <Button variant='ghost' size='sm' onClick={() => onOpenChange(false)}>取消</Button>
      <span className='flex-1' />
      <Button variant='primary' size='sm' onClick={() => { setError(''); setStep(1) }} disabled={!name.trim() || !baseUrl.trim()}>
        下一步
      </Button>
    </div>
  ) : (
    <div className='flex items-center gap-2'>
      <Button variant='ghost' size='sm' onClick={() => setStep(0)}>上一步</Button>
      <span className='flex-1' />
      <Button variant='secondary' size='sm' onClick={() => void discover()} disabled={busy === 'discover'}>
        {busy === 'discover' ? <Spinner /> : <RefreshCw size={13} />} 拉取模型清单
      </Button>
      <Button variant='primary' size='sm' onClick={() => void save()} disabled={busy === 'save'}>
        {busy === 'save' ? <Spinner /> : null} 保存
      </Button>
    </div>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? '编辑厂商' : '添加厂商'}
      description={step === 0 ? '第 1 步 / 2 · 连通性与基本信息' : '第 2 步 / 2 · 模型清单与能力'}
      width={Math.min(1040, typeof window === 'undefined' ? 1040 : window.innerWidth - 48)}
      footer={footer}
    >
      {error ? <p className='mb-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-12 text-danger'>{error}</p> : null}
      {notice ? <p className='mb-2 text-12 text-ink-3'>{notice}</p> : null}

      {step === 0 ? (
        <div className='flex flex-col gap-3'>
          <Field label='厂商名称'>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='例如 Agnes' />
          </Field>
          <Field label='接口类型'>
            <Select value={type} onChange={setType} options={TYPES} width={220} />
          </Field>
          {/* 标识：引擎内部用它（配置文件的键、切换/拉取/删除接口）。新建时自动生成、
              不可编辑；编辑已有厂商时显示原值。用户不必理解它，但要能在日志里对上。 */}
          <Field label='标识（自动生成）' hint='配置文件与接口里用的键，保存后不可修改'>
            <Input
              value={currentId}
              readOnly
              aria-label='厂商标识'
              className='h-8 font-mono text-12 text-ink-3'
              title='按厂商名称自动生成；中文名会退回 provider-<时间>，重名自动加 -2'
            />
          </Field>
          <Field label='接口地址（Base URL）'>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder='https://example.com/v1' className='font-mono text-12' />
          </Field>
          <Field label='API Key' hint={editing ? '留空表示不修改已保存的密钥' : undefined}>
            <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type='password' placeholder='sk-...' className='font-mono text-12' />
          </Field>
        </div>
      ) : (
        <div className='flex flex-col gap-2'>
          <div className='flex items-center gap-2 text-12 text-ink-3'>
            <span>共 {rows.length} 个模型</span>
            <span className='flex-1' />
            <Button
              variant='ghost' size='sm'
              onClick={() => {
                const uid = nextUid()
                patch(uid, { id: '', name: '', context: '', maxOutput: '', caps: {} })
                setRows((list) => [...list, { uid, id: '', name: '', context: '', maxOutput: '', caps: {} }])
              }}
            >
              <Plus size={13} /> 手动添加
            </Button>
          </div>
          <div className='max-h-[52vh] overflow-auto rounded-md border border-line'>
            <table className='w-full min-w-[900px] table-fixed'>
              <colgroup>
                <col style={{ width: 44 }} />
                <col style={{ width: 168 }} />
                <col />
                <col style={{ width: 112 }} />
                <col style={{ width: 104 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 72 }} />
              </colgroup>
              <thead className='sticky top-0 z-10 bg-muted'>
                <tr className='border-b border-line text-left text-12 text-ink-3'>
                  <th className='px-2 py-2 font-normal'>默认</th>
                  <th className='px-2 py-2 font-normal'>模型 ID</th>
                  <th className='px-2 py-2 font-normal'>显示名称</th>
                  <th className='px-2 py-2 font-normal'>上下文</th>
                  <th className='px-2 py-2 font-normal'>最长输出</th>
                  <th className='px-2 py-2 font-normal'>能力</th>
                  <th className='px-2 py-2 text-right font-normal'>操作</th>
                </tr>
              </thead>
              <tbody>{rowNodes}</tbody>
            </table>
          </div>
          {!rows.length ? <p className='py-6 text-center text-12 text-ink-4'>还没有模型，点「拉取模型清单」或「手动添加」</p> : null}
        </div>
      )}
    </Dialog>
  )
}

/* #185 的报错栈里显示真名（生产构建会压掉函数名） */
withDisplayName(ProviderWizard, 'ProviderWizard')
