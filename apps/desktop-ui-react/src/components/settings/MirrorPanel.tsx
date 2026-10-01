/** 下载与镜像：设置页「引擎与诊断」分组下的一个 Section。
 *
 *  为什么归在「引擎与诊断」下面：镜像源不是终端用户的日常设置，而是引擎派发的子进程
 *  下载东西时走的线路（git 克隆 / Release 下载、npm·pnpm 装包、pip·uv 装 Python 包）。
 *  它只影响引擎自己拉起的子进程，**不改系统或用户级的全局配置**——面板底部那句说明就是它。
 *
 *  引擎接口（apps/coomi-rs/ui/src/web/api/mirrors.rs）：
 *   · GET /api/settings/mirrors → 统一契约
 *       { "kinds": { "github": {"active":"gh-proxy","items":[{id,label,url,type,enabled}]},
 *                    "npm": {...}, "pip": {...}, "docker": {...} },
 *         "custom": [ ... ], "updatedAt": 1730000000000,
 *         "builtin": { ...同 kinds 的旧形状... } }        ← 旧字段保留，前端也要认
 *   · PUT /api/settings/mirrors ← **部分更新**：只给改动的那一类
 *       { "kinds": { "npm": { "active": "...", "items": [...], "remove": ["id"] } } }
 *     旧契约写法（分组放在顶层 { "npm": {...} }）仍然接受，所以前端按 GET 回来的形状回写。
 *   · POST /api/runtime/mirror-test ← 单条测速 {type,url} → {ok,ttfb_ms,status,error}
 *
 *  三条硬规则（都是踩过的坑）：
 *   ① **按 kinds 解析**，认不出结构才退回 builtin / mirrors 旧形状，最后才是前端内置参考清单；
 *   ② **只要拿到了数据，「+ 新增源」就必须可用**——不能因为清单为空/结构没读全就把写操作全禁掉；
 *   ③ **PUT 的部分更新只用引擎回传的归一化结果刷新界面**，失败时显示引擎的原话（不笼统降级）。
 *
 *  一行就是一条源：状态灯 + 名称 + URL + TTFB + 启停开关 + 上下排序 + 删除；
 *  按类型分组（GitHub 加速 / npm / pip·uv / Docker）。「自动选择最快」可撤销；
 *  「恢复官方源」把每种类型切回官方项。排序与删除都可能被引擎拒绝（内置条目不能删除、
 *  排序取决于引擎实现）：这种情况如实说出来，不假装成功。
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle, ArrowDown, ArrowUp, Gauge, Plus, RefreshCw, RotateCcw, Sparkles, Trash2,
} from 'lucide-react'
import { Empty, Section } from '../ui/Card'
import { Button } from '../ui/Button'
import { Badge, Input } from '../ui/Input'
import { Segmented, SkeletonRows, Spinner, Switch } from '../ui/Controls'
import { isUnsupportedReply, replyMessage } from '../skills/installClient'
import { cn } from '../../lib/cn'
import { useEngine } from '../../stores/engine'
import { withDisplayName } from '../../lib/stormProbe'
import { useUi } from '../../stores/ui'

/* ── 类型 ── */

type MirrorKind = 'github' | 'npm' | 'pip' | 'docker' | 'other'

/** 分组顺序＝界面顺序，也是引擎注入源时的优先顺序。other 只在引擎返回未知类型时出现。 */
const KIND_ORDER: MirrorKind[] = ['github', 'npm', 'pip', 'docker', 'other']

/** 引擎真正认识的分类（'other' 写不回去，只能展示）。 */
const WRITABLE_KINDS: MirrorKind[] = ['github', 'npm', 'pip', 'docker']

const KIND_META: Record<MirrorKind, { label: string; hint: string }> = {
  github: { label: 'GitHub 加速', hint: 'git 克隆、Release 与源码包下载' },
  npm: { label: 'npm', hint: 'npm / pnpm / npx 的 registry' },
  pip: { label: 'pip · uv', hint: 'Python 包索引（pip install / uv add）' },
  docker: { label: 'Docker', hint: 'Docker Hub 加速（引擎只展示，daemon.json 要自己写）' },
  other: { label: '其他', hint: '引擎返回了未标注类型的源：引擎不认识这一类，改不了' },
}

const KIND_ALIASES: Record<string, MirrorKind> = {
  github: 'github', gh: 'github', git: 'github', git_proxy: 'github', github_proxy: 'github', ghproxy: 'github',
  npm: 'npm', node: 'npm', nodejs: 'npm', pnpm: 'npm', yarn: 'npm', registry: 'npm',
  pip: 'pip', pypi: 'pip', python: 'pip', uv: 'pip', index: 'pip',
  docker: 'docker', dockerhub: 'docker', docker_hub: 'docker', hub: 'docker',
}

/** GET 回来的清单长什么样：决定 PUT 用哪种 body（新契约 kinds / 旧契约顶层分组）。 */
type Contract = 'kinds' | 'legacy' | 'none'

interface MirrorItem {
  id: string
  kind: MirrorKind
  label: string
  url: string
  enabled: boolean
  /** 官方源：不可删除，「恢复官方源」就是切回它。 */
  official: boolean
  /** 引擎内置清单里的条目（内置条目只能停用，删不掉）。 */
  builtin: boolean
  /** 用户自己加的。 */
  custom: boolean
  status: 'unknown' | 'ok' | 'fail' | 'testing'
  /** 最近一次测速的首字节延迟（毫秒）；没测过是 null。 */
  ttfbMs: number | null
  /** 最近一次测速失败时引擎的原话。 */
  probeError: string
  /** 引擎返回的原始对象：PUT 时原样带回去，不丢我们不认识的键。 */
  raw: Record<string, unknown>
}

