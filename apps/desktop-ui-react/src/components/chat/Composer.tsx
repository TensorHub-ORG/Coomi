import { useEffect, useMemo, useRef, useState } from 'react'
// 芯片的进出场都交给 motion：m.span + AnimatePresence 管退场，features 由 App 根的
// LazyMotion（domAnimation）提供，本组件不挂 Provider。
import { AnimatePresence, m } from 'motion/react'
import { motionOn } from '../../lib/motionPref'
import { EASE_IN_QUAD, RISE_IN, RISE_SHOWN, SEC_FAST, SPRING_SNAP } from '../ui/motion'
import { AlertTriangle, ArrowUp, Brain, ChevronRight, FolderOpen, KeyRound, ListOrdered, Paperclip, Shield, ShieldAlert, Slash, Sparkles, Square, Wand2, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../lib/cn'
import { ipc } from '../../lib/ipc'
import { prettyPath, shortPath, samePath, fmtTokens, fmtBytes } from '../../lib/format'
import { useEngine } from '../../stores/engine'
import { useSession } from '../../stores/session'
import { useLibrary } from '../../stores/library'
import { EFFORT_LABELS, PERMISSION_LABELS, useAgent, type PermissionMode, type ReasoningEffort } from '../../stores/agent'
import { useUi } from '../../stores/ui'
import { Button } from '../ui/Button'
import { FileBadge } from '../ui/FileBadge'
import { attachmentName } from './AttachmentCard'
import { QuoteChip } from './QuoteBlock'
import { StatsBar } from './StatsBar'
import { Menu } from '../ui/Menu'
import { Tip } from '../ui/Overlay'
import { statPath } from '../shell/dockShared'
// 插件：斜杠命令（输入 / 弹出、选中填模板）与人设提示条共用一份 store 与纯逻辑。
import {
  effectiveEnabled,
  pluginName,
  usePluginStore,
  type PluginEntry,
} from '../plugins/pluginStore'
import {
  applySlashTemplate,
  collectPluginSlash,
  detectSlashQuery,
  filterSlash,
  type SlashItem,
} from '../plugins/slashCommands'
// 插件主题 parts（v1.7）：发送键 / 输入框 / 工具栏的部件级外观经它订阅（引擎写 data-theme-part-* 属性）。
import { resolveImagePath, useThemeParts } from '../plugins/PluginThemeEngine'

interface Provider { id: string; name?: string; model?: string; models?: string[]; active?: boolean }

/** 芯片退场时长（秒）：= --motion-fast。进场是**真弹性**（spring，时长由物理量推出来，
     写不了也不需要写），所以这里只留退场这一档。 */
const CHIP_EXIT_S = SEC_FAST

/** 引用芯片最多平铺几条，多的折成「+N」——引用是长文本，铺开会把输入框顶得看不见。 */
const QUOTE_COLLAPSE_AT = 2

function ContextRing() {
  const u = useEngine((s) => s.usage)
  const ratio = Math.min(1, u.contextRatio || (u.contextWindow ? u.contextUsed / u.contextWindow : 0))
  const r = 7
  const c = 2 * Math.PI * r
  return (
    <Tip label={u.contextWindow ? '上下文 ' + fmtTokens(u.contextUsed) + ' / ' + fmtTokens(u.contextWindow) : '上下文用量'}>
      <span className='flex items-center gap-1.5 px-1 text-11 text-ink-3'>
        <svg width='18' height='18' viewBox='0 0 18 18' className='-rotate-90'>
          <circle cx='9' cy='9' r={r} fill='none' stroke='currentColor' strokeWidth='2' className='text-line' />
          <circle
            cx='9' cy='9' r={r} fill='none' strokeWidth='2' strokeLinecap='round'
            stroke={ratio > 0.85 ? 'var(--danger)' : 'var(--primary)'}
            strokeDasharray={c}
            strokeDashoffset={c * (1 - ratio)}
          />
        </svg>
        {u.contextWindow ? Math.round(ratio * 100) + '%' : '—'}
      </span>
    </Tip>
  )
}

/** 工作目录：会话级 cwd，随时可改；空态下放大成主操作。 */
export function WorkdirBar({ prominent }: { prominent?: boolean }) {
  const pendingCwd = useSession((s) => s.pendingCwd)
  const sessionId = useSession((s) => s.sessionId)
  const sessions = useSession((s) => s.sessions)
  const applyCwd = useSession((s) => s.applyCwd)
  const rememberCwd = useSession((s) => s.rememberCwd)
  const engineCwd = useEngine((s) => s.cwd)

  const current = sessions.find((s) => s.id === sessionId)
  const path = prettyPath(current?.cwd || pendingCwd || engineCwd || '')
  const isDefault = !path || samePath(path, engineCwd)

  const pick = async (): Promise<void> => {
    const dir = await ipc<string | null>('pick_directory')
    if (dir) await applyCwd(dir)
  }

  const items = [
    { label: '在资源管理器中打开', icon: <FolderOpen size={14} />, onSelect: () => { if (path) void ipc('open_path', { path }) } },
    { divider: true },
    { label: '恢复默认目录', icon: <Sparkles size={14} />, onSelect: () => { rememberCwd(''); if (sessionId && engineCwd) void applyCwd(engineCwd).catch(() => {}) } },
  ]

  return (
    <div
      data-workdir
      className={cn(
        'flex w-full items-center gap-2 rounded-lg border border-dashed border-line-strong bg-muted',
        prominent ? 'h-12 px-3.5' : 'h-8 border-solid bg-surface px-2.5',
      )}
    >
      <FolderOpen size={prominent ? 15 : 13} className='shrink-0 text-ink-3' />
      <span className={cn('shrink-0 text-ink-3', prominent ? 'text-13' : 'text-11')}>工作目录</span>
      <Menu
        align='start'
        items={items}
        trigger={
          <button
            type='button'
            title={path}
            className={cn('min-w-0 flex-1 truncate text-left transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:text-ink', prominent ? 'text-13 text-ink' : 'font-mono text-11 text-ink-2')}
          >
            {path ? shortPath(path, prominent ? 60 : 42) : '未设置'}
          </button>
        }
      />
      {isDefault ? <span className='shrink-0 rounded-[5px] bg-primary-soft px-1.5 text-11 text-primary'>默认</span> : null}
      <Button variant='ghost' size='sm' onClick={() => void pick()}>
        选择目录
      </Button>
    </div>
  )
}

export function Composer({ hero }: { hero?: boolean }) {
  const draft = useSession((s) => s.draft)
  const setDraft = useSession((s) => s.setDraft)
  const send = useSession((s) => s.send)
  const cancel = useSession((s) => s.cancel)
  const streaming = useSession((s) => s.streaming)
  const hasMessages = useSession((s) => s.messages.length > 0)
  const connected = useSession((s) => s.connected)
  const selectModel = useSession((s) => s.selectModel)
  // 当前模型以会话 store 为准（引擎回读校验过）：切换模型后立刻换名字。
  // 之前用的是 /api/providers 的本地副本 p.model，切完名字不变，要重启才更新。
  const sessionModel = useSession((s) => s.currentModel)
  const sessionProviderId = useSession((s) => s.currentProviderId)
  const ready = useEngine((s) => s.ready)
  const api = useEngine((s) => s.api)
  const skills = useLibrary((s) => s.skills)
  const loadCatalog = useLibrary((s) => s.loadCatalog)
  const setView = useUi((s) => s.setView)
  const effort = useAgent((s) => s.effort)
  const permission = useAgent((s) => s.permission)
  const setEffort = useAgent((s) => s.setEffort)
  const setPermission = useAgent((s) => s.setPermission)
  const loadAgent = useAgent((s) => s.load)
  const providerRevision = useAgent((s) => s.providerRevision)

  /// 引用芯片（可多条）：发送时走结构化 quotes 字段，不再把引用文字拼进正文。
  /// 附件与引用都放在 session store 里、按**会话 id 分桶**（见 lib/sessionInput）：
  /// 切会话时由 store 先 flush 当前会话再 load 目标会话，输入区不会串味。
  const quotes = useSession((s) => s.quotes)
  const removeQuote = useSession((s) => s.removeQuote)
  const clearQuotes = useSession((s) => s.clearQuotes)
  const attachments = useSession((s) => s.attachments)
  const addAttachments = useSession((s) => s.addAttachments)
  const removeAttachment = useSession((s) => s.removeAttachment)
  const setAttachmentSize = useSession((s) => s.setAttachmentSize)
  /// 别处发来的「聚焦输入框」信号（划选浮条的「提问」加完引用芯片后会用它）。
  const focusComposerAt = useUi((s) => s.composerFocusAt)
  /// 运行中插话的处理方式（排队 / 打断）：偏好落在 stores/ui 的 prefs 里，默认排队。
  const insertMode = useUi((s) => s.prefs.insertMode)
  const setPrefs = useUi((s) => s.setPrefs)
  const linkError = useSession((s) => s.linkError)
  const connecting = useSession((s) => s.connecting)
  /// 「还没有会话」与「真的断线」是两件事：以前两者共用一句「与引擎的连接已断开」，
  /// 在全新安装的机器上（会话列表为空、连接自然建立不起来）会把人带偏到网络问题上。
  const noSession = useSession((s) => s.sessionId === '')
  const reconnect = useSession((s) => s.reconnect)
  const [providers, setProviders] = useState<Provider[]>([])
  /// 每个厂商实际拉取到的模型列表（优先于设置里存的 models——旧数据可能只存了一个模型）。
  const [discovered, setDiscovered] = useState<Record<string, string[]>>({})
  const [dragging, setDragging] = useState(false)
  /// 断线横幅延迟显示：快速切会话时不闪。
  const [showLinkBanner, setShowLinkBanner] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [recentModels, setRecentModels] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('coomi.recentModels.v1') ?? '[]') as string[] } catch { return [] }
  })
  const [skill, setSkill] = useState('')
  /// 插件斜杠命令：输入 / 弹出、选中把 template 填入输入框（{{cursor}} 落光标）。
  /// 只订阅 store 的稳定引用（plugins / prefs），派生结果用 useMemo 缓存（渲染风暴 #185 的教训）。
  const pluginEntries = usePluginStore((s) => s.plugins)
  const pluginPrefs = usePluginStore((s) => s.prefs)
  const pluginSetEnabled = usePluginStore((s) => s.setEnabled)
  const allSlash = useMemo(() => collectPluginSlash(pluginEntries, pluginPrefs), [pluginEntries, pluginPrefs])
  const [slashQuery, setSlashQuery] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const slashItems = useMemo(() => filterSlash(allSlash, slashQuery), [allSlash, slashQuery])
  /// 启用了带 persona 的插件：Composer 上方显示「插件人设已生效」并可一键关闭。
  const personaPlugin = useMemo(() => {
    for (const p of pluginEntries) {
      if (effectiveEnabled(p, pluginPrefs) && p.persona?.name) return p
    }
    return null
  }, [pluginEntries, pluginPrefs])
  /// 引用芯片是否展开（>QUOTE_COLLAPSE_AT 条时默认折叠成 +N）。
  const [quotesOpen, setQuotesOpen] = useState(false)
  /// 芯片（引用 / 技能 / 附件）的退场标记：打上标记的元素由 AnimatePresence 播完
  /// --motion-fast 的缩放淡出，再在 onExitComplete 里真正摘掉（见 settle）。
  const [leaving, setLeaving] = useState<string[]>([])
  const area = useRef<HTMLTextAreaElement>(null)
  /// 关掉动效（[data-motion=off] / 系统 prefers-reduced-motion）时，芯片的整条动画链路都要让路：
  /// initial / exit 全关、dismiss 直接摘——否则会卡在「等一个永远不播的退场」上（这是 JS 动画，
  /// base.css 把令牌归零压不到它，必须在这里问同一句 motionOn()）。
  const animated = motionOn()

  /// v1.7：插件主题 parts —— 发送键 / 输入框 / 工具栏的部件级外观（缺省 null 走内置样式）。
  const themeParts = useThemeParts()
  const sendBtn = themeParts?.composer?.sendButton
  const inputParts = themeParts?.composer?.input
  const toolbarParts = themeParts?.composer?.toolbar
  const sendLeft = sendBtn?.position === 'left'

  /// 退场交给 AnimatePresence：标记成 leaving 让它播 exit，动画播完（onExitComplete）
  /// 才真正从列表里摘掉，不再手写 setTimeout 对时间。
  /// 回调不带参数，所以「刚退场的是谁」按点击顺序记在一个队列里，settle 时出队一个。
  const exitQueue = useRef<string[]>([])
  /// 真正把某一枚芯片从数据里摘掉。
  const applyRemoval = (key: string): void => {
    if (key.startsWith('file:')) removeAttachment(key.slice(5))
    else if (key.startsWith('quote:')) removeQuote(key.slice(6))
    else if (key === 'skill') setSkill('')
  }
  const dismiss = (key: string): void => {
    if (leaving.includes(key)) return
    // 关了动效：没有退场可等，直接摘。
    if (!animated) { applyRemoval(key); return }
    exitQueue.current.push(key)
    setLeaving((l) => [...l, key])
  }
  const settle = (): void => {
    const key = exitQueue.current.shift()
    if (!key) return
    setLeaving((l) => l.filter((x) => x !== key))
    applyRemoval(key)
  }
  /// 入场：8px 上浮 + 淡入，**duration 交给 spring**（芯片是「被放进来」的小东西，
  /// 弹性比 tween 更像实物，被打断时还能从当前速度接着走）；退场 140ms + in-quad 缩到 0.88。
  /// 两段都只动 transform / opacity。关动效时 initial / exit 全关，元素直接出现 / 直接消失。
  const chipEnter = animated ? RISE_IN : false
  const chipShown = RISE_SHOWN
  const chipExit = animated
    ? { opacity: 0, scale: 0.88, transition: { duration: CHIP_EXIT_S, ease: EASE_IN_QUAD } }
    : undefined
  const chipMotion = animated ? SPRING_SNAP : { duration: 0 }

  useEffect(() => {
    if (!ready) return
    void api<{ providers?: Provider[] }>('/api/providers')
      .then(async (d) => {
        const list = d.providers ?? []
        setProviders(list)
        // 设置里存的 models 可能是旧流程只存了一个：这里自动向上游拉全量，
        // 保证对话页能选到该厂商的**所有**模型。
        for (const p of list) {
          if ((p.models?.length ?? 0) > 1) continue
          try {
            const res = await api<{ models?: string[] }>('/api/providers/' + encodeURIComponent(p.id) + '/discover-models', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ persist: true }),
            })
            if (res.models?.length) setDiscovered((prev) => ({ ...prev, [p.id]: res.models as string[] }))
          } catch { /* 上游不可达时保持原样 */ }
        }
      })
      .catch(() => {})
    void loadCatalog()
    void loadAgent()
    // providerRevision：设置页加/删/激活厂商后自增 → 这里重新拉一次，
    // 否则刚加完厂商回到对话页仍是旧列表，会被判成「还没有配置模型」（2026-09-29）。
  }, [ready, api, loadCatalog, loadAgent, providerRevision])

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 168) + 'px'
  }, [draft])

  /// 别处请求聚焦（划选的「提问」）：信号是自增序号，变一次聚焦一次。
  useEffect(() => {
    if (!focusComposerAt) return
    area.current?.focus()
  }, [focusComposerAt])

  const active = useMemo(() => providers.find((p) => p.active) ?? providers[0], [providers])
  // 显示用厂商：优先当前会话真正在用的那家。
  const shownProvider = useMemo(
    () => providers.find((p) => p.id === sessionProviderId) ?? active,
    [providers, sessionProviderId, active],
  )

  /// 记住最近用过的模型（最多 3 个），切换器顶部单独一组。
  const rememberModel = (providerId: string, model: string): void => {
    const key = providerId + '::' + model
    const next = [key, ...recentModels.filter((x) => x !== key)].slice(0, 3)
    setRecentModels(next)
    try { localStorage.setItem('coomi.recentModels.v1', JSON.stringify(next)) } catch { /* 忽略 */ }
  }

  /// 按厂商分组 + 搜索过滤，切换厂商/模型一步到位。
  const modelGroups = useMemo(() => {
    const q = modelQuery.trim().toLowerCase()
    const groups = providers.map((p) => {
      const source = discovered[p.id]?.length ? discovered[p.id] : p.models?.length ? p.models : p.model ? [p.model] : []
      const list = source.filter(
        (m) => !q || m.toLowerCase().includes(q) || (p.name ?? p.id).toLowerCase().includes(q),
      )
      return {
        label: (p.active ? '● ' : '') + (p.name || p.id),
        items: list.map((m) => ({
          // 勾选标记跟着当前会话的模型走，而不是厂商配置里的旧值。
          label: ((p.id === sessionProviderId ? sessionModel : p.model) === m ? '✓ ' : '') + m,
          onSelect: () => { selectModel(p.id, m); rememberModel(p.id, m) },
        })),
      }
    }).filter((g) => g.items.length)
    const recentItems = recentModels.map((key) => {
      const [pid, model] = key.split('::')
      const p = providers.find((x) => x.id === pid)
      if (!p) return null
      return { label: (p.name || p.id) + ' / ' + model, onSelect: () => { selectModel(pid, model); rememberModel(pid, model) } }
    }).filter(Boolean) as Array<{ label: string; onSelect: () => void }>
    return { groups, recentItems }
  }, [providers, modelQuery, recentModels, discovered, sessionProviderId, sessionModel])

  const hasProvider = providers.length > 0

  const submit = (): void => {
    if (!draft.trim()) return
    // 没连上时不再静默丢弃：明确告诉用户并自动重连。
    if (!connected) { toast.error('连接已断开，正在重连…'); reconnect(); return }
    // 没配模型时不要发出去（引擎会立刻失败），直接引导去设置。
    // 生成中插话不重复拦这一道：这一轮已经在跑，说明模型早配好了。
    if (!hasProvider && !streaming) { toast.error('还没有配置模型，先去设置里添加 Provider'); setView('settings'); return }
    // 技能仍然是「提示优先使用」，照旧拼在正文最前面；
    // 附件与引用改走结构化字段（见 stores/session.ts 的 send），正文保持用户原样。
    const prefix = skill ? '[使用技能 ' + skill + '] ' : ''
    // 清空交给 store：它只清**当前会话**的那三个桶（别的会话的待发送内容一个字不动）。
    send(prefix + draft, { attachments, quotes })
    setQuotesOpen(false)
    // 附件与引用是被整条清掉的（不是逐个退场）：把它们的退场标记与队列一起收回，
    // 否则标记会留在 leaving / 队列里，下次退场时把不相干的键算进来。
    exitQueue.current = []
    setLeaving((l) => l.filter((k) => !k.startsWith('file:') && !k.startsWith('quote:')))
  }

  /** 收下一批附件路径：store 立刻上屏并按当前会话落盘，大小由引擎的 stat 端点补。 */
  const addPaths = (paths: string[]): void => {
    const incoming = paths.map((p) => String(p ?? '')).filter(Boolean)
    if (!incoming.length) return
    addAttachments(incoming)
    // 拿不到大小（引擎未就绪 / 文件不可读）就只显示图标、名称与扩展名，不阻塞发送。
    for (const path of incoming) {
      void statPath(path)
        .then((info) => { if (info?.exists && info.size) setAttachmentSize(path, info.size) })
        .catch(() => { /* 忽略：大小只是附注 */ })
    }
  }

  const attach = async (): Promise<void> => {
    const picked = await ipc<string[] | null>('pick_files').catch(() => null)
    if (picked?.length) addPaths(picked)
  }

  /// 拖拽文件到输入区＝附件；粘贴图片/文件同样收下。
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => (f as File & { path?: string }).path ?? f.name)
    if (paths.length) addPaths(paths)
    const text = e.dataTransfer.getData('text/plain')
    if (text) setDraft(draft + text)
  }

  /// 斜杠菜单：选中一条命令，把 template 填入输入框（替换正在敲的 /查询 段）。
  /// {{cursor}} 是光标占位：等一帧让 React 提交新值，再把光标落到位。
  const runSlash = (item: SlashItem): void => {
    const el = area.current
    if (!el) return
    const pos = el.selectionStart ?? draft.length
    const before = draft.slice(0, pos)
    const idx = before.lastIndexOf('/')
    const tokenStart = idx >= 0 ? idx : pos
    // 先把「/查询」整段摘掉，再让纯逻辑负责插入模板与 {{cursor}} 落点。
    const cleaned = draft.slice(0, tokenStart) + draft.slice(pos)
    const applied = applySlashTemplate(cleaned, tokenStart, item.template)
    setDraft(applied.text)
    setSlashOpen(false)
    setSlashQuery('')
    setSlashIndex(0)
    window.requestAnimationFrame(() => {
      const next = area.current
      if (next) {
        next.focus()
        next.setSelectionRange(applied.cursor, applied.cursor)
      }
    })
  }

  /// 输入框内容变化：顺带检测斜杠命令（光标前最近的 / 后面是否只有命令名字符）。
  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const text = e.target.value
    setDraft(text)
    const pos = e.target.selectionStart ?? text.length
    const query = detectSlashQuery(text, pos)
    if (query !== null && allSlash.length) {
      setSlashQuery(query)
      setSlashOpen(true)
      setSlashIndex(0)
    } else {
      setSlashOpen(false)
      setSlashQuery('')
      setSlashIndex(0)
    }
  }

  /// 一键关闭人设：走 plugin_set_enabled 停用该插件（壳命令缺失时由 store 给可读错误）。
  const disablePersona = async (p: PluginEntry): Promise<void> => {
    try {
      await pluginSetEnabled(p.id, false)
      toast.message('已关闭「' + pluginName(p) + '」的人设')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  /// 键盘几件事：斜杠菜单上下选择/回车填入，Esc 清空引用、空输入 Backspace 删最后一条引用、Enter 发送。
  /// 引用是「输入框之外的上下文」，键盘能收走它，才不用每次都去够那个 ×。
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (slashOpen && slashItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashItems.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length); return }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const current = slashItems[Math.min(slashIndex, slashItems.length - 1)]
        if (current) runSlash(current)
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); setSlashOpen(false); setSlashIndex(0); return }
    }
    if (e.key === 'Escape' && quotes.length) {
      e.preventDefault()
      clearQuotes()
      setQuotesOpen(false)
      return
    }
    if (e.key === 'Backspace' && !draft && quotes.length) {
      e.preventDefault()
      removeQuote(quotes[quotes.length - 1].id)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const installedSkills = skills.filter((s) => s.installed)
  // 引用芯片的折叠：默认只平铺前两条，其余折成「+N」；删到两条以内时自动回到折叠态。
  const shownQuotes = quotesOpen ? quotes : quotes.slice(0, QUOTE_COLLAPSE_AT)
  const hiddenQuotes = quotes.length - shownQuotes.length

  useEffect(() => {
    if (connected || connecting || !ready) { setShowLinkBanner(false); return }
    const timer = window.setTimeout(() => setShowLinkBanner(true), 800)
    return () => window.clearTimeout(timer)
  }, [connected, connecting, ready])

  /// v1.7：发送键节点 —— 生成中固定是「停止」（Square）；否则按 parts.composer.sendButton 定制
  /// （label 文案 / icon 图片替换默认 ↑ / accent 常驻主色 / position 由调用处决定放哪一侧）；
  /// 没有 parts 时与内置的发送 ↔ 停止形变按钮完全一致。
  const sendIconSrc = sendBtn?.icon ? resolveImagePath(sendBtn.icon.trim()) : null
  const sendBtnNode = (
    <button
      type='button'
      title={streaming ? '停止生成' : '发送（Enter）'}
      aria-label={streaming ? '停止生成' : '发送'}
      onClick={() => { if (streaming) cancel(); else submit() }}
      disabled={!streaming && !draft.trim()}
      className={cn(
        'relative shrink-0 overflow-hidden rounded-full border',
        'transition-[background-color,border-color,color,box-shadow,scale] duration-[var(--motion-base)] ease-[var(--ease-spring)]',
        sendBtn?.label ? 'flex h-9 min-w-9 items-center justify-center gap-1.5 px-3' : 'grid h-9 w-9 place-items-center',
        streaming
          ? 'border-danger/40 bg-surface text-danger'
          : sendBtn?.accent
            ? 'border-transparent bg-primary text-white shadow-[0_4px_14px_rgba(47,111,237,0.35)] hover:bg-primary-hover active:scale-95' + (draft.trim() ? '' : ' opacity-70')
            : draft.trim()
              ? 'border-transparent bg-primary text-white shadow-[0_4px_14px_rgba(47,111,237,0.35)] hover:bg-primary-hover active:scale-95'
              : 'border-line-strong bg-control-2 text-ink-4',
      )}
    >
      {streaming ? (
        <Square size={13} className='shrink-0' />
      ) : sendIconSrc || sendBtn?.label ? (
        <>
          {sendIconSrc ? (
            <img
              src={sendIconSrc}
              alt=''
              draggable={false}
              decoding='async'
              className={sendBtn?.label ? 'h-4 w-4 shrink-0 object-contain' : 'h-[17px] w-[17px] shrink-0 object-contain'}
            />
          ) : null}
          {sendBtn?.label ? (
            <span className='whitespace-nowrap text-12 font-medium'>{sendBtn.label}</span>
          ) : null}
        </>
      ) : (
        <>
          <ArrowUp
            size={17}
            className={cn(
              'absolute transition-[opacity,scale] duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
              streaming ? 'scale-90 opacity-0' : 'scale-100 opacity-100',
            )}
          />
          <Square
            size={13}
            className={cn(
              'absolute transition-[opacity,scale] duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
              streaming ? 'scale-100 opacity-100' : 'scale-90 opacity-0',
            )}
          />
        </>
      )}
    </button>
  )

  return (

    <div data-composer data-hero={!!hero} className={cn('flex w-full flex-col gap-2', hero && 'gap-2.5')}>
      {hero ? <WorkdirBar prominent /> : null}
      {showLinkBanner ? (
        <div
          className={cn(
            'animate-bar flex items-center gap-2 rounded-lg border px-3 py-1.5 text-12',
            noSession ? 'border-line bg-muted text-ink-3' : 'border-warn/40 bg-warn-soft text-warn',
          )}
        >
          <AlertTriangle size={13} />
          <span className='flex-1'>
            {noSession
              ? '正在准备一个新会话…'
              : linkError || '与引擎的连接已断开（可点右侧重连）'}
          </span>
          {noSession ? null : (
            <Button variant='ghost' size='sm' onClick={reconnect}>重连</Button>
          )}
        </div>
      ) : null}
      {ready && !hasProvider ? (
        <div className='animate-bar flex items-center gap-2 rounded-lg border border-primary/30 bg-primary-soft px-3 py-1.5 text-12 text-primary'>
          <KeyRound size={13} />
          <span className='flex-1'>还没有配置模型：添加一个 Provider 并选择模型后就能会话。</span>
          <Button variant='ghost' size='sm' onClick={() => setView('settings')}>去配置</Button>
        </div>
      ) : null}
      {/* 插件人设：启用了带 persona 的插件时提示生效，可一键关闭（停用该插件）。 */}
      {personaPlugin ? (
        <div className='animate-bar flex items-center gap-2 rounded-lg border border-primary/30 bg-primary-soft px-3 py-1.5 text-12 text-primary'>
          <Sparkles size={13} className='shrink-0' />
          <span
            className='min-w-0 flex-1 truncate'
            title={personaPlugin.persona?.description ?? undefined}
          >
            插件人设已生效：{personaPlugin.persona?.name}
          </span>
          {personaPlugin.persona?.description ? (
            <span className='hidden min-w-0 max-w-[38%] truncate text-primary/70 md:inline'>{personaPlugin.persona.description}</span>
          ) : null}
          <Button
            variant='ghost'
            size='sm'
            className='shrink-0 text-primary'
            title={'关闭人设（停用插件「' + pluginName(personaPlugin) + '」）'}
            onClick={() => void disablePersona(personaPlugin)}
          >
            关闭
          </Button>
        </div>
      ) : null}
      <div
        data-composer-box
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          // relative：斜杠命令弹层以输入框为定位基准（absolute bottom-full 浮在上方）。
          'relative rounded-xl border bg-surface p-2 elev-2 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
          dragging ? 'border-primary bg-primary-soft' : 'border-line',
        )}
        style={{
          borderRadius: inputParts?.radius != null ? inputParts.radius + 'px' : undefined,
          minHeight: inputParts?.minHeight != null ? inputParts.minHeight + 'px' : undefined,
        }}
      >
        {/* 斜杠命令弹层：输入 / 弹出，↑↓ 选择、回车填入、Esc 关闭；点击项也直接填入。
            onMouseDown preventDefault：点菜单不抢走输入框焦点。 */}
        {slashOpen && slashItems.length ? (
          <div
            onMouseDown={(e) => e.preventDefault()}
            role='listbox'
            aria-label='插件斜杠命令'
            className='absolute inset-x-2 bottom-full z-40 mb-2 max-h-56 overflow-y-auto overscroll-contain rounded-lg border border-line bg-overlay p-1 shadow-elev-3'
          >
            {slashItems.map((it, i) => (
              <button
                key={it.key}
                type='button'
                role='option'
                aria-selected={i === slashIndex}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => runSlash(it)}
                className={cn(
                  'flex w-full min-w-0 items-center gap-2 rounded-xs px-2 py-1.5 text-left',
                  i === slashIndex ? 'bg-hover text-ink' : 'text-ink-2',
                )}
              >
                <Slash size={13} className='shrink-0 text-primary' />
                <span className='min-w-0 flex-1'>
                  <span className='font-mono text-12 font-medium'>{it.command}</span>
                  {it.description ? <span className='ml-1.5 truncate text-11 text-ink-4'>— {it.description}</span> : null}
                </span>
                <span className='shrink-0 text-11 text-ink-4'>{it.plugin}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className='flex flex-wrap items-center gap-1.5 px-1 pt-0.5'>
          {/* 芯片（引用 / 技能 / 附件）：入场 8px 上浮 + 淡入，退场缩到 0.88 再淡出，
              两段都只动 transform / opacity，所以这段延迟里输入区不会被顶得上下跳一下。
              入场是 motion 的**真弹性**（SPRING_SNAP），退场 140ms + in-quad（SEC_FAST / EASE_IN_QUAD）；
              退场由 AnimatePresence 播完再摘元素（onExitComplete），不再手写定时器。 */}
          <AnimatePresence initial={false} onExitComplete={settle}>
            {/* 引用芯片：每条两行摘要 + ×。超过 QUOTE_COLLAPSE_AT 条只平铺前两条，
                其余折成「+N」（引用都是长文本，全铺开会把输入框顶出视野）。 */}
            {shownQuotes.map((q) => (
              <m.span
                key={'quote:' + q.id}
                className='flex max-w-full'
                initial={chipEnter}
                animate={chipShown}
                // 退场写在 exit 里（不依赖 leaving 标记）：点 ×、Backspace、Esc 三条删除路径的
                // 手感必须一致，其中键盘那两条不走 dismiss，标记是来不及打的。
                exit={chipExit}
                transition={chipMotion}
              >
                <QuoteChip text={q.text} onRemove={() => dismiss('quote:' + q.id)} />
              </m.span>
            ))}
            {hiddenQuotes > 0 ? (
              <button
                type='button'
                onClick={() => setQuotesOpen(true)}
                title={'展开其余 ' + hiddenQuotes + ' 条引用'}
                className='rounded-full bg-primary-soft px-2 py-0.5 text-11 text-primary transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:bg-primary/15'
              >
                +{hiddenQuotes}
              </button>
            ) : null}
            {skill ? (
              <m.span
                key='skill'
                className='flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-11 text-primary'
                initial={chipEnter}
                animate={chipShown}
                exit={chipExit}
                transition={chipMotion}
              >
                {skill}
                <button type='button' onClick={() => dismiss('skill')} className='opacity-70 transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:opacity-100'>×</button>
              </m.span>
            ) : null}
            {/* 附件芯片：徽标（图标 + 扩展名）+ 文件名 + 大小 + ×，
                与已发送消息里的附件卡片是同一套视觉语言（见 AttachmentCard）。 */}
            {attachments.map((a) => (
              <m.span
                key={'file:' + a.path}
                title={a.path}
                className='flex max-w-[260px] items-center gap-1.5 rounded-full bg-sunken px-2 py-0.5 text-11 text-ink-2'
                initial={chipEnter}
                animate={chipShown}
                exit={chipExit}
                transition={chipMotion}
              >
                <FileBadge path={a.path} size='sm' />
                <span className='min-w-0 truncate'>{attachmentName(a)}</span>
                {a.size ? <span className='shrink-0 tabular-nums text-ink-4'>{fmtBytes(a.size)}</span> : null}
                <button type='button' aria-label={'移除附件 ' + attachmentName(a)} onClick={() => dismiss('file:' + a.path)} className='shrink-0 opacity-70 transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:opacity-100'>×</button>
              </m.span>
            ))}
          </AnimatePresence>
        </div>
        {/* 输入行：mascot 挂点是 textarea 右侧的 flex 空隙 —— 空挂点零尺寸不占位，
            引擎注入 <img> 后才出现（样式见 base.css 的 [data-theme-composer-mascot]）。
            v1.7：parts.composer.sendButton.position='left' 时发送键挪到这一行最左。 */}
        <div className={cn('flex w-full min-w-0 items-start gap-1.5', sendLeft && 'items-end')}>
          {sendLeft ? sendBtnNode : null}
          <textarea
            aria-label='消息输入框'
            ref={area}
            value={draft}
            onChange={onChange}
            onKeyDown={onKey}
            rows={hero ? 2 : 1}
            placeholder={inputParts?.placeholder ?? (!ready ? '引擎启动中…'
              : streaming
                ? (insertMode === 'interrupt' ? '正在生成：Enter 打断本轮并发送新消息' : '正在生成：Enter 插话（排队，本轮结束后立刻执行）')
                : '告诉 Coomi，你想做些什么…')}
            disabled={!ready}
            className='max-h-[168px] min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-13 leading-[1.65] text-ink placeholder:text-ink-4'
            style={{
              borderRadius: inputParts?.radius != null ? inputParts.radius + 'px' : undefined,
              minHeight: inputParts?.minHeight != null ? inputParts.minHeight + 'px' : undefined,
            }}
          />
          <div data-theme-composer-mascot className='shrink-0' />
        </div>
        <div data-composer-tools className='mt-1 flex items-center gap-0.5'>
          {toolbarParts?.showAttach === false ? null : (
          <Tip label='上传文件'>
            <Button
              variant='ghost' size='icon-sm'
              aria-label='上传文件'
              onClick={() => void attach()}
            >
              <Paperclip size={15} />
            </Button>
          </Tip>
          )}
          {toolbarParts?.showSearch === false ? null : (
          <Menu
            align='start'
            side='top'
            items={installedSkills.length
              ? installedSkills.map((s) => ({ label: s.name || s.id, icon: <Wand2 size={14} />, onSelect: () => setSkill(s.name || s.id) }))
              : [{ label: '还没有安装技能', disabled: true }]}
            trigger={<Button variant='ghost' size='icon-sm' title='添加技能'><Sparkles size={15} /></Button>}
          />
          )}
          {toolbarParts?.showModel === false ? null : (
          <Menu
            align='start'
            side='top'
            header={
              <input
                autoFocus
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder='搜索厂商或模型…'
                className='mb-1 h-7 w-full rounded-md border border-line-strong bg-control px-2 text-12 text-ink placeholder:text-ink-4'
              />
            }
            groups={
              providers.length
                ? [
                    ...(modelGroups.recentItems.length
                      ? [{ label: '最近使用', items: modelGroups.recentItems }]
                      : []),
                    ...modelGroups.groups,
                  ]
                : undefined
            }
            items={providers.length ? undefined : [{ label: '未配置厂商，先去设置里添加', onSelect: () => setView('settings') }]}
            trigger={
              <Button variant='ghost' size='sm' className='gap-1 text-ink-3' title='选择模型'>
                <span className='flex min-w-0 max-w-[220px] items-center gap-1 truncate'>
                  {shownProvider || sessionModel ? (
                    <>
                      <span className='text-ink-4'>{shownProvider?.name || shownProvider?.id || sessionProviderId || '当前模型'}</span>
                      <span className='text-ink-4'> / </span>
                      <span className='truncate text-ink-2'>{sessionModel || shownProvider?.model || '未选模型'}</span>
                    </>
                  ) : '选择模型'}
                </span>
                <ChevronRight size={12} className='rotate-90' />
              </Button>
            }
          />
          )}
          <Menu
            align='start'
            side='top'
            items={EFFORT_LABELS.map((e) => ({ label: (e.value === effort ? '● ' : '') + e.label + ' — ' + e.hint, onSelect: () => void setEffort(e.value as ReasoningEffort) }))}
            trigger={
              <Button variant='ghost' size='sm' className='gap-1 text-ink-3' title='思考强度'>
                <Brain size={14} />
                <span>{EFFORT_LABELS.find((e) => e.value === effort)?.label ?? '自动'}</span>
              </Button>
            }
          />
          <Menu
            align='start'
            side='top'
            items={PERMISSION_LABELS.map((p) => ({
              label: (p.value === permission ? '● ' : '') + p.label + ' — ' + p.hint,
              danger: p.value === 'full',
              onSelect: () => void setPermission(p.value as PermissionMode),
            }))}
            trigger={
              <Button
                variant='ghost'
                size='sm'
                title='任务放行程度'
                className={permission === 'full' ? 'gap-1 text-warn' : 'gap-1 text-ink-3'}
              >
                {permission === 'full' ? <ShieldAlert size={14} /> : <Shield size={14} />}
                <span>{PERMISSION_LABELS.find((p) => p.value === permission)?.label ?? '每次询问'}</span>
              </Button>
            }
          />
          <div className='flex-1' />
          {!hero ? <ContextRing /> : null}
          {/* 插话方式（排队 / 打断）：默认排队——不打断当前轮、不丢已生成内容。
              生成中才会有存在感，静止时也在，方便提前选好。 */}
          <Menu
            align='end'
            side='top'
            items={[
              { label: (insertMode === 'queue' ? '● ' : '') + '排队 — 本轮结束后立刻执行（不打断、不丢内容）', icon: <ListOrdered size={14} />, onSelect: () => setPrefs({ insertMode: 'queue' }) },
              { label: (insertMode === 'interrupt' ? '● ' : '') + '打断 — 取消当前轮后立刻重发（已生成内容保留）', icon: <Zap size={14} />, onSelect: () => setPrefs({ insertMode: 'interrupt' }) },
            ]}
            trigger={
              <Button
                variant='ghost'
                size='sm'
                title='生成中发送消息的方式'
                className={streaming ? 'gap-1 text-primary' : 'gap-1 text-ink-3'}
              >
                {insertMode === 'interrupt' ? <Zap size={14} /> : <ListOrdered size={14} />}
                <span>{insertMode === 'interrupt' ? '打断' : '排队'}</span>
              </Button>
            }
          />
          {/* 生成中：停止按钮照旧在；只要输入框里有字，旁边再多一个「插话」发送按钮
              （Enter 也行）。这样「生成中还能不能发」这件事一眼就能看明白。 */}
          {streaming && draft.trim() ? (
            <button
              type='button'
              title={insertMode === 'interrupt' ? '打断并发送（Enter）' : '插话发送（Enter，排队中）'}
              aria-label={insertMode === 'interrupt' ? '打断并发送' : '插话发送'}
              onClick={submit}
              className={cn(
                'flex h-9 shrink-0 items-center justify-center gap-1 rounded-full border border-transparent px-3 text-12',
                'bg-primary text-white shadow-[0_4px_14px_rgba(47,111,237,0.35)] transition-[background-color,scale] duration-[var(--motion-base)] ease-[var(--ease-spring)] hover:bg-primary-hover active:scale-95',
              )}
            >
              {insertMode === 'interrupt' ? <Zap size={15} /> : <ArrowUp size={15} />}
              <span>{insertMode === 'interrupt' ? '打断发送' : '插话'}</span>
            </button>
          ) : null}
          {/* 发送 ↔ 停止是同一个按钮的形变：底色/描边走 --motion-base，图标 0.9→1 交叉缩放，
               不再整体替换控件（替换会「啪」一下，长度也不一样）。
               生成中有正文时它固定是「停止」，发送交给上面的插话按钮。
               v1.7：parts.composer.sendButton.position='left' 时发送键挪到输入行左侧，这里不再渲染。 */}
          {!sendLeft ? sendBtnNode : null}
        </div>
      </div>
      {!hero || hasMessages || streaming ? <StatsBar /> : null}
      {hero ? (
        <div className='composer-hint text-11 text-ink-3'>
          <span><kbd>Enter</kbd> 发送 <span aria-hidden>·</span> <kbd>Shift + Enter</kbd> 换行</span>
          <span>也可以拖入文件，与 Coomi 一起阅读</span>
        </div>
      ) : null}
    </div>
  )
}
