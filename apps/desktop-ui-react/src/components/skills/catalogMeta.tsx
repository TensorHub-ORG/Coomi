import { useState } from 'react'
import {
  AppWindow, Boxes, Brain, Bug, Chrome, Cloud, Code, Database, FileText, Files, GitBranch,
  Globe, HardDrive, LineChart, MessageSquare, Package, Search, Shield, ShieldAlert, ShieldCheck,
  Sparkles, Table, Terminal, Video,
} from 'lucide-react'
import { Badge } from '../ui/Input'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Overlay'
import { cn } from '../../lib/cn'
import {
  verifyRemoteMcp, verifyInputForEntry,
  type HiddenRemoteEntry, type McpVerifyResult, type RemoteEntry, type RemoteTrustInfo,
} from './remoteSources'

/// 目录 id → 图标：让每张卡都有可辨认的视觉标识（没有映射就退回“首字母色块”）。
const ICONS: Record<string, React.ReactNode> = {
  filesystem: <Files size={20} />,
  memory: <Brain size={20} />,
  'sequential-thinking': <Brain size={20} />,
  everything: <Sparkles size={20} />,
  time: <Globe size={20} />,
  fetch: <Globe size={20} />,
  shell: <Terminal size={20} />,
  'desktop-commander': <HardDrive size={20} />,
  git: <GitBranch size={20} />,
  github: <GitBranch size={20} />,
  gitlab: <GitBranch size={20} />,
  gitee: <GitBranch size={20} />,
  serena: <Code size={20} />,
  context7: <FileText size={20} />,
  deepwiki: <FileText size={20} />,
  playwright: <Chrome size={20} />,
  puppeteer: <Chrome size={20} />,
  browsermcp: <AppWindow size={20} />,
  figma: <AppWindow size={20} />,
  sentry: <Bug size={20} />,
  postgres: <Database size={20} />,
  sqlite: <Database size={20} />,
  mysql: <Database size={20} />,
  mongodb: <Database size={20} />,
  redis: <Database size={20} />,
  clickhouse: <Database size={20} />,
  elasticsearch: <Search size={20} />,
  'brave-search': <Search size={20} />,
  tavily: <Search size={20} />,
  exa: <Search size={20} />,
  firecrawl: <Search size={20} />,
  duckduckgo: <Search size={20} />,
  markitdown: <FileText size={20} />,
  notion: <FileText size={20} />,
  slack: <MessageSquare size={20} />,
  linear: <MessageSquare size={20} />,
  atlassian: <MessageSquare size={20} />,
  excel: <Table size={20} />,
  'office-word': <FileText size={20} />,
  feishu: <MessageSquare size={20} />,
  aws: <Cloud size={20} />,
  cloudflare: <Cloud size={20} />,
  docker: <Boxes size={20} />,
  kubernetes: <Boxes size={20} />,
  grafana: <LineChart size={20} />,
  chroma: <Brain size={20} />,
  qdrant: <Brain size={20} />,
  openmemory: <Brain size={20} />,
  duckdb: <Table size={20} />,
  'pandas-mcp': <Table size={20} />,
  amap: <Globe size={20} />,
  youtube: <Video size={20} />,
  ffmpeg: <Video size={20} />,
}