interface Snapshot {
  items: MirrorItem[]
  /** 每种类型当前生效的源 id；引擎一定会给一个（它不会存空串）。 */
  active: Partial<Record<MirrorKind, string>>
  /** 引擎回传的更新时间（已格式化，空串＝没给）。 */
  updatedAt: string
  contract: Contract
}

/** 一类镜像的部分更新：items 是该类的完整列表（upsert / replace 两种引擎实现都成立），remove 是要删的 id。 */
interface GroupPatch {
  active?: string
  items?: MirrorItem[]
  remove?: string[]
}

interface Reply<T> {
  status: number
  ok: boolean
  data: T | null
  text: string
  networkError: string
}

/* ── 请求底座 ──
   不用 stores/engine 的 api()：它把非 2xx 压成一行字符串，404 就分不出来了，
   而这里的降级判断恰恰全靠 404。二十来行的事，不再为此单开一个文件。 */
async function request<T>(path: string, init?: RequestInit): Promise<Reply<T>> {
  const engine = useEngine.getState()
  if (!engine.port) {
    return { status: 0, ok: false, data: null, text: '', networkError: '引擎还没有就绪（拿不到端口）' }
  }
  try {
    const res = await fetch('http://127.0.0.1:' + engine.port + path, {
      ...init,
      headers: engine.authHeaders(init?.headers as Record<string, string> | undefined),
    })
    const text = await res.text().catch(() => '')
    let data: T | null = null
    if (text) {
      try { data = JSON.parse(text) as T } catch { data = null }
    }
    return { status: res.status, ok: res.ok, data, text, networkError: '' }
  } catch (error) {
    return {
      status: 0, ok: false, data: null, text: '',
      networkError: error instanceof Error ? error.message : String(error),
    }
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function asMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Math.max(0, Math.round(Number(value)))
  return null
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeKind(raw: unknown, url: string): MirrorKind {
  const text = asText(raw).trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (KIND_ALIASES[text]) return KIND_ALIASES[text]
  const lower = url.toLowerCase()
  if (lower.includes('github')) return 'github'
  if (lower.includes('npm')) return 'npm'
  if (lower.includes('pypi') || lower.includes('python')) return 'pip'
  if (lower.includes('docker') || lower.includes('registry-1')) return 'docker'
  // 引擎没标类型又认不出 URL：未知类型交给 other 组兜底（别混进 GitHub 加速里）。
  return 'other'
}

/** 引擎侧的条目 → 界面条目。字段名同时认 snake_case 与 camelCase，少一个就整条丢是更糟的错。 */
function parseItem(value: unknown, index: number, fallbackKind: MirrorKind | undefined): MirrorItem | null {
  if (!isRecord(value)) return null
  const url = asText(value.url) || asText(value.base) || asText(value.href) || asText(value.index)
  const label = asText(value.label) || asText(value.name) || asText(value.id) || url
  if (!url && !label) return null
  const id = asText(value.id) || asText(value.key) || label || 'mirror-' + index
  const statusText = asText(value.status).toLowerCase()
  const status: MirrorItem['status'] = value.ok === true || value.healthy === true || statusText === 'ok'
    ? 'ok'
    : value.ok === false || value.healthy === false || statusText === 'fail' || statusText === 'error'
      ? 'fail'
      : 'unknown'
  const explicitKind = asText(value.type) || asText(value.kind) || asText(value.category) || asText(value.group)
  const customFlag = value.custom === true || value.user === true || value.source === 'custom' || asBool(value.builtin) === false
  return {
    id,
    label,
    url,
    kind: explicitKind ? normalizeKind(explicitKind, url) : fallbackKind ?? normalizeKind('', url),
    enabled: value.enabled !== false && value.disabled !== true,
    official: value.official === true || value.is_official === true || value.builtin_official === true
      || id.trim().toLowerCase() === 'official' || /官方|official/i.test(label),
    builtin: !customFlag,
    custom: customFlag,
    status,
    ttfbMs: asMs(value.ttfb_ms ?? value.ttfbMs ?? value.latency_ms ?? value.latencyMs ?? value.ms),
    probeError: asText(value.error),
    raw: value,
  }
}

/** updatedAt 可能是 epoch 毫秒、也可能是 ISO 字符串：能格式化就格式化，不行就原样显示。 */
function formatUpdatedAt(value: unknown): string {
  const ms = asMs(value)
  if (ms !== null && ms > 1_000_000_000_000) return new Date(ms).toLocaleString('zh-CN')
  const text = asText(value)
  if (!text) return ''
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString('zh-CN') : text
}

function parseGroupItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (isRecord(raw)) {
    if (Array.isArray(raw.items)) return raw.items
    if (Array.isArray(raw.mirrors)) return raw.mirrors
    if (Array.isArray(raw.list)) return raw.list
  }
  return []
}

/** 引擎侧的一类镜像：{active, items:[…]}；也认 items 叫 mirrors / list 的写法。 */
function parseGroup(raw: unknown, kind: MirrorKind | undefined, out: MirrorItem[], seen: Set<string>): void {
  if (!isRecord(raw)) return
  const list = parseGroupItems(raw)
  list.forEach((entry, index) => {
    const item = parseItem(entry, index, kind)
    if (item) pushItem(item, out, seen)
  })
}

function pushItem(item: MirrorItem, out: MirrorItem[], seen: Set<string>): void {
  const key = item.id.trim().toLowerCase()
  if (key && seen.has(key)) return
  if (key) seen.add(key)
  out.push(item)
}

/**
 * 解析 GET /api/settings/mirrors 的返回。
 * 优先统一契约的 kinds；没有才退回 builtin / mirrors 的旧分组形状；再没有才是扁平数组。
 */
function parseSnapshot(payload: unknown): Snapshot {
  const root = isRecord(payload) ? payload : null
  const items: MirrorItem[] = []
  const active: Snapshot['active'] = {}
  const seen = new Set<string>()
  let contract: Contract = 'none'

  const groups = isRecord(root?.kinds) ? root.kinds
    : isRecord(root?.mirrors) && !Array.isArray(root?.mirrors) ? root.mirrors
      : isRecord(root?.builtin) ? root.builtin
        : isRecord(root?.groups) ? root.groups
          : null
  if (isRecord(root?.kinds)) contract = 'kinds'
  else if (groups) contract = 'legacy'

  if (groups) {
    for (const [key, rawGroup] of Object.entries(groups)) {
      // 分组键可能是 github / npm / pip / docker，也可能是引擎未来加的分类：都归一化后再认。
      const kind = normalizeKind(key, '')
      if (isRecord(rawGroup)) {
        parseGroup(rawGroup, kind, items, seen)
        const activeRaw = rawGroup.active ?? rawGroup.activeId ?? rawGroup.active_id ?? rawGroup.current
        const activeText = asText(activeRaw)
        if (activeText) active[kind] = activeText
      } else if (Array.isArray(rawGroup)) {
        // 兜底：分组直接就是数组（没有 active 字段的写法）。
        parseGroup(rawGroup, kind, items, seen)
      }
    }
  }

  // 扁平数组写法（老引擎 / 第三方写的 settings）：每个条目自己带 type。
  const flat: unknown[] = Array.isArray(payload) ? payload
    : Array.isArray(root?.mirrors) ? root.mirrors
      : Array.isArray(root?.items) ? root.items
        : Array.isArray(root?.sources) ? root.sources
          : []
  if (flat.length) {
    if (contract === 'none') contract = 'legacy'
    flat.forEach((entry, index) => {
      const item = parseItem(entry, index, undefined)
      if (item) pushItem(item, items, seen)
    })
  }

  // custom：用户自己加的源。已经出现在 kinds 分组里的会被 seen 去重；没标类型时放「其他」。
  const customList = Array.isArray(root?.custom) ? root.custom : []
  customList.forEach((entry, index) => {
    const item = parseItem(entry, index, 'other')
    if (!item) return
    pushItem({ ...item, custom: true, builtin: false }, items, seen)
  })

  // 引擎没在分组里给 active 时的兜底：条目自己带 active / current 标记。
  for (const item of items) {
    const raw = item.raw
    if (raw.active === true || raw.current === true || raw.selected === true || raw.is_active === true) active[item.kind] = item.id
  }
  // 顶级 active 表（{"github": "gh-proxy"} 这种写法）也认。
  const activeMap = isRecord(root?.active) ? root.active : isRecord(root?.activeByKind) ? root.activeByKind : null
  if (activeMap) {
    for (const [key, value] of Object.entries(activeMap)) {
      const kind = normalizeKind(key, '')
      const id = asText(value) || (isRecord(value) ? asText(value.id) || asText(value.name) : '')
      if (id && active[kind] === undefined) active[kind] = id
    }
  }

  return { items, active, updatedAt: formatUpdatedAt(root?.updatedAt ?? root?.updated_at), contract }
}

/** 测速结果：引擎回的是单条 {ok,ttfb_ms,status,error}；也认 {results:[…]} 这种批量写法。 */
function parseTestResult(payload: unknown): { ok: boolean; ttfbMs: number | null; error: string } {
  const root = isRecord(payload) ? payload : null
  const list = Array.isArray(payload) ? payload
    : Array.isArray(root?.results) ? root.results
      : Array.isArray(root?.tests) ? root.tests
        : []
  const entry = (isRecord(list[0]) ? list[0] : root) as Record<string, unknown> | null
  if (!entry) return { ok: false, ttfbMs: null, error: '' }
  const ttfbMs = asMs(entry.ttfb_ms ?? entry.ttfbMs ?? entry.latency_ms ?? entry.latencyMs ?? entry.ms)
  const statusText = asText(entry.status).toLowerCase()
  const error = asText(entry.error)
  const ok = entry.ok === true || entry.healthy === true || statusText === 'ok' || (entry.ok !== false && ttfbMs !== null && !error)
  return { ok, ttfbMs, error }
}

/** 只接受 http(s)：明文以外的地址会被引擎拒绝，与其保存完再报错，不如在这里就拦住。 */
function validateUrl(url: string): string {
  const text = url.trim()
  if (!text) return '请填 URL'
  let parsed: URL
  try { parsed = new URL(text) } catch { return 'URL 格式不正确，例如 https://registry.npmmirror.com' }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '只接受 http(s):// 开头的地址'
  return ''
}

/** PUT 里的条目：只带引擎认识的字段（raw 里的 status / ttfb 之类是界面状态，不该写回配置）。 */
function itemPayload(item: MirrorItem): Record<string, unknown> {
  return {
    id: item.id,
    label: item.label,
    url: item.url,
    type: item.kind,
    enabled: item.enabled,
    official: item.official,
    ...(item.custom ? { custom: true } : {}),
  }
}

/** 限并发地跑一遍（测速是外向请求，一次全放出去会把刚起来的引擎堵住）。 */
async function mapLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await run(item)
    }
  })
  await Promise.all(workers)
}

