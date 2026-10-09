/** 远程 MCP 源浏览器：来源说明 + 搜索 + 加载/空/错误三态 + 结果卡片。
 *
 *  安装就摆在卡片主按钮上，不再需要「生成配置 → 自己粘进文件」：
 *   · 条目 id 命中内置目录 → 走引擎的内置安装接口（必要时由调用方弹参数表单）；
 *   · 能推断出启动方式的第三方条目 → 「一键安装」：直接 POST /api/catalog/mcp/install-remote，
 *     装完回显「已连接 · N 个工具」（引擎写盘后会立刻热重载并回报连接状态与工具数）；
 *   · 推不出启动方式、或清单要求填环境变量 → 同一个按钮弹预填表单，确认后同样是「一键安装」；
 *   · 本机缺 npx / uvx 这类运行环境 → 按钮变成「一键装环境并安装」：一张两步进度卡，
 *     先装环境再装工具（见 ChainInstallDialog）。
 *  另外保留「生成配置」这条手动路（自定义安装对话框），供用户想自己改配置文件时使用。 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle, CheckCircle2, Download, ExternalLink, Globe, KeyRound, RefreshCw, Search, Wrench,
} from 'lucide-react'
import { AnimatedNumber } from '../ui/Number'
import { cn } from '../../lib/cn'
import { useLibrary } from '../../stores/library'
import { Button } from '../../components/ui/Button'
import { Input, Badge } from '../../components/ui/Input'
import { Spinner } from '../../components/ui/Controls'
import { Empty } from '../../components/ui/Card'
import { catalogIcon } from './catalogMeta'
import { CustomInstallDialog, type CustomInstallSeed } from './CustomInstallDialog'
import { RuntimeHelpDialog } from './RuntimeHelpDialog'
import { RemoteInstallDialog } from './RemoteInstallDialog'
import { ChainInstallDialog, EMPTY_TOOL_OUTCOME, type ToolInstallOutcome } from './ChainInstallDialog'
import {
  entryRuntimeIds, helpTargetFor, runtimeLabel, runtimeStatusFor,
  type RuntimeHelpTarget, type RuntimeStatus,
} from './runtimeMeta'
import {
  remoteInstallPlan, remoteServerName, remoteSourceDef, fetchRemoteEntries,
  type RemoteEntry, type RemoteSourceKey,
} from './remoteSources'
import type { McpInstallResult } from './installClient'
import { useLatestRef, useVirtualList } from './useVirtualList'

/** 卡片错峰入场：步长取令牌 --motion-stagger，超过 10 项不再往后排（与「已安装」列表同一套节奏）。 */
const stagger = (i: number): React.CSSProperties => ({ animationDelay: 'calc(var(--motion-stagger) * ' + Math.min(i, 10) + ')' })

/* ── 翻页状态 ──
   每个源各记一份游标：换源、换关键词都从头再翻，切走再切回来还能接着翻。
   放在模块级 Map 里（而不是组件里）：这一页的组件在换视图时会重挂载，翻到第几页得留住。 */
interface PageState {
  /** 这一批结果对应的关键词：换词就必须重置分页。 */
  query: string
  /** 下一页游标（含义由 remoteSources.ts 定：官方 cursor / npm 偏移 / 其余是页码）。 */
  cursor: string | null
  /** 还有没有下一页。 */
  hasMore: boolean
  /** 源自己回报的总条数（拿不到时为 null）。 */
  total: number | null
  /** 已经取了几页（含首屏）。 */
  pages: number
  /** 「加载更多」进行中。 */
  loadingMore: boolean
  /** 「加载更多」失败的原话（首屏失败走 state.status === 'error'）。 */
  error: string
}

const EMPTY_PAGE: PageState = { query: '', cursor: null, hasMore: false, total: null, pages: 0, loadingMore: false, error: '' }
const PAGE_MEMO = new Map<RemoteSourceKey, PageState>()

/** 续页结果并进已有结果：按 id（忽略大小写）去重，翻页重叠是常态。 */
function mergeEntries(prev: RemoteEntry[], next: RemoteEntry[]): RemoteEntry[] {
  const seen = new Set(prev.map((entry) => entry.id.toLowerCase()))
  const out = prev.slice()
  for (const entry of next) {
    const id = entry.id.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    out.push(entry)
  }
  return out
}

/** 数字紧凑显示：12345 → 1.2万；不认识的单位就别硬编。 */
function compact(value: number | null): string {
  if (value === null) return ''
  if (value >= 10_000) return (value / 10_000).toFixed(value >= 100_000 ? 0 : 1) + ' 万'
  if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
  return String(value)
}

