/** 第三方 SKILL 市场浏览器：官方清单（内置固定地址）+ 自定义清单（输入框，记住
 *  coomi.skillSourceUrl.v1）两个来源；沿用远程 MCP 的「取数 + 分页 + 去重」架构。
 *
 *  卡片动作：
 *    · 「安装」→ 先弹确认框：展示清单（名称/描述/平台/运行时）+ 来源 URL + 使用声明；
 *      platforms 不适配当前系统时禁用并给中文原因（与引擎预检同口径）；
 *    · 已安装 → 启停（Switch 走 /api/catalog/skills/{id}/enabled）+ 卸载（DELETE）；
 *    · 名称/描述走 translate.ts 的 fetchTranslation（引擎词表 → 本地缓存 → 免费 API，
 *      失败一律回原名）。
 *
 *  安装请求 POST /api/catalog/skills/install-remote { source:'manifest', url, id }，
 *  引擎按 id 从清单里取条目、预检后解压进 home/skills/{id} 并登记 index，
 *  返回 per-条目状态（installed / skipped / failed + reason）。 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Download, RefreshCw, Search, Trash2,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { useEngine } from '../../stores/engine'
import { useLibrary } from '../../stores/library'
import { Button } from '../../components/ui/Button'
import { Input, Badge } from '../../components/ui/Input'
import { Spinner } from '../../components/ui/Controls'
import { Empty } from '../../components/ui/Card'
import { Dialog } from '../../components/ui/Overlay'
import { catalogIcon } from './catalogMeta'
import {
  SKILL_SOURCES, SKILL_SOURCE_URL_KEY, skillSourceDef, fetchSkillManifest,
  platformLabel, platformUnavailableReason,
  type SkillSourceEntry, type SkillSourceKey,
} from './skillSources'
import { fetchTranslation, type SkillTranslation } from './translate'

const PAGE_SIZE = 24

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 每条的最近安装结果：卡片上直接回显「已安装 / 跳过 / 失败」。 */
interface Outcome {
  status: 'installed' | 'skipped' | 'failed'
  reason?: string
}