/* ── 引擎不支持时的只读参考清单 ──
   这不是引擎的数据，界面上会写明「前端内置、仅供参考」，免得被当成引擎的真实状态。 */
const REFERENCE_SOURCES: Array<{ kind: MirrorKind; label: string; url: string; official?: boolean }> = [
  { kind: 'github', label: 'GitHub 官方直链', url: 'https://github.com', official: true },
  { kind: 'github', label: 'gh-proxy 加速', url: 'https://gh-proxy.com/' },
  { kind: 'github', label: 'ghfast.top 加速', url: 'https://ghfast.top/' },
  { kind: 'npm', label: 'npm 官方源', url: 'https://registry.npmjs.org/', official: true },
  { kind: 'npm', label: 'npmmirror 国内镜像', url: 'https://registry.npmmirror.com/' },
  { kind: 'pip', label: 'PyPI 官方源', url: 'https://pypi.org/simple/', official: true },
  { kind: 'pip', label: '清华 TUNA 镜像', url: 'https://pypi.tuna.tsinghua.edu.cn/simple/' },
  { kind: 'pip', label: '阿里云镜像', url: 'https://mirrors.aliyun.com/pypi/simple/' },
  { kind: 'docker', label: 'Docker Hub 官方', url: 'https://registry-1.docker.io', official: true },
  { kind: 'docker', label: '中科大镜像', url: 'https://docker.mirrors.ustc.edu.cn' },
]