const CATEGORIES: Record<string, string> = {
  filesystem: '文件与系统', memory: 'AI 与向量', 'sequential-thinking': 'AI 与向量', everything: '开发工具',
  time: '文件与系统', fetch: '搜索与抓取', shell: '文件与系统', 'desktop-commander': '文件与系统',
  git: 'Git 与代码托管', github: 'Git 与代码托管', gitlab: 'Git 与代码托管', gitee: 'Git 与代码托管',
  serena: '开发工具', context7: '开发工具', deepwiki: '开发工具', figma: '开发工具',
  playwright: '浏览器自动化', puppeteer: '浏览器自动化', browsermcp: '浏览器自动化',
  sentry: '运维监控', grafana: '运维监控',
  postgres: '数据库', sqlite: '数据库', mysql: '数据库', mongodb: '数据库', redis: '数据库', clickhouse: '数据库',
  elasticsearch: '数据与分析', 'brave-search': '搜索与抓取', tavily: '搜索与抓取', exa: '搜索与抓取',
  firecrawl: '搜索与抓取', duckduckgo: '搜索与抓取', markitdown: '办公文档',
  notion: '办公文档', excel: '办公文档', 'office-word': '办公文档',
  slack: '通讯协作', linear: '通讯协作', atlassian: '通讯协作', feishu: '通讯协作',
  aws: '云服务', cloudflare: '云服务', docker: '云服务', kubernetes: '云服务',
  chroma: 'AI 与向量', qdrant: 'AI 与向量', openmemory: 'AI 与向量',
  duckdb: '数据与分析', 'pandas-mcp': '数据与分析', amap: '数据与分析', youtube: '数据与分析', ffmpeg: '数据与分析',
}

export function catalogIcon(id: string): React.ReactNode {
  return ICONS[id] ?? <Package size={20} />
}

export function catalogCategory(id: string): string {
  return CATEGORIES[id] ?? '其它'
}

export const CATALOG_CATEGORIES = [
  '全部', '文件与系统', '开发工具', 'Git 与代码托管', '数据库', '搜索与抓取',
  '浏览器自动化', '办公文档', '通讯协作', '云服务', '运维监控', 'AI 与向量', '数据与分析', '其它',
]
/* ── 来源可信度 / 验证状态：远程 MCP 条目卡片用的可复用件 ──
   放在 catalogMeta 是因为市场浏览器本来就 import 它，接入方只需多 import 一个名字：
   不新增文件、不引入新的视觉语言（徽章一律走 ui/Input 的 Badge）。 */

/** 来源可信度徽章：官方目录（高）/ npm 搜索、GitHub（中）/ 自定义（低）。 */
export function SourceTrustBadge({ trust, className }: { trust: RemoteTrustInfo; className?: string }) {
  // 高可信用 primary（与「目录内」同档），中等用中性，低可信用 warn 提醒——都是现成语义色。
  const tone = trust.level === 'high' ? 'primary' : trust.level === 'medium' ? 'neutral' : 'warn'
  return <Badge tone={tone} className={className} title={trust.detail}>{trust.label}</Badge>
}

/** 验证状态徽章：未验证 / 已验证（带工具数）/ 验证失败（原因放 title）。 */
export function VerifyStatusBadge({ result }: { result?: McpVerifyResult | null }) {
  if (result?.status === 'verified') {
    return (
      <Badge tone='ok' title={result.reason || '已通过 MCP 握手'}>
        <ShieldCheck size={11} /> 已验证{result.tools !== null ? ' · ' + result.tools + ' 个工具' : ''}
      </Badge>
    )
  }
  if (result?.status === 'failed') {
    return (
      <Badge tone='warn' title={result.reason || '验证没有通过'}>
        <ShieldAlert size={11} /> 验证失败
      </Badge>
    )
  }
  // 未验证：可能还没点，也可能是引擎没有接口（404 降级）——原因放 title，不占版面。
  return (
    <Badge tone='neutral' title={result?.reason || '还没有验证过：点「一键验证」让引擎实际拉起它做一次握手'}>
      <Shield size={11} /> 未验证
    </Badge>
  )
}

/**
 * 「一键验证」控件：徽章 + 按钮，自带状态。
 * 不传 result / onResult 时就地持有结果（卡片一次性用法最省事）；传了就是受控，
 * 把结果写回调用方状态（也就是任务里说的「结果写回该条目」）。
 */