/** 模块级结果缓存：换视图/换源来回切不重复联网（与 RemoteMcpBrowser 的 PAGE_MEMO 同思路）。 */
const SOURCE_MEMO = new Map<SkillSourceKey, {
  url: string
  entries: SkillSourceEntry[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  note: string
  fetchedAt: number
  outcome: Record<string, Outcome>
}>()

const EMPTY_MEMO = { url: '', entries: [] as SkillSourceEntry[], status: 'idle' as const, error: '', note: '', fetchedAt: 0, outcome: {} as Record<string, Outcome> }

export function SkillMarketBrowser({ installedSkills, onNotice, onChanged }: {
  /** /api/runtime/installed 里的 skills 列表（id / enabled），用于已安装标记与启停。 */
  installedSkills: Array<{ id: string; name?: string; enabled?: boolean }>
  onNotice: (text: string) => void
  /** 装卸/启停完成后通知上层刷新「目录 + 已安装」两条链路。 */
  onChanged: () => void
}) {
  const [source, setSource] = useState<SkillSourceKey>('official')
  const [customUrl, setCustomUrl] = useState(() => {
    try { return localStorage.getItem(SKILL_SOURCE_URL_KEY) ?? '' } catch { return '' }
  })
  const [query, setQuery] = useState('')
  const [memo, setMemo] = useState(() => SOURCE_MEMO.get('official') ?? { ...EMPTY_MEMO })
  const [sourceKey, setSourceKey] = useState<SkillSourceKey>('official')
  const [pages, setPages] = useState(1)
  const [confirming, setConfirming] = useState<SkillSourceEntry | null>(null)
  const [busy, setBusy] = useState('')
  const runtimes = useLibrary((s) => s.runtimes)

  const sourceUrl = useMemo(() => (source === 'custom' ? customUrl.trim() : ''), [source, customUrl])

  /** 提交自定义地址时记住（coomi.skillSourceUrl.v1）；回车/点按钮都落一次。 */
  const saveCustomUrl = useCallback(() => {
    try { localStorage.setItem(SKILL_SOURCE_URL_KEY, customUrl.trim()) } catch { /* 忽略 */ }
  }, [customUrl])

  /** 拉取当前源的清单（首屏/换源/重试）；结果按 id 合并进 memo。 */
  const run = useCallback(async (silent = true): Promise<void> => {
    saveCustomUrl()
    setMemo((prev) => ({ ...prev, status: 'loading', error: '' }))
    try {
      const result = await fetchSkillManifest({ key: source, url: sourceUrl })
      const next = {
        url: result.url,
        entries: result.entries,
        status: 'ready' as const,
        error: '',
        note: result.note,
        fetchedAt: Date.now(),
        outcome: SOURCE_MEMO.get(source)?.outcome ?? {},
      }
      SOURCE_MEMO.set(source, next)
      setMemo(next)
      setPages(1)
      if (!silent) {
        const def = skillSourceDef(source)
        onNotice('已从「' + def.label + '」取得 ' + result.entries.length + ' 条' + (result.note ? '（' + result.note + '）' : ''))
      }
    } catch (error) {
      const message = describe(error)
      setMemo((prev) => ({ ...prev, status: 'error', error: message, entries: [] }))
      if (!silent) onNotice('「' + skillSourceDef(source).label + '」拉取失败：' + message)
    }
  }, [source, sourceUrl, saveCustomUrl, onNotice])

  /** 换源：官方清单默认自动拉；自定义源没填地址时不自动拉（避免空转报错）。 */
  const switchSource = useCallback((next: SkillSourceKey): void => {
    setSource(next)
    setSourceKey(next)
    setConfirming(null)
    setQuery('')
    const cached = SOURCE_MEMO.get(next)
    if (cached && cached.status === 'ready') { setMemo({ ...cached }); return }
    if (next === 'custom' && !customUrl.trim()) { setMemo({ ...EMPTY_MEMO }); return }
    setMemo({ ...EMPTY_MEMO, status: 'loading' })
    void run(true)
  }, [customUrl, run])

  /** 双来源默认源官方清单；进来自动拉一次。 */
  useEffect(() => {
    const cached = SOURCE_MEMO.get(sourceKey)
    if (cached && cached.status === 'ready') { setMemo({ ...cached }); return }
    if (sourceKey === 'custom' && !customUrl.trim()) { setMemo({ ...EMPTY_MEMO }); return }
    void run(true)
    // 只按源出发；memo/url 变化由各回调负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])

  /** 名称翻译：走引擎翻译层（词表 → 缓存 → API，失败回原名）。 */
  const [translations, setTranslations] = useState<Record<string, SkillTranslation>>({})
  useEffect(() => {
    const ids = memo.entries.map((entry) => entry.id)
    if (!ids.length) { setTranslations({}); return }
    let cancelled = false
    void fetchTranslation(ids).then((reply) => { if (!cancelled) setTranslations(reply) })
    return () => { cancelled = true }
  }, [memo.entries])

  const installedById = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const item of installedSkills) map.set(item.id.toLowerCase(), item.enabled !== false)
    return map
  }, [installedSkills])

  const translated = (entry: SkillSourceEntry): { name: string; description: string } => {
    const hit = translations[entry.id]
    return {
      name: hit?.name || entry.name || entry.id,
      description: hit?.description || entry.description || '',
    }
  }

  /** 客户端搜索：名称 / 描述 / id 都匹配（清单源不支持服务端搜索）。 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return memo.entries
    return memo.entries.filter((entry) => {
      const t = translated(entry)
      return entry.id.toLowerCase().includes(q)
        || t.name.toLowerCase().includes(q)
        || t.description.toLowerCase().includes(q)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, memo.entries, translations])

  const shown = filtered.slice(0, pages * PAGE_SIZE)
  const hasMore = shown.length < filtered.length

  /* ── 安装 ── */

  const installEntry = async (entry: SkillSourceEntry): Promise<void> => {
    setBusy(entry.id)
    setConfirming(null)
    try {
      // 引擎按 id 从清单中取这条并安装：{ source, url, id }。
      const manifestUrl = memo.url || customUrl.trim()
      const data = await useEngine.getState().api<{ results?: Array<{ id: string; status: string; reason?: string }> }>('/api/catalog/skills/install-remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'manifest', url: manifestUrl, id: entry.id }),
      })
      const result = (data?.results ?? []).find((item) => item.id === entry.id)
      const outcome: Outcome = result?.status === 'installed'
        ? { status: 'installed' }
        : { status: 'skipped', reason: result?.reason || '已安装或预检未通过' }
      setMemo((prev) => ({ ...prev, outcome: { ...prev.outcome, [entry.id]: outcome } }))
      if (outcome.status === 'installed') onNotice('已安装 ' + (entry.name || entry.id))
      else onNotice('未安装 ' + (entry.name || entry.id) + '：' + (outcome.reason ?? ''))
      await onChanged()
    } catch (error) {
      onNotice('安装 ' + (entry.name || entry.id) + ' 失败：' + describe(error))
    } finally {
      setBusy('')
    }
  }

  /** 启停：/api/catalog/skills/{id}/enabled。 */
  const toggleEntry = async (id: string, enabled: boolean): Promise<void> => {
    setBusy(id)
    try {
      await useEngine.getState().api('/api/catalog/skills/' + encodeURIComponent(id) + '/enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      await onChanged()
    } catch (error) {
      onNotice((enabled ? '启用失败：' : '停用失败：') + describe(error))
    } finally {
      setBusy('')
    }
  }

  /** 卸载：DELETE /api/catalog/skills/{id}。 */
  const uninstallEntry = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await useEngine.getState().api('/api/catalog/skills/' + encodeURIComponent(id), { method: 'DELETE' })
      setMemo((prev) => {
        const outcome = { ...prev.outcome }
        delete outcome[id]
        return { ...prev, outcome }
      })
      await onChanged()
      onNotice('已卸载 ' + id)
    } catch (error) {
      onNotice('卸载失败：' + describe(error))
    } finally {
      setBusy('')
    }
  }

  /* ── 渲染 ── */

  const renderCard = (entry: SkillSourceEntry, i: number) => {
    const t = translated(entry)
    const installed = installedById.has(entry.id.toLowerCase())
    const enabled = installedById.get(entry.id.toLowerCase()) !== false
    const platformReason = platformUnavailableReason(entry.platforms)
    const outcome = memo.outcome[entry.id]
    const outcomeInstalled = outcome?.status === 'installed'
    const shownAsInstalled = installed || outcomeInstalled
    const requires = entry.requires ?? []
    const missingRequires = requires.filter((req) => {
      const key = req.trim().toLowerCase()
      if (!key || !runtimes.length) return false
      return !runtimes.some((runtime) => runtime.id === key || runtime.label.toLowerCase().includes(key))
    })
    return (
      <article
        key={entry.key}
        style={{ animationDelay: Math.min(i, 10) * 20 + 'ms' }}
        className='card-lift flex animate-card-in flex-col rounded-lg border border-line bg-surface elev-1 p-4'
      >
        <div className='flex items-start gap-3'>
          <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', shownAsInstalled ? 'bg-primary-soft text-primary' : 'bg-sunken text-ink-3')}>
            {catalogIcon(entry.id)}
          </span>
          <div className='min-w-0 flex-1'>
            <div className='flex items-center gap-1.5'>
              <h3 className='truncate text-13 font-medium text-ink' title={entry.id}>{t.name}</h3>
              {shownAsInstalled ? <CheckCircle2 size={13} className='shrink-0 text-ok' /> : null}
            </div>
            <div className='mt-0.5 flex min-w-0 items-center gap-1.5 text-11 text-ink-4'>
              <span className='min-w-0 truncate font-mono'>{entry.id}</span>
              {entry.repository ? <span className='min-w-0 truncate' title={entry.repository}>{entry.repository}</span> : null}
            </div>
          </div>
          {shownAsInstalled ? <Badge tone='ok'>已安装</Badge> : null}
        </div>

        <p className='mt-2.5 line-clamp-2 flex-1 text-12 leading-[1.6] text-ink-3'>{t.description || '这个来源没有提供描述'}</p>

        {/* 平台与运行时声明 */}
        <div className='mt-2 flex flex-wrap items-center gap-1.5'>
          {entry.platforms.length ? (
            <Badge tone={platformReason ? 'warn' : 'neutral'} title={platformReason ?? undefined}>
              {entry.platforms.map(platformLabel).join(' / ')}
            </Badge>
          ) : (
            <Badge tone='neutral'>全平台</Badge>
          )}
          {requires.length ? (
            <Badge tone={missingRequires.length ? 'warn' : 'neutral'} title={missingRequires.length ? '本机未检测到：' + missingRequires.join('、') : undefined}>
              需要 {requires.join(' / ')}
            </Badge>
          ) : null}
        </div>
        {platformReason ? <p className='mt-1.5 flex items-start gap-1.5 text-11 leading-[1.6] text-warn'><AlertTriangle size={12} className='mt-0.5 shrink-0' />{platformReason}</p> : null}
        {missingRequires.length ? (
          <p className='mt-1.5 flex items-start gap-1.5 text-11 leading-[1.6] text-warn'>
            <AlertTriangle size={12} className='mt-0.5 shrink-0' />本机未检测到 {missingRequires.join('、')}，装好后才能用它
          </p>
        ) : null}
        {outcome?.status && outcome.status !== 'installed' ? (
          <p className='mt-1.5 flex items-start gap-1.5 text-11 leading-[1.6] text-warn'><AlertTriangle size={12} className='mt-0.5 shrink-0' />{outcome.reason || '未安装'}</p>
        ) : null}

        <div className='mt-3 flex flex-wrap items-center gap-1.5'>
          {shownAsInstalled ? (
            <>
              <SwitchInline checked={enabled} disabled={busy === entry.id} onChange={(next) => void toggleEntry(entry.id, next)} />
              <span className='text-11 text-ink-4'>{enabled ? '启用中' : '已停用'}</span>
              <span className='flex-1' />
              <Button variant='ghost' size='sm' disabled={busy === entry.id} onClick={() => void uninstallEntry(entry.id)}>
                <Trash2 size={13} /> 卸载
              </Button>
            </>
          ) : (
            <>
              <span className='flex-1' />
              <Button
                variant='primary'
                size='sm'
                disabled={!!platformReason || busy === entry.id}
                title={platformReason ?? '先确认清单与来源，再安装' + (requires.length ? '（需要 ' + requires.join(' / ') + '）' : '')}
                onClick={() => setConfirming(entry)}
              >
                {busy === entry.id ? <Spinner /> : <Download size={13} />} 安装
              </Button>
            </>
          )}
        </div>
      </article>
    )
  }

  const def = skillSourceDef(source)
  const confirmingTranslated = confirming ? translated(confirming) : null

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3'>
      {/* 来源行：官方（固定地址） / 自定义（URL 输入，回车记住） */}
      <div className='flex flex-wrap items-center gap-2'>
        <div className='flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-muted p-0.5'>
          {SKILL_SOURCES.map((item) => (
            <button
              key={item.key}
              type='button'
              onClick={() => switchSource(item.key)}
              className={cn(
                'h-7 rounded px-3 text-12 transition-colors',
                source === item.key ? 'bg-surface text-ink shadow-elev-1' : 'text-ink-3 hover:text-ink',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        {def.needsUrl ? (
          <Input
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run(false) }}
            placeholder='https://…/skills.json'
            className='h-8 w-[300px]'
          />
        ) : null}
        <div className='relative w-[220px]'>
          <Search size={13} className='pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4' />
          <Input value={query} onChange={(e) => { setQuery(e.target.value); setPages(1) }} placeholder='搜索技能（名称 / 描述）' className='h-8 pl-7' />
        </div>
        <span className='min-w-0 flex-1' />
        <Button variant='secondary' size='sm' disabled={memo.status === 'loading'} onClick={() => void run(false)}>
          {memo.status === 'loading' ? <Spinner /> : <RefreshCw size={13} />} 拉取
        </Button>
      </div>
      <div className='min-w-0 truncate text-11 text-ink-4' title={memo.url}>
        {source === 'official' ? '官方清单（内置固定地址）' : '自定义清单'}：{memo.url || '尚未拉取'}
      </div>

      {/* 三态：加载 / 错误 / 空 */}
      {memo.status === 'loading' ? (
        <div className='flex items-center gap-2 py-10 text-12 text-ink-3'><Spinner /> 正在从「{def.label}」拉取…</div>
      ) : memo.status === 'error' ? (
        <div className='flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-3 text-12 text-danger'>
          <AlertTriangle size={14} className='mt-0.5 shrink-0' />
          <div className='min-w-0 flex-1'>
            <div className='font-medium'>拉取失败</div>
            <div className='mt-0.5 break-all text-11 leading-[1.6]'>{memo.error}</div>
          </div>
          <Button variant='ghost' size='sm' className='shrink-0' onClick={() => void run(false)}>重试</Button>
        </div>
      ) : memo.status === 'idle' ? (
        <div className='flex items-center gap-2 rounded-lg border border-line bg-muted px-3.5 py-3 text-12 text-ink-3'>
          <AlertTriangle size={14} className='shrink-0 text-ink-4' />
          在上面的输入框填一个返回 { '{ "skills": [...] }' } 的清单地址，再点「拉取」。
        </div>
      ) : !memo.entries.length ? (
        <Empty
          art='search'
          title='这个来源没有返回可安装的技能'
          description={memo.note || '换一个来源，或换一个清单地址再试。'}
          action={<Button variant='secondary' size='sm' onClick={() => void run(false)}><RefreshCw size={13} /> 重新拉取</Button>}
        />
      ) : !shown.length ? (
        <Empty art='search' title='没有匹配的结果' description={'换个关键词，或清空搜索框看全部 ' + filtered.length + ' 条。'} action={<Button variant='secondary' size='sm' onClick={() => setQuery('')}>清空搜索</Button>} />
      ) : (
        <>
          <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-11 text-ink-4'>
            <span>
              已加载 <span className='tabular-nums text-ink-2'>{shown.length}</span> 条
              {filtered.length !== shown.length ? <span> / 过滤后 <span className='tabular-nums text-ink-2'>{filtered.length}</span> 条</span> : null}
            </span>
            {memo.note ? <span className='shrink-0 text-warn'>{memo.note}</span> : null}
            {memo.fetchedAt ? <span className='ml-auto shrink-0'>{new Date(memo.fetchedAt).toLocaleTimeString('zh-CN')}</span> : null}
          </div>
          <div className='min-h-0 flex-1 overflow-y-auto'>
            <div className='grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3'>
              {shown.map((entry, i) => renderCard(entry, i))}
            </div>
            <div className='mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 pb-2 text-11 text-ink-4'>
              {hasMore ? (
                <>
                  <span>已加载 <span className='tabular-nums text-ink-2'>{shown.length}</span> / {filtered.length} 条</span>
                  <Button variant='secondary' size='sm' onClick={() => setPages((prev) => prev + 1)}>加载更多</Button>
                </>
              ) : (
                <span>已加载 <span className='tabular-nums text-ink-2'>{shown.length}</span> 条 · 没有更多了</span>
              )}
            </div>
          </div>
        </>
      )}

      {/* 安装确认：清单 + 来源 + 使用声明；platforms 不适配禁用并给原因 */}
      <Dialog
        open={!!confirming}
        onOpenChange={(open) => { if (!open) setConfirming(null) }}
        title={'安装第三方技能：' + (confirmingTranslated?.name || confirming?.id || '')}
        width={520}
        footer={
          confirming ? (
            <>
              <Button variant='ghost' onClick={() => setConfirming(null)}>取消</Button>
              <Button
                variant='primary'
                disabled={!!platformUnavailableReason(confirming.platforms)}
                onClick={() => { const entry = confirming; void installEntry(entry) }}
              >
                <Download size={13} /> 确认安装
              </Button>
            </>
          ) : null
        }
      >
        {confirming && confirmingTranslated ? (
          <div className='flex flex-col gap-3'>
            <p className='text-13 leading-[1.7] text-ink-2'>{confirmingTranslated.description || '（来源未提供描述）'}</p>
            <div className='rounded-lg border border-line bg-muted p-3'>
              <div className='text-11 text-ink-4'>条目信息</div>
              <div className='mt-1 flex flex-wrap items-center gap-1.5'>
                <Badge tone='neutral'>{confirming.platforms.length ? confirming.platforms.map(platformLabel).join(' / ') : '全平台'}</Badge>
                <Badge tone='neutral'>id: {confirming.id}</Badge>
                {confirming.repository ? <Badge tone='neutral'>{confirming.repository}</Badge> : null}
                {confirming.requires.length ? <Badge tone='neutral'>需要 {confirming.requires.join(' / ')}</Badge> : null}
              </div>
            </div>
            <div className='rounded-lg border border-line bg-muted p-3'>
              <div className='text-11 text-ink-4'>来源</div>
              <div className='mt-1 break-all font-mono text-11 leading-[1.6] text-ink-2'>{memo.url || '（未拉取）'}</div>
            </div>
            <div className='rounded-lg border border-warn/40 bg-warn-soft p-3'>
              <div className='text-11 font-medium text-warn'>使用声明</div>
              <p className='mt-1 text-12 leading-[1.7] text-ink-2'>
                该技能来自第三方清单（{def.label}），安装会把它声明的仓库或压缩包下载并解压到本机技能目录，
                之后 Agent 可能按清单里的说明执行脚本。请确认来源可信、内容与你预期一致。
              </p>
              {platformUnavailableReason(confirming.platforms) ? (
                <p className='mt-2 flex items-start gap-1.5 text-11 leading-[1.6] text-warn'>
                  <AlertTriangle size={12} className='mt-0.5 shrink-0' />{platformUnavailableReason(confirming.platforms)}（已禁用安装）
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}

/** 卡片上的小开关（复刻 ui/Controls 的 Switch 样式语义的最小实现）。 */
function SwitchInline({ checked, disabled, onChange, 'aria-label': ariaLabel }: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  'aria-label'?: string
}) {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-10 shrink-0 rounded-full border transition-[background-color,border-color] duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
        'border-line-strong bg-control-2 shadow-press',
        checked && 'border-primary bg-primary',
        'disabled:cursor-not-allowed disabled:opacity-45',
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute top-1/2 block size-4 -translate-y-1/2 rounded-full bg-white shadow-elev-1 transition-[left] duration-[var(--motion-base)] ease-[var(--ease-spring)]',
          checked ? 'left-[20px]' : 'left-[4px]',
        )}
      />
    </button>
  )
}