function referenceSnapshot(): Snapshot {
  const items = REFERENCE_SOURCES.map((source, index): MirrorItem => ({
    id: 'reference-' + index,
    kind: source.kind,
    label: source.label,
    url: source.url,
    enabled: true,
    official: source.official === true,
    builtin: true,
    custom: false,
    status: 'unknown',
    ttfbMs: null,
    probeError: '',
    raw: {},
  }))
  const active: Snapshot['active'] = {}
  for (const item of items) {
    if (item.official && !active[item.kind]) active[item.kind] = item.id
  }
  return { items, active, updatedAt: '', contract: 'none' }
}

const INJECT_NOTE = '当前生效的源只注入引擎派发的子进程：git 走 url.<base>.insteadOf、npm / pnpm 走 registry、'
  + 'pip 走 index-url、uv 走 UV_INDEX_URL。它不写系统或用户级的全局配置，也不会改动你自己的终端环境——'
  + '关掉 Coomi 之后这些设置对外界没有任何影响。'

/* ── 行内小件 ── */

function StatusLight({ status }: { status: MirrorItem['status'] }) {
  const dot = status === 'ok' ? 'bg-ok'
    : status === 'fail' ? 'bg-danger'
      : status === 'testing' ? 'bg-warn animate-pulse'
        : 'bg-ink-4/40'
  const label = status === 'ok' ? '最近一次测速可用'
    : status === 'fail' ? '最近一次测速失败'
      : status === 'testing' ? '正在测速'
        : '还没有测速结果'
  return (
    <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', dot)}>
      <span className='sr-only'>{label}</span>
    </span>
  )
}