export function McpVerifyControl({ entry, result, onResult, className }: {
  entry: RemoteEntry
  result?: McpVerifyResult | null
  onResult?: (result: McpVerifyResult) => void
  className?: string
}) {
  const [local, setLocal] = useState<McpVerifyResult | null>(null)
  const [busy, setBusy] = useState(false)
  const current = result !== undefined ? result : local
  const input = verifyInputForEntry(entry)
  const run = async (): Promise<void> => {
    if (!input) return
    setBusy(true)
    try {
      // verifyRemoteMcp 内部已把 404 / 网络失败折算成结果对象，这里不会抛。
      const next = await verifyRemoteMcp(input)
      setLocal(next)
      onResult?.(next)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <VerifyStatusBadge result={current} />
      <Button
        variant='ghost'
        size='sm'
        loading={busy}
        disabled={!input}
        title={input
          ? '让引擎按这条命令实际拉起它并做一次 MCP 握手（只验证，不写入配置）'
          : '这条没有本地启动命令（http / sse 地址无法冒烟验证），只能按「未验证」处理'}
        onClick={() => void run()}
      >
        <ShieldCheck size={13} /> 一键验证
      </Button>
    </span>
  )
}

/**
 * 「已隐藏的条目」入口：一行低调的文字按钮 + 详情弹窗。
 * 弹窗里能看到每条被隐藏的原因，并可以逐条「仍然显示」（用户自担风险）——
 * 不做一刀切、无法挽回的隐藏。
 */
export function HiddenEntriesDisclosure({ hidden, revealedIds, onReveal, className }: {
  hidden: HiddenRemoteEntry[]
  /** 已经被「仍然显示」的条目 key：受控传入时用于把按钮变成「已显示」。 */
  revealedIds?: ReadonlySet<string>
  /** 用户要求仍然显示某条：由列表页把它插回可见列表。 */
  onReveal?: (entry: RemoteEntry) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  // 不传受控 revealedIds 时自己记一份，保证点完「仍然显示」按钮立刻变化。
  const [localRevealed, setLocalRevealed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const revealed = revealedIds ?? localRevealed
  if (!hidden.length) return null
  const reveal = (entry: RemoteEntry): void => {
    if (revealedIds === undefined) setLocalRevealed((prev) => (prev.has(entry.key) ? prev : new Set(prev).add(entry.key)))
    onReveal?.(entry)
  }
  return (
    <>
      <button
        type='button'
        onClick={() => setOpen(true)}
        className={cn('text-11 text-ink-4 underline decoration-dotted underline-offset-2 transition-colors hover:text-ink-2', className)}
      >
        已隐藏 {hidden.length} 个疑似非 MCP 条目（点击查看）
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={'已隐藏 ' + hidden.length + ' 个疑似非 MCP 条目'}
        width={560}
        footer={<Button variant='ghost' onClick={() => setOpen(false)}>关闭</Button>}
      >
        <div className='flex flex-col gap-3'>
          <p className='text-11 leading-[1.7] text-ink-4'>
            这些条目命中了来源过滤规则，默认不显示，但并没有被丢弃。你可以逐条「仍然显示」——
            它们大多来自 npm 全品类搜索，请自行确认确实是 MCP 服务器，风险由你承担。
          </p>
          <div className='flex flex-col gap-2'>
            {hidden.map((item) => {
              const shown = revealed.has(item.entry.key)
              return (
                <div key={item.entry.key} className='rounded-lg border border-line bg-muted p-3'>
                  <div className='flex min-w-0 items-center gap-1.5'>
                    <span className='min-w-0 truncate text-12 font-medium text-ink' title={item.entry.id}>{item.entry.name || item.entry.id}</span>
                    <SourceTrustBadge trust={item.entry.trust} />
                    <span className='flex-1' />
                    <Button variant='ghost' size='sm' disabled={shown} onClick={() => reveal(item.entry)}>
                      {shown ? '已显示' : '仍然显示'}
                    </Button>
                  </div>
                  <div className='mt-0.5 truncate font-mono text-11 text-ink-4' title={item.entry.id}>{item.entry.id}</div>
                  <p className='mt-1 text-11 leading-[1.6] text-warn'>{item.reason}</p>
                </div>
              )
            })}
          </div>
        </div>
      </Dialog>
    </>
  )
}