/** 装完之后卡片上要回显的结果（技能中心据此刷新两条链路）。 */
export interface RemoteInstalledEcho {
  name: string
  ok: boolean
  saved: boolean
  connected: boolean
  toolsCount: number
  error: string
}

export function RemoteMcpBrowser({ sourceKey, builtinIds, installedIds, configPath, onInstallBuiltin, onNotice, onInstalled }: {
  sourceKey: RemoteSourceKey
  /** 内置目录里的 id 集合：命中就直接走引擎的安装接口（要填参数的条目由调用方弹表单）。 */
  builtinIds: ReadonlySet<string>
  /** 已安装清单里的 id（MCP + 技能），用于打「已安装」标记。 */
  installedIds: ReadonlySet<string>
  /** config/mcp_servers.json 路径，来自 /api/runtime/installed。 */
  configPath: string
  /** 命中内置目录的条目：直接安装，不再让用户先翻详情弹窗。 */
  onInstallBuiltin: (id: string) => void
  onNotice: (text: string) => void
  /** 第三方条目装完（含「已保存但没连上」）：调用方刷新目录 + 已安装两条链路并回显。 */
  onInstalled?: (entry: RemoteEntry, echo: RemoteInstalledEcho) => void
}) {
  /* onNotice / onInstalled / onInstallBuiltin 都由上层（SkillsView）随手传，父组件每次渲染都可能是新函数。
     下面要交给 memo 卡片的回调必须引用稳定，所以走 ref 读最新值（见 useLatestRef 的说明）。 */
  const onInstalledRef = useLatestRef(onInstalled)
  const onInstallBuiltinRef = useLatestRef(onInstallBuiltin)

  const def = remoteSourceDef(sourceKey)
  const state = useLibrary((s) => s.remote[sourceKey])
  const setRemoteState = useLibrary((s) => s.setRemoteState)
  const remoteUrl = useLibrary((s) => s.remoteUrl)
  const setRemoteUrl = useLibrary((s) => s.setRemoteUrl)
  const remoteKey = useLibrary((s) => s.remoteKey)
  const setRemoteKey = useLibrary((s) => s.setRemoteKey)
  const runtimes = useLibrary((s) => s.runtimes)
  const installRemote = useLibrary((s) => s.installRemote)
  const [query, setQuery] = useState('')
  const [seed, setSeed] = useState<CustomInstallSeed | null>(null)
  const [seedOpen, setSeedOpen] = useState(false)
  const [help, setHelp] = useState<{ target: RuntimeHelpTarget | null; reason: string; entryName: string } | null>(null)
  /** 需要补值才装的条目：弹预填表单（值都来自清单，只补缺的那几项）。 */
  const [formEntry, setFormEntry] = useState<RemoteEntry | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  /** 缺运行环境的条目：一张两步进度卡（先装环境，再装工具）。 */
  const [chain, setChain] = useState<{ entry: RemoteEntry; runtimeId: string } | null>(null)
/** 正在安装的条目 key 集合 —— 必须按条记，不能只留「最后点的那一条」：
 *  并排装两条时，后点的会把先点的按钮提前解锁（用户以为装完了/没装上），
 *  而且先点的那条的 finally 又会把后点的按钮解锁（连环串台）。 */
  const [installing, setInstalling] = useState<ReadonlySet<string>>(() => new Set<string>())
  const markInstalling = useCallback((key: string, on: boolean): void => {
    setInstalling((prev) => {
      if (prev.has(key) === on) return prev
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  /** 每条最近的安装结果：卡片上直接回显「已连接 · N 个工具」或失败原因。 */
  const [results, setResults] = useState<Record<string, McpInstallResult>>({})
  // 只认最后一次请求的结果：切源/连点搜索时，慢响应不能覆盖新响应。
  const seq = useRef(0)
  /* 当前源的翻页状态：state 存渲染要用的那份，PAGE_MEMO 存「切走再切回来」要接着用的那份。 */
  const [pageState, setPageState] = useState<{ key: RemoteSourceKey; page: PageState }>(() => ({
    key: sourceKey,
    page: PAGE_MEMO.get(sourceKey) ?? EMPTY_PAGE,
  }))
  const page = pageState.key === sourceKey ? pageState.page : (PAGE_MEMO.get(sourceKey) ?? EMPTY_PAGE)
  const writePage = useCallback((next: PageState): void => {
    PAGE_MEMO.set(sourceKey, next)
    setPageState({ key: sourceKey, page: next })
  }, [sourceKey])
  /** 「加载更多」的同步哨兵：滚动会在同一帧里连着触发好几次，只有它拦得住重复请求。 */
  const loadingMore = useRef(false)

  /** 首屏 / 搜索 / 刷新：永远从第一页重来（旧游标不能带到新关键词上）。 */
  const run = useCallback(async (text: string, silent = false): Promise<void> => {
    const mine = ++seq.current
    loadingMore.current = false
    writePage({ ...EMPTY_PAGE, query: text })
    setRemoteState(sourceKey, { status: 'loading', error: '' })
    try {
      // 地址与 Key 在点击那一刻从 store 取：放进依赖会让「正在填 URL」变成一次请求/按键。
      const { remoteUrl: url, remoteKey: apiKey } = useLibrary.getState()
      const result = await fetchRemoteEntries({ key: sourceKey, query: text, url, apiKey })
      if (mine !== seq.current) return
      setRemoteState(sourceKey, {
        status: 'ready',
        entries: result.entries,
        error: '',
        url: result.url,
        note: result.note,
        fetchedAt: Date.now(),
      })
      writePage({
        query: text,
        cursor: result.nextCursor,
        hasMore: result.hasMore,
        total: result.total,
        pages: 1,
        loadingMore: false,
        error: '',
      })
      const label = remoteSourceDef(sourceKey).label
      if (!silent) onNotice('已从「' + label + '」取得 ' + result.entries.length + ' 条' + (result.hasMore ? '（这个源还有更多，滚到底或点「加载更多」继续）' : '') + (result.note ? '（' + result.note + '）' : ''))
    } catch (error) {
      if (mine !== seq.current) return
      const message = error instanceof Error ? error.message : String(error)
      setRemoteState(sourceKey, { status: 'error', entries: [], error: message, note: '' })
      if (!silent) onNotice('「' + remoteSourceDef(sourceKey).label + '」加载失败：' + message)
    }
  }, [sourceKey, setRemoteState, onNotice, writePage])

  /** 「加载更多」：按当前游标续下一页，结果按 id 去重后并进已有列表（翻页重叠很常见）。 */
  const loadMore = useCallback(async (): Promise<void> => {
    const current = PAGE_MEMO.get(sourceKey) ?? EMPTY_PAGE
    if (!current.hasMore || current.cursor === null || loadingMore.current) return
    loadingMore.current = true
    const mine = ++seq.current
    writePage({ ...current, loadingMore: true, error: '' })
    try {
      const { remoteUrl: url, remoteKey: apiKey } = useLibrary.getState()
      const result = await fetchRemoteEntries({ key: sourceKey, query: current.query, url, apiKey, cursor: current.cursor })
      if (mine !== seq.current) return
      const before = useLibrary.getState().remote[sourceKey].entries
      const merged = mergeEntries(before, result.entries)
      setRemoteState(sourceKey, {
        status: 'ready',
        entries: merged,
        error: '',
        url: result.url,
        // 解析提示按「这一页」重写：官方注册表每页都会合并掉几条同 id 记录，
        // 把历次提示拼起来会越堆越长，反倒看不清这一次发生了什么。
        note: result.note,
        fetchedAt: Date.now(),
      })
      writePage({
        query: current.query,
        cursor: result.nextCursor,
        hasMore: result.hasMore,
        total: result.total ?? current.total,
        pages: current.pages + 1,
        loadingMore: false,
        error: '',
      })
      const label = remoteSourceDef(sourceKey).label
      if (merged.length === before.length) {
        onNotice('「' + label + '」这一页的 ' + result.entries.length + ' 条都和已加载的重复，已按 id 合并' + (result.hasMore ? '；可以继续加载下一页' : '；这个源已经到底了'))
      } else {
        onNotice('「' + label + '」已加载 ' + merged.length + ' 条' + (result.hasMore ? '，还有更多' : '，没有更多了'))
      }
    } catch (error) {
      if (mine !== seq.current) return
      const message = error instanceof Error ? error.message : String(error)
      // 失败不动已加载的结果：只把错误摆在列表底部，让用户点「重试」。
      writePage({ ...current, loadingMore: false, error: message })
      onNotice('「' + remoteSourceDef(sourceKey).label + '」加载下一页失败：' + message)
    } finally {
      loadingMore.current = false
    }
  }, [sourceKey, setRemoteState, writePage, onNotice])

  /** 滚到离底 240px 内自动续页（手动按钮兜底；失败后不再自动重试，交给按钮）。 */
  const onResultsScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) void loadMore()
  }

  // 切到某个源时自动浏览一次（搜索框留空 = 该源的默认清单）；已经拉过就不重复打网络。
  useEffect(() => {
    setQuery('')
    if (state.status === 'ready' || state.status === 'loading') return
    // 自定义源还没填地址：保持未拉取状态，别先弹一个「地址为空」的错误。
    if (def.needsUrl && !useLibrary.getState().remoteUrl.trim()) return
    void run('', true)
    // state 只用于首屏判断，故意不进依赖：否则每次结果写回都会再触发一次请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, run])

  const loading = state.status === 'loading'
  const entries = state.entries

  /* ── 窗口化（见 useVirtualList 的文件头）──
     行 key（就是卡片 key）必须由 useMemo 稳定住：它是行高缓存的键，每帧换新会把量过的行全丢掉。 */
  const virtKeys = useMemo(() => entries.map((entry) => entry.key), [entries])
  const virt = useVirtualList({ keys: virtKeys, estimate: 236, gap: 12, overscan: 6, minCount: 30 })
  /** 换源 / 换关键词＝整张列表换内容，把滚动位置拉回顶部（否则会停在一个已经没有内容的位置）。 */
  const scrollToTop = useLatestRef(virt.scrollToTop)
  useEffect(() => { scrollToTop.current() }, [sourceKey, page.query, scrollToTop])

  const echoOf = (entry: RemoteEntry, result: McpInstallResult): RemoteInstalledEcho => ({
    name: result.name || remoteServerName(entry),
    ok: result.ok,
    saved: result.saved,
    connected: result.connected,
    toolsCount: result.toolsCount,
    error: result.error || result.message,
  })

  /** 记下结果：卡片回显 + 通知调用方刷新两条链路。
   *  引用要稳定：它被 quickInstall 与两个对话框回调引用，进而被 memo 卡片的下游引用。 */
  const remember = useCallback((entry: RemoteEntry, result: McpInstallResult): void => {
    setResults((prev) => ({ ...prev, [entry.id]: result }))
    if (result.saved) onInstalledRef.current?.(entry, echoOf(entry, result))
  }, [])

  /** 一键安装（不开表单）：清单里已经能推断出命令/地址，且不需要用户补值。 */
  const quickInstall = useCallback(async (entry: RemoteEntry, overwrite = false): Promise<void> => {
    const plan = remoteInstallPlan(entry)
    markInstalling(entry.key, true)
    try {
      const result = await installRemote({
        id: entry.id,
        name: remoteServerName(entry),
        transport: plan.transport,
        command: plan.command,
        args: plan.args,
        env: {},
        url: plan.url,
        overwrite,
      })
      remember(entry, result)
      if (result.ok) toast.success('已安装 ' + result.name + '：已连接 · ' + result.toolsCount + ' 个工具')
      else if (result.conflict) {
        toast.warning('已存在同名条目「' + result.name + '」', {
          description: '要替换成清单里的这条，点「覆盖安装」。',
          action: { label: '覆盖安装', onClick: () => { void quickInstall(entry, true) } },
        })
      } else if (result.saved) {
        toast.error('配置已写入，但引擎没能连上它', { description: (result.error || result.message).slice(0, 160) })
      } else {
        toast.error('安装失败', { description: (result.error || result.message).slice(0, 160) })
      }
    } finally {
      markInstalling(entry.key, false)
    }
  }, [installRemote, markInstalling, remember])

  /** 卡片主按钮：缺运行环境 → 两步卡；能推断 → 直接装；推不出 → 预填表单。 */
  const primaryInstall = useCallback((entry: RemoteEntry, runtimeId: string, runtimeMissing: boolean): void => {
    if (runtimeMissing && runtimeId) { setChain({ entry, runtimeId }); return }
    const plan = remoteInstallPlan(entry)
    if (plan.direct) { void quickInstall(entry); return }
    setFormEntry(entry)
    setFormOpen(true)
  }, [quickInstall])

  const applySeed = useCallback((entry: RemoteEntry): void => {
    setSeed({
      id: entry.id,
      name: entry.name,
      transport: entry.transport || (entry.url ? 'http' : 'stdio'),
      command: entry.command,
      args: entry.args,
      url: entry.url,
      repository: entry.repository,
      description: entry.description,
      source: def.label,
      env: Object.fromEntries(entry.envKeys.map((key) => [key, ''])),
    })
    setSeedOpen(true)
  }, [def.label])

  /** 命中内置目录的条目：直接安装（要补参数的条目由上层弹表单）。 */
  const handleBuiltin = useCallback((id: string): void => { onInstallBuiltinRef.current(id) }, [])

  /** 缺运行环境时「怎么装」的弹窗；payload 由卡片自己组装，回调只负责显示、引用因此恒稳定。 */
  const openHelp = useCallback((payload: { target: RuntimeHelpTarget | null; reason: string; entryName: string }): void => {
    setHelp(payload)
  }, [])

  /** 卡片 props 组装：窗口化分支与整列分支共用同一个入口（两处字段不会不同步）。
   *  回调全是稳定引用、其余全是原始值 —— 见文件末尾 RemoteCard 的注释。 */
  const renderCard = (entry: RemoteEntry, index: number) => (
    <RemoteCard
      key={entry.key}
      entry={entry}
      index={index}
      installed={installedIds.has(entry.id)}
      inCatalog={builtinIds.has(entry.id)}
      runtimes={runtimes}
      result={results[entry.id]}
      busy={installing.has(entry.key)}
      cvStyle={virt.fallbackStyle}
      onInstallBuiltin={handleBuiltin}
      onSeed={applySeed}
      onPrimary={primaryInstall}
      onHelp={openHelp}
    />
  )

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3'>
      {/* 源说明 + 搜索行：搜索必须显式触发（回车/按钮），避免打字时把远端 API 打爆。 */}
      <div className='flex flex-wrap items-center gap-2'>
        <div className='min-w-0 flex-1 basis-[220px]'>
          <div className='text-12 font-medium text-ink'>{def.label}</div>
          <div className='mt-0.5 truncate text-11 text-ink-4' title={def.hint}>{def.hint}</div>
        </div>
        {def.needsUrl ? (
          <Input
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run(query) }}
            placeholder='https://…/mcp.json'
            className='h-8 w-[280px]'
          />
        ) : null}
        {def.needsKey ? (
          <Input
            value={remoteKey}
            onChange={(e) => setRemoteKey(e.target.value)}
            type='password'
            placeholder='API Key（可选）'
            className='h-8 w-[180px]'
          />
        ) : null}
        <div className='relative w-[240px]'>
          <Search size={13} className='pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4' />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run(query) }}
            placeholder={'在「' + def.label + '」里搜索，回车执行'}
            className='h-8 pl-7'
          />
        </div>
        <Button variant='secondary' size='sm' disabled={loading} onClick={() => void run(query)}>
          {loading ? <Spinner /> : <Search size={13} />} 搜索
        </Button>
        <Button variant='ghost' size='sm' disabled={loading} onClick={() => void run(query, true)}>
          <RefreshCw size={13} /> 刷新
        </Button>
      </div>

      {/* 三态：加载 / 错误 / 空。错误态必须把原始信息露出来，用户才知道是限流还是网络。 */}
      {loading ? (
        <div className='flex items-center gap-2 py-10 text-12 text-ink-3'><Spinner /> 正在从「{def.label}」拉取…</div>
      ) : state.status === 'error' ? (
        <div className='flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-3 text-12 text-danger'>
          <AlertTriangle size={14} className='mt-0.5 shrink-0' />
          <div className='min-w-0 flex-1'>
            <div className='font-medium'>加载失败</div>
            <div className='mt-0.5 break-all text-11 leading-[1.6]'>{state.error}</div>
            {state.url ? <div className='mt-1 break-all font-mono text-11 opacity-70'>{state.url}</div> : null}
          </div>
          <Button variant='ghost' size='sm' className='shrink-0' onClick={() => void run(query)}>重试</Button>
        </div>
      ) : state.status === 'idle' ? (
        def.needsUrl && !remoteUrl.trim() ? (
          <div className='flex items-center gap-2 rounded-lg border border-line bg-muted px-3.5 py-3 text-12 text-ink-3'>
            <Globe size={14} className='shrink-0 text-ink-4' />
            在上面填一个返回 JSON 清单的地址（数组，或 { '{ entries: [...] }' }），填好后点「搜索」。
          </div>
        ) : (
          <Empty
            art='search'
            title={'还没有拉取「' + def.label + '」'}
            description='点「搜索」按关键词找，或直接点「刷新」看这个源的默认清单。'
            action={<Button variant='primary' size='sm' onClick={() => void run(query)}><Search size={13} /> 拉取清单</Button>}
          />
        )
      ) : !entries.length ? (
        <Empty
          art='search'
          title={query.trim() ? '没有匹配的结果' : '这个源没有返回条目'}
          description={query.trim() ? '换个关键词，或清空搜索框看该源的默认清单。' : '源可能暂时为空，也可能改过接口；换一个来源再试。'}
          action={<Button variant='secondary' size='sm' onClick={() => void run(query)}><RefreshCw size={13} /> 重试</Button>}
        />
      ) : (
        <>
          <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-11 text-ink-4'>
            <span>
              已加载 <span className='tabular-nums text-ink-2'>{entries.length}</span> 条
              {page.total !== null && page.total > entries.length ? '（源里共 ' + page.total + ' 条）' : ''}
              {page.pages > 1 ? ' · 翻了 ' + page.pages + ' 页' : ''}
            </span>
            {state.url ? <span className='min-w-0 truncate font-mono' title={state.url}>{state.url}</span> : null}
            {state.note ? <span className='shrink-0 text-warn'>{state.note}</span> : null}
            {state.fetchedAt ? <span className='ml-auto shrink-0'>{new Date(state.fetchedAt).toLocaleTimeString('zh-CN')}</span> : null}
          </div>
          {/* 滚到底自动续页（见 onResultsScroll），页脚那枚按钮是兜底。 */}
          <div
            ref={virt.attachRef}
            onScroll={(event) => { virt.handleScroll(event); onResultsScroll(event) }}
            className='min-h-0 flex-1 overflow-y-auto'
          >
            {virt.virtualized ? (
              /* 窗口化分支：撑高块定总高，每一行绝对定位 + translateY(start)。
                 overflow-anchor:none —— 位移由 useVirtualList 的锚点校正负责，不让浏览器再补一次。 */
              <div className='relative' style={{ height: virt.totalSize, overflowAnchor: 'none' }}>
                {virt.rows.map((row) => (
                  <div key={row.key} data-vi={row.index} className='absolute inset-x-0 top-0' style={virt.rowStyle(row)}>
                    {/* data-vi-grid：useVirtualList 从这里读真实列数（Tailwind 断点是唯一事实来源）。 */}
                    <div data-vi-grid className='grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3'>
                      {entries.slice(row.from, row.to).map((entry, k) => renderCard(entry, row.from + k))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* 短列表：整列渲染，布局与窗口化分支逐字一致，切换时看不到重排。 */
              <div className='grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3'>
                {entries.map((entry, i) => renderCard(entry, i))}
              </div>
            )}
            {/* 翻页页脚：加载中 / 失败可重试 / 还有更多 / 没有更多了，四态都要有话说。 */}
            <div className='mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 pb-2 text-11 text-ink-4'>
              {page.loadingMore ? (
                <span className='flex items-center gap-2 text-12 text-ink-3'><Spinner /> 正在加载下一页…</span>
              ) : page.error ? (
                <>
                  <span className='min-w-0 max-w-full truncate text-danger' title={page.error}>加载下一页失败：{page.error}</span>
                  <Button variant='secondary' size='sm' onClick={() => void loadMore()}><RefreshCw size={13} /> 重试</Button>
                </>
              ) : page.hasMore ? (
                <>
                  <span>
                    已加载 <span className='tabular-nums text-ink-2'>{entries.length}</span> 条
                    {page.total !== null && page.total > entries.length ? ' / 共 ' + page.total + ' 条' : ''}
                  </span>
                  <Button variant='secondary' size='sm' onClick={() => void loadMore()}>加载更多</Button>
                </>
              ) : (
                <span>已加载 <span className='tabular-nums text-ink-2'>{entries.length}</span> 条 · 没有更多了</span>
              )}
            </div>
          </div>
        </>
      )}

      <RemoteInstallDialog
        open={formOpen}
        onOpenChange={(open) => { setFormOpen(open); if (!open) setFormEntry(null) }}
        entry={formEntry}
        onInstalled={(result) => { if (formEntry) remember(formEntry, result) }}
      />

      <ChainInstallDialog
        open={!!chain}
        onOpenChange={(open) => { if (!open) setChain(null) }}
        runtimeId={chain?.runtimeId ?? ''}
        runtimeName={chain ? runtimeLabel(chain.runtimeId) : ''}
        toolName={chain ? (chain.entry.name || chain.entry.id) : ''}
        onInstallTool={async (overwrite) => {
          const entry = chain?.entry
          if (!entry) return EMPTY_TOOL_OUTCOME
          const plan = remoteInstallPlan(entry)
          const result = await installRemote({
            id: entry.id,
            name: remoteServerName(entry),
            transport: plan.transport,
            command: plan.command,
            args: plan.args,
            env: {},
            url: plan.url,
            overwrite,
          })
          remember(entry, result)
          const outcome: ToolInstallOutcome = {
            ok: result.ok,
            error: result.error || result.message,
            tail: result.stderrTail,
            conflict: result.conflict,
            connected: result.connected,
            toolsCount: result.toolsCount,
            message: result.message,
          }
          return outcome
        }}
        onRecheck={async () => { await useLibrary.getState().loadRuntimes() }}
        onInstalled={() => { /* 结果已在 remember 里回传调用方，这里不重复刷新 */ }}
      />

      <CustomInstallDialog open={seedOpen} onOpenChange={setSeedOpen} seed={seed} configPath={configPath} />
      <RuntimeHelpDialog
        open={!!help}
        onOpenChange={(open) => { if (!open) setHelp(null) }}
        target={help?.target ?? null}
        reason={help?.reason ?? ''}
        entryName={help?.entryName ?? ''}
        onRecheck={async () => { await useLibrary.getState().loadRuntimes() }}
      />
    </div>
  )
}

/** 一张远程 MCP 卡片：React.memo 包住。
 *  为什么要 memo：父组件在「安装中状态变化（installing 集合）」「装完的结果回显」「翻页」时会整页重渲；
 *  卡片里有几十处交互引用，几百张一起重画就是主线程被占满（＝点不动、滚不动）。
 *  所以 props 只传原始值（installed / inCatalog / busy / index）与稳定引用
 *  （entry / result / runtimes / 四个 useCallback 回调）。 */
const RemoteCard = memo(function RemoteCard({
  entry, index, installed, inCatalog, runtimes, result, busy, cvStyle,
  onInstallBuiltin, onSeed, onPrimary, onHelp,
}: {
  entry: RemoteEntry
  index: number
  installed: boolean
  inCatalog: boolean
  runtimes: RuntimeStatus[]
  result: McpInstallResult | undefined
  busy: boolean
  /** 未窗口化时的兜底渲染隔离样式（当前恒为空对象，见 useVirtualList 的 CV_MIN_ROWS）。 */
  cvStyle: CSSProperties
  onInstallBuiltin: (id: string) => void
  onSeed: (entry: RemoteEntry) => void
  onPrimary: (entry: RemoteEntry, runtimeId: string, runtimeMissing: boolean) => void
  onHelp: (payload: { target: RuntimeHelpTarget | null; reason: string; entryName: string }) => void
}) {
  const command = [entry.command, ...entry.args].filter(Boolean).join(' ')
  const heat = entry.stars !== null ? '★ ' + compact(entry.stars) : entry.downloads !== null ? '热度 ' + compact(entry.downloads) : ''
  /// 这条要用什么拉起（npx / uvx / docker…）：本机缺它的话，装上也用不了。
  const runtimeId = entryRuntimeIds(entry)[0] ?? ''
  const runtime = runtimeId ? runtimeStatusFor(runtimes, runtimeId) : null
  const runtimeMissing = !!runtime && !runtime.found
  const runtimeUnknown = !!runtimeId && runtimes.length === 0
  const plan = remoteInstallPlan(entry)
  return (
    <article
      style={{ ...cvStyle, ...stagger(index) }}
      // 边框 / 悬浮统一到令牌 v2：默认 --line，hover 与焦点由 .card-lift 抬到 --line-strong。
      className='card-lift flex animate-card-in flex-col rounded-lg border border-line bg-surface elev-1 p-4'
    >
      <div className='flex items-start gap-3'>
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', installed || result?.ok ? 'bg-primary-soft text-primary' : 'bg-sunken text-ink-3')}>
          {catalogIcon(entry.id)}
        </span>
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-1.5'>
            <h3 className='truncate text-13 font-medium text-ink' title={entry.id}>{entry.name}</h3>
            {entry.version ? <span className='shrink-0 text-11 text-ink-4'>v{entry.version}</span> : null}
          </div>
          <div className='mt-0.5 flex min-w-0 items-center gap-1.5 text-11 text-ink-4'>
            {entry.author ? <span className='min-w-0 truncate' title={entry.author}>{entry.author}</span> : null}
            {heat ? <span className='shrink-0'>{heat}</span> : null}
          </div>
        </div>
        {result?.ok ? (
          <Badge tone='ok'>已连接</Badge>
        ) : installed ? <Badge tone='ok'>已安装</Badge> : inCatalog ? <Badge tone='primary'>目录内</Badge> : null}
      </div>

      {/* 描述最少占三行高：卡片高度不会因为描述长短 / 状态回显而变
          —— 行高一变，窗口化的缓存要重量、滚动位置要重新校正，看起来就是「点一下抖一下」。 */}
      <p className='mt-2.5 line-clamp-3 min-h-[4.8em] flex-1 text-12 leading-[1.6] text-ink-3'>{entry.description || '这个源没有提供描述'}</p>

      {command ? (
        <div className='mt-2 truncate font-mono text-11 text-ink-4' title={command}>{command}</div>
      ) : entry.url ? (
        <div className='mt-2 truncate font-mono text-11 text-ink-4' title={entry.url}>{(entry.transport || 'http') + ' · ' + entry.url}</div>
      ) : (
        <div className='mt-2 text-11 text-ink-4'>源里没有给出启动方式：点「一键安装」后补一行命令或地址即可</div>
      )}
      {entry.envKeys.length ? (
        <div className='mt-1 flex items-center gap-1 truncate text-11 text-warn' title={entry.envKeys.join(', ')}>
          <KeyRound size={11} className='shrink-0' /> 需填 {entry.envKeys.length} 个环境变量
        </div>
      ) : null}

      {/* 装完的回显：连上了就把工具数摆出来，没连上就把 stderr 的第一句摆出来 */}
      {result ? (
        result.ok ? (
          <div className='mt-1.5 flex items-baseline gap-1.5 text-11 text-ok'>
            <CheckCircle2 size={11} className='shrink-0 self-center' />
            <span>已连接</span>
            <span className='text-ink-4'>·</span>
            <AnimatedNumber value={result.toolsCount} className='text-12 font-medium tabular-nums' />
            <span>个工具</span>
          </div>
        ) : result.saved && !result.conflict ? (
          <div className='mt-1.5 flex min-w-0 items-start gap-1.5 text-11 leading-[1.6] text-warn'>
            <AlertTriangle size={11} className='mt-0.5 shrink-0' />
            <span className='min-w-0 truncate' title={result.error}>{'已写入配置，但没连上：' + (result.error || '').split('\n')[0]}</span>
          </div>
        ) : null
      ) : null}

      {runtimeMissing ? (
        <div className='mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-11 text-warn'>
          <AlertTriangle size={11} className='shrink-0' />
          <span className='min-w-0 truncate'>本机未检测到 {runtimeLabel(runtimeId)}，装好它才能拉起这条</span>
          <Button
            variant='ghost'
            size='sm'
            onClick={() => onHelp({
              target: helpTargetFor(runtimeId, runtimes),
              reason: '这条要用 ' + runtimeLabel(runtimeId) + ' 拉起，引擎在本机没有检测到它。',
              entryName: entry.name,
            })}
          >
            <Wrench size={13} /> 怎么装
          </Button>
        </div>
      ) : runtimeUnknown ? (
        <div className='mt-1 truncate text-11 text-ink-4' title={'需要 ' + runtimeLabel(runtimeId)}>
          需要 {runtimeLabel(runtimeId)}：引擎未提供环境检测，安装前请确认本机已装好
        </div>
      ) : null}

      <div className='mt-3 flex flex-wrap items-center gap-1.5'>
        {entry.repository || entry.homepage ? (
          <Button
            variant='ghost'
            size='sm'
            onClick={() => {
              const url = entry.repository || entry.homepage
              window.open(url, '_blank', 'noopener,noreferrer')
            }}
          >
            <ExternalLink size={13} /> 主页
          </Button>
        ) : null}
        <span className='flex-1' />
        {inCatalog ? (
          <Button variant='primary' size='sm' title='这条在内置目录里，直接安装' onClick={() => onInstallBuiltin(entry.id)}>
            <Download size={13} /> 一键安装
          </Button>
        ) : (
          <>
            {!plan.direct && !runtimeMissing ? <Badge tone='warn'>需补参数</Badge> : null}
            <Button
              variant='ghost'
              size='sm'
              title='生成可粘贴进 config/mcp_servers.json 的配置片段（想自己改配置文件时用）'
              onClick={() => onSeed(entry)}
            >
              生成配置
            </Button>
            <Button
              variant='primary'
              size='sm'
              disabled={busy}
              title={runtimeMissing
                ? '先装上 ' + runtimeLabel(runtimeId) + '，再装这条（一张进度卡两步）'
                : plan.direct
                  ? '按清单推断的命令直接装：' + (plan.basis || '一键安装')
                  : '清单信息不全，补一行命令或地址后再装'}
              onClick={() => onPrimary(entry, runtimeId, runtimeMissing)}
            >
              {/* 图标位固定 14×14（Spinner 就是 h-3.5）：安装中换图标不许把按钮撑高。
                  已有安装/装完回显这类「卡片长高」由窗口化的重新测量 + 锚点校正兜住。 */}
              <span className='inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center' aria-hidden>
                {busy ? <Spinner /> : runtimeMissing ? <Wrench size={13} /> : <Download size={13} />}
              </span>
              {runtimeMissing ? '一键装环境并安装' : '一键安装'}
            </Button>
          </>
        )}
      </div>
    </article>
  )
})