function MirrorRow({ item, current, readOnly, busy, first, last, onToggle, onSelect, onMove, onRemove }: {
  item: MirrorItem
  /** 它是这一类型当前生效的源。 */
  current: boolean
  /** 引擎不支持镜像接口、或这一类的引擎不认识时的只读展示。 */
  readOnly: boolean
  busy: boolean
  first: boolean
  last: boolean
  onToggle: (enabled: boolean) => void
  onSelect: () => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}) {
  const ttfb = item.status === 'testing' ? '测速中' : item.ttfbMs === null ? '—' : item.ttfbMs + ' ms'
  const ttfbTone = item.status === 'fail' ? 'text-danger'
    : item.status === 'ok' ? (item.ttfbMs !== null && item.ttfbMs <= 500 ? 'text-ok' : 'text-warn')
      : 'text-ink-4'
  return (
    <div
      data-testid='mirror-row'
      data-mirror-id={item.id}
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 rounded-lg border px-3 py-2',
        current ? 'border-primary/30 bg-primary-soft' : 'border-line bg-surface',
      )}
    >
      <StatusLight status={item.status} />
      <div className='min-w-0'>
        <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
          <span className='truncate text-13 text-ink' title={item.label}>{item.label}</span>
          {item.official ? <Badge>官方</Badge> : null}
          {item.builtin && !item.official ? <Badge>内置</Badge> : null}
          {item.custom ? <Badge tone='primary'>自定义</Badge> : null}
          {!item.enabled ? <Badge tone='warn'>已停用</Badge> : null}
          {current ? <Badge tone='primary'>当前</Badge> : null}
        </div>
        <div className='mt-0.5 break-all font-mono text-11 leading-[1.6] text-ink-4' title={item.url}>{item.url || '—'}</div>
        {item.status === 'fail' && item.probeError ? (
          <div className='mt-0.5 break-all text-11 leading-[1.6] text-danger' title={item.probeError}>测速失败：{item.probeError}</div>
        ) : null}
      </div>
      <div className='flex shrink-0 items-center gap-1'>
        <span className={cn('w-[58px] text-right font-mono text-11 tabular-nums', ttfbTone)} title='最近一次测速的首字节延迟（TTFB）'>{ttfb}</span>
        {readOnly ? null : (
          <>
            <Button variant='ghost' size='icon-sm' title='上移（越靠前越优先）' disabled={busy || first} onClick={() => onMove(-1)}>
              <ArrowUp size={13} />
            </Button>
            <Button variant='ghost' size='icon-sm' title='下移' disabled={busy || last} onClick={() => onMove(1)}>
              <ArrowDown size={13} />
            </Button>
            <Button
              variant='ghost'
              size='sm'
              disabled={busy || current || !item.enabled}
              title={current ? '已经是当前生效的源' : item.enabled ? '设为当前生效的源' : '先启用再设为当前'}
              onClick={onSelect}
            >
              设为当前
            </Button>
            <Switch checked={item.enabled} disabled={busy} onCheckedChange={onToggle} aria-label={item.enabled ? '停用 ' + item.label : '启用 ' + item.label} />
            <Button
              variant='ghost'
              size='icon-sm'
              className='text-ink-3 hover:text-danger'
              title={item.official ? '官方源不能删除（可以停用）' : item.builtin ? '引擎内置清单里的条目：只能停用，删不掉' : '删除这个源'}
              disabled={busy || item.official}
              onClick={onRemove}
            >
              <Trash2 size={13} />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/* ── 面板 ── */

export function MirrorPanel({ active = true }: { active?: boolean }) {
  const ready = useEngine((s) => s.ready)
  const confirmDanger = useUi((s) => s.prefs.confirmDanger)

  const [snap, setSnap] = useState<Snapshot>({ items: [], active: {}, updatedAt: '', contract: 'none' })
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<{ label: string; url: string; kind: MirrorKind }>({ label: '', url: '', kind: 'npm' })
  const [undo, setUndo] = useState<{ active: Snapshot['active']; summary: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!ready) {
      setError('引擎还没就绪，启动完成后再刷新')
      return
    }
    setLoading(true)
    const reply = await request<unknown>('/api/settings/mirrors')
    setLoading(false)
    if (reply.ok) {
      const next = parseSnapshot(reply.data)
      setSnap(next)
      setUnsupported(false)
      // 读到了但结构认不出来时，把引擎原话（响应片段）带上；不假装「引擎没有镜像源」。
      setError(next.contract === 'none'
        ? '引擎返回的镜像清单里没有 kinds / mirrors / builtin 任何一种结构，无法解析：'
          + (reply.text.trim().slice(0, 200) || '（响应体为空）')
        : '')
      return
    }
    if (isUnsupportedReply(reply)) {
      // 引擎还没有这个接口：只读展示内置参考清单，写操作全部禁用。
      setUnsupported(true)
      setSnap(referenceSnapshot())
      setError('')
      return
    }
    setError(replyMessage(reply, '读取镜像源失败'))
  }, [ready])

  // 切到「引擎与诊断」分组时才拉：设置页其它分组不该被这几条请求拖慢。
  useEffect(() => {
    if (active) void load()
  }, [active, load])

  /**
   * 部分更新：只把改动的那一类发给引擎，用引擎回传的归一化结果刷新界面。
   * body 的形状跟着 GET 回来的契约走（kinds / 顶层分组），认不出契约时两种都带。
   * 返回引擎归一化后的快照；失败返回 null（错误信息是引擎原话）。
   */
  const save = useCallback(async (
    patch: Partial<Record<MirrorKind, GroupPatch>>,
    opts?: { quiet?: boolean; success?: string },
  ): Promise<Snapshot | null> => {
    const groups: Record<string, unknown> = {}
    for (const kind of WRITABLE_KINDS) {
      const group = patch[kind]
      if (!group) continue
      const body: Record<string, unknown> = {}
      if (group.active !== undefined) body.active = group.active
      if (group.items) body.items = group.items.map(itemPayload)
      if (group.remove?.length) body.remove = group.remove
      if (Object.keys(body).length) groups[kind] = body
    }
    if (!Object.keys(groups).length) return null

    // 两种形状一起给：新契约读 kinds，旧契约读顶层分类；内容完全一样，引擎读哪种都对得上，
    // 认不出的键会被忽略（不猜「引擎一定是哪一版」）。
    const payload: Record<string, unknown> = { ...groups, kinds: groups }

    setBusy(true)
    const reply = await request<unknown>('/api/settings/mirrors', jsonInit('PUT', payload))
    setBusy(false)
    if (!reply.ok) {
      if (isUnsupportedReply(reply)) {
        setUnsupported(true)
        setSnap(referenceSnapshot())
        toast.error('引擎暂不支持镜像管理（没有 PUT /api/settings/mirrors 接口），已切换为只读展示')
        return null
      }
      const message = replyMessage(reply, '引擎没有返回原因')
      setError('保存失败：' + message)
      toast.error('保存失败：' + message)
      // 写失败了：把界面重新读回引擎里的真实状态，不留「看起来存上了」的假象。
      void load()
      return null
    }
    setError('')
    const echoed = parseSnapshot(reply.data)
    if (echoed.contract !== 'none') {
      setSnap(echoed)
      if (opts?.success) toast.success(opts.success)
      else if (!opts?.quiet) toast.success('镜像设置已保存')
      return echoed
    }
    // 引擎回了个认不出的 body：以本地意图为准，但把「没拿到归一化结果」说出来。
    if (!opts?.quiet) toast.message('已提交，但引擎没有回传归一化后的清单，正在重新读取…')
    await load()
    return null
  }, [snap.contract, load])

  const groupOf = useCallback((kind: MirrorKind): MirrorItem[] => snap.items.filter((item) => item.kind === kind), [snap.items])

  const runTest = useCallback(async (targets: MirrorItem[]): Promise<Map<string, { ok: boolean; ttfbMs: number | null; error: string }> | null> => {
    // 引擎的测速接口是**单条**的（POST {type,url}），所以这里逐条打，限并发 4。
    const probed = targets.filter((item) => item.kind !== 'other')
    if (!probed.length) return null
    const ids = probed.map((item) => item.id)
    setTesting(true)
    setSnap((prev) => ({ ...prev, items: prev.items.map((item): MirrorItem => (ids.includes(item.id) ? { ...item, status: 'testing' } : item)) }))
    const outcome = new Map<string, { ok: boolean; ttfbMs: number | null; error: string }>()
    let unsupportedReply = false
    let firstError = ''
    await mapLimit(probed, 4, async (item) => {
      const reply = await request<unknown>('/api/runtime/mirror-test', jsonInit('POST', { type: item.kind, url: item.url }))
      if (!reply.ok) {
        if (isUnsupportedReply(reply)) unsupportedReply = true
        else if (!firstError) firstError = replyMessage(reply, '引擎没有返回原因')
        return
      }
      outcome.set(item.id, parseTestResult(reply.data))
    })
    setTesting(false)
    if (!outcome.size) {
      // 一条都没测成：把「正在测速」擦掉，回到上一次的真实结论。
      setSnap((prev) => ({
        ...prev,
        items: prev.items.map((item): MirrorItem => (
          ids.includes(item.id) && item.status === 'testing'
            ? { ...item, status: item.ttfbMs === null ? 'unknown' : 'ok' }
            : item
        )),
      }))
      if (unsupportedReply) toast.error('引擎暂不支持测速（没有 POST /api/runtime/mirror-test {type,url} 接口）')
      else toast.error('测速失败：' + (firstError || '引擎没有返回结果'))
      return null
    }
    setSnap((prev) => ({
      ...prev,
      items: prev.items.map((item): MirrorItem => {
        const hit = outcome.get(item.id)
        if (hit) return { ...item, status: hit.ok ? 'ok' : 'fail', ttfbMs: hit.ttfbMs, probeError: hit.ok ? '' : hit.error }
        return ids.includes(item.id) ? { ...item, status: 'unknown' } : item
      }),
    }))
    if (firstError) toast.error('部分源测速失败：' + firstError)
    return outcome
  }, [])

  const toggleEnabled = (item: MirrorItem, enabled: boolean): void => {
    const items = groupOf(item.kind).map((x): MirrorItem => (x.id === item.id ? { ...x, enabled } : x))
    void save({ [item.kind]: { items } }, { quiet: true }).then((echoed) => {
      if (!echoed) return
      const after = echoed.items.find((x) => x.id === item.id)
      if (after && after.enabled !== enabled) {
        toast.message('引擎没有改变「' + item.label + '」的启停状态')
        return
      }
      toast.success(enabled ? '已启用「' + item.label + '」' : '已停用「' + item.label + '」')
    })
  }

  const setActiveSource = (item: MirrorItem): void => {
    setUndo(null)
    void save({ [item.kind]: { active: item.id } }, { quiet: true }).then((echoed) => {
      if (!echoed) return
      if (echoed.active[item.kind] === item.id) toast.success('已把「' + item.label + '」设为当前的 ' + KIND_META[item.kind].label + ' 源')
      else toast.message('引擎没有切换到「' + item.label + '」', { description: '可能这个源被停用了，或引擎拒绝了这次切换。' })
    })
  }

  /** 上下排序：只在本类型内部换位，其它类型的相对顺序原样保留。 */
  const move = (item: MirrorItem, delta: -1 | 1): void => {
    const group = groupOf(item.kind)
    const index = group.findIndex((x) => x.id === item.id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= group.length) return
    const reordered = [...group]
    const [picked] = reordered.splice(index, 1)
    reordered.splice(target, 0, picked)
    void save({ [item.kind]: { items: reordered } }, { quiet: true }).then((echoed) => {
      if (!echoed) return
      const after = echoed.items.filter((x) => x.kind === item.kind).map((x) => x.id)
      const want = reordered.map((x) => x.id)
      // 引擎可能按 id upsert（顺序不变）：如实说，不假装排序成功。
      if (after.join('|') !== want.join('|')) toast.message('引擎没有改变这一类的顺序', { description: '当前引擎按 id 保存条目，排序只影响界面里的展示。' })
    })
  }

  const remove = (item: MirrorItem): void => {
    if (confirmDanger && !window.confirm('删除镜像源「' + item.label + '」？如果它正生效，这一类型会退回官方源。')) return
    const remaining = groupOf(item.kind).filter((x) => x.id !== item.id)
    setUndo(null)
    void save({ [item.kind]: { items: remaining, remove: [item.id] } }, { quiet: true }).then((echoed) => {
      if (!echoed) return
      if (echoed.items.some((x) => x.id === item.id)) {
        toast.message('引擎保留了「' + item.label + '」', { description: '内置清单里的条目只能停用，删不掉。' })
        return
      }
      toast.success('已删除「' + item.label + '」')
    })
  }

  const testAll = async (): Promise<void> => {
    const targets = snap.items.filter((item) => item.enabled && item.kind !== 'other')
    if (!targets.length) { toast.error('没有可测速的镜像源（先启用几个）'); return }
    const results = await runTest(targets)
    if (!results) return
    const usable = targets.filter((item) => results.get(item.id)?.ok).length
    toast.success('测速完成：' + usable + ' / ' + targets.length + ' 个源可用')
  }

  /** 自动选择最快：每种类型挑 TTFB 最低的那个已启用源，切换前的选择留在 undo 里。 */
  const autoPick = async (): Promise<void> => {
    const pool = snap.items.filter((item) => item.enabled && item.kind !== 'other')
    if (!pool.length) { toast.error('没有可用的镜像源（先启用几个）'); return }
    const results = await runTest(pool)
    if (!results) return
    const previous = { ...snap.active }
    const patch: Partial<Record<MirrorKind, GroupPatch>> = {}
    const picked: string[] = []
    for (const kind of WRITABLE_KINDS) {
      const candidates = pool.filter((item) => item.kind === kind && results.get(item.id)?.ok === true && results.get(item.id)?.ttfbMs !== null)
      if (!candidates.length) continue
      const best = candidates.reduce((a, b) => ((results.get(a.id)?.ttfbMs ?? Infinity) <= (results.get(b.id)?.ttfbMs ?? Infinity) ? a : b))
      patch[kind] = { active: best.id }
      picked.push(KIND_META[kind].label + ' → ' + best.label + '（' + (results.get(best.id)?.ttfbMs ?? '—') + ' ms）')
    }
    if (!picked.length) { toast.error('测速没有可用结果，保持原来的源'); return }
    const echoed = await save(patch, { quiet: true })
    if (!echoed) return
    setUndo({ active: previous, summary: picked.join('；') })
    toast.success('已按最快延迟切换')
  }

  const undoAutoPick = (): void => {
    if (!undo) return
    const back = undo
    const patch: Partial<Record<MirrorKind, GroupPatch>> = {}
    for (const kind of WRITABLE_KINDS) {
      const id = back.active[kind]
      if (id) patch[kind] = { active: id }
    }
    void save(patch, { quiet: true }).then((echoed) => {
      if (!echoed) return
      setUndo(null)
      toast.success('已撤销自动选择，回到切换前的源')
    })
  }

  /** 恢复官方源：每种类型切回官方项（引擎一定会存一个非空 active，所以这里只发官方项的 id）。 */
  const restoreOfficial = (): void => {
    const patch: Partial<Record<MirrorKind, GroupPatch>> = {}
    const picked: string[] = []
    for (const kind of WRITABLE_KINDS) {
      const official = groupOf(kind).find((item) => item.official)
      if (!official) continue
      patch[kind] = { active: official.id }
      picked.push(KIND_META[kind].label + ' → ' + official.label)
    }
    if (!picked.length) { toast.error('引擎没有给出官方源条目，无法一键恢复'); return }
    setUndo(null)
    void save(patch, { quiet: true }).then((echoed) => {
      if (echoed) toast.success('已恢复官方源：' + picked.join('；'))
    })
  }

  const urlError = validateUrl(draft.url)
  const labelError = draft.label.trim() ? '' : '请填名称'
  const duplicate = !!draft.url.trim() && snap.items.some((x) => x.url.trim().toLowerCase() === draft.url.trim().toLowerCase())

  const addSource = (): void => {
    if (labelError || urlError) return
    if (duplicate) { toast.error('这个 URL 已经在列表里了'); return }
    const kind = draft.kind === 'other' ? 'github' : draft.kind
    const item: MirrorItem = {
      id: 'custom-' + Date.now().toString(36),
      kind,
      label: draft.label.trim(),
      url: draft.url.trim(),
      enabled: true,
      official: false,
      builtin: false,
      custom: true,
      status: 'unknown',
      ttfbMs: null,
      probeError: '',
      raw: { custom: true },
    }
    void save({ [kind]: { items: [...groupOf(kind), item] } }, { quiet: true }).then((echoed) => {
      if (!echoed) return
      if (!echoed.items.some((x) => x.id === item.id)) {
        toast.error('引擎没有接受这个源', { description: '检查地址是否可达 / 是否是引擎支持的分类（github / npm / pip / docker）。' })
        return
      }
      toast.success('已添加「' + item.label + '」，先测一次速再决定要不要设为当前')
      setDraft({ label: '', url: '', kind: draft.kind })
      setAdding(false)
    })
  }

  const writable = !unsupported
  const actionsDisabled = !ready || busy || loading || testing || !writable
  const activeLabel = (kind: MirrorKind): string => {
    const id = snap.active[kind]
    if (!id) return '官方直链'
    const hit = snap.items.find((x) => x.id === id)
    return hit ? hit.label : id
  }
  const activeSource = (kind: MirrorKind): string => snap.active[kind] ?? ''

  return (
    <Section
      className={active ? '' : 'hidden'}
      title='下载与镜像'
      description='引擎拉起 git / npm / pip 等子进程时走的下载源；只影响这些子进程，不动系统全局配置。'
      actions={
        <>
          <Button variant='ghost' size='icon-sm' title='重新读取' disabled={busy || loading} onClick={() => void load()}>
            {loading ? <Spinner /> : <RefreshCw size={13} />}
          </Button>
          <Button variant='secondary' size='sm' disabled={actionsDisabled} onClick={() => void testAll()}>
            <Gauge size={13} /> 全部测速
          </Button>
          <Button variant='ghost' size='sm' disabled={actionsDisabled} title='测速后每种类型自动切到延迟最低的源，可撤销' onClick={() => void autoPick()}>
            <Sparkles size={13} /> 自动选择最快
          </Button>
          <Button variant='ghost' size='sm' disabled={actionsDisabled} title='每种类型切回官方源' onClick={restoreOfficial}>
            <RotateCcw size={13} /> 恢复官方源
          </Button>
        </>
      }
    >
      <div className='flex min-w-0 flex-col gap-3 px-5 py-4' data-testid='mirrors-panel'>
        {unsupported ? (
          <p className='flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-12 leading-[1.65] text-warn'>
            <AlertTriangle size={13} className='mt-0.5 shrink-0' />
            <span className='min-w-0'>
              引擎暂不支持镜像管理（没有 /api/settings/mirrors 接口）。下面是前端内置的常见源，仅供参考，
              不会写入任何配置；写操作在这里全部禁用。
            </span>
          </p>
        ) : null}

        {error ? (
          <p className='flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-12 leading-[1.65] text-danger'>
            <AlertTriangle size={13} className='mt-0.5 shrink-0' />
            <span className='min-w-0 break-all'>{error}</span>
          </p>
        ) : null}

        {undo ? (
          <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-primary/25 bg-primary-soft px-3 py-2 text-12 leading-[1.6] text-primary'>
            <span className='flex items-center gap-1.5'><Sparkles size={13} /> 已按最快延迟切换</span>
            <span className='min-w-0 break-words text-primary/80'>{undo.summary}</span>
            <span className='ml-auto flex shrink-0 items-center gap-1.5'>
              <Button variant='secondary' size='sm' disabled={busy} onClick={undoAutoPick}>撤销</Button>
              <Button variant='ghost' size='sm' onClick={() => setUndo(null)}>保留</Button>
            </span>
          </div>
        ) : null}

        {loading && !snap.items.length ? <SkeletonRows rows={4} className='px-0' /> : null}

        {!loading && !snap.items.length ? (
          <Empty
            art='engine'
            title={writable ? '还没有镜像源' : '引擎暂不支持镜像管理'}
            description={writable
              ? '引擎这次的清单是空的（每种类型都用官方直链）。可以点下面的「新增源」自己加一个 http(s) 地址。'
              : '引擎这个版本还没有 /api/settings/mirrors 接口，等引擎补上后这里会自动变成可编辑状态。'}
          />
        ) : null}

        {KIND_ORDER.map((kind) => {
          const group = snap.items.filter((x) => x.kind === kind)
          if (!group.length) return null
          const editable = writable && kind !== 'other'
          return (
            <div key={kind} className='flex min-w-0 flex-col gap-1.5' data-testid={'mirror-group-' + kind}>
              <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1'>
                <span className='text-12 font-medium text-ink'>{KIND_META[kind].label}</span>
                <span className='text-11 text-ink-4'>{KIND_META[kind].hint}</span>
                <span className='ml-auto flex items-center gap-1.5 text-11 text-ink-4'>
                  当前：<Badge tone='primary'>{activeLabel(kind)}</Badge>
                </span>
              </div>
              {group.map((item, index) => (
                <MirrorRow
                  key={item.id}
                  item={item}
                  current={activeSource(kind) === item.id}
                  readOnly={!editable}
                  busy={busy || testing}
                  first={index === 0}
                  last={index === group.length - 1}
                  onToggle={(enabled) => toggleEnabled(item, enabled)}
                  onSelect={() => setActiveSource(item)}
                  onMove={(delta) => move(item, delta)}
                  onRemove={() => remove(item)}
                />
              ))}
            </div>
          )
        })}

        {writable && adding ? (
          <div className='rounded-lg border border-dashed border-line-strong px-3 py-3' data-testid='mirror-add-form'>
            <div className='grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto]'>
              <Input
                className='h-8'
                placeholder='名称，例如 公司内网 npm'
                value={draft.label}
                invalid={!!draft.label && !!labelError}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              />
              <Input
                className='h-8 font-mono text-12'
                placeholder='https://registry.example.com'
                value={draft.url}
                invalid={!!urlError}
                onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              />
              <Segmented<MirrorKind>
                value={draft.kind}
                onChange={(v) => setDraft((d) => ({ ...d, kind: v }))}
                options={[
                  { value: 'github', label: 'GitHub 加速' },
                  { value: 'npm', label: 'npm' },
                  { value: 'pip', label: 'pip · uv' },
                  { value: 'docker', label: 'Docker' },
                ]}
              />
            </div>
            {urlError || (draft.label && labelError) ? (
              <p className='mt-1.5 text-11 text-danger'>{urlError || labelError}</p>
            ) : (
              <p className='mt-1.5 text-11 text-ink-4'>自定义源要填 http(s) 地址；保存后可以测速、排序，再决定要不要设为当前。</p>
            )}
            {duplicate ? <p className='mt-1 text-11 text-warn'>这个 URL 已经在列表里了。</p> : null}
            <div className='mt-2 flex justify-end gap-1.5'>
              <Button variant='ghost' size='sm' disabled={busy} onClick={() => { setAdding(false); setDraft({ label: '', url: '', kind: 'npm' }) }}>取消</Button>
              <Button variant='primary' size='sm' disabled={busy || !!urlError || !!labelError || duplicate} onClick={addSource}>
                <Plus size={13} /> 添加
              </Button>
            </div>
          </div>
        ) : null}

        {/* 拿到了数据就一定给得出「新增源」：清单为空、结构只读得懂一半都不影响这条入口。 */}
        {writable && !adding ? (
          <Button variant='ghost' size='sm' className='self-start' disabled={busy} onClick={() => setAdding(true)}>
            <Plus size={13} /> 新增源
          </Button>
        ) : null}

        <p className='text-11 leading-[1.75] text-ink-4'>{INJECT_NOTE}</p>
        <p className='text-11 leading-[1.6] text-ink-4'>
          数据来源：GET /api/settings/mirrors
          {snap.contract === 'kinds' ? '（kinds 契约）' : snap.contract === 'legacy' ? '（builtin / mirrors 旧形状）' : ''}
          {snap.updatedAt ? ' · 引擎更新于 ' + snap.updatedAt : ''}
          ；保存走 PUT 部分更新，界面显示的是引擎归一化后的结果。
        </p>
      </div>
    </Section>
  )
}

/* #185 的报错栈里显示真名（生产构建会压掉函数名） */
withDisplayName(MirrorPanel, 'MirrorPanel')
