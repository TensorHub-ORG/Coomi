import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileArchive, FolderOpen, Palette, Puzzle, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { Empty } from '../ui/Card'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Input'
import { SkeletonRows, Switch } from '../ui/Controls'
import { withDisplayName } from '../../lib/stormProbe'
import {
  activeThemePluginId,
  effectiveEnabled,
  getThemeData,
  hasTheme,
  pluginName,
  usePluginStore,
  type PluginEntry,
  type PluginPrefs,
} from './pluginStore'

/* 插件列表与管理动作：安装 / 启停 / 卸载 / 设为当前主题 全在这一块。
   壳命令（plugin_list / plugin_set_enabled / plugin_install_dir / plugin_uninstall）可能还没实现，
   所有失败都走 store 的可读降级：回滚乐观值 + 提示，不崩。 */

/** 权限骨架展示：已知权限给可读名，未知的显示原始键。 */
const PERMISSION_LABELS: Record<string, string> = {
  'theme.apply': '主题',
  'theme.read': '主题读取',
  'ui.theme': '主题',
}

function PluginRow({ p, prefs, active, busy, onToggle, onTheme, onUninstall }: {
  p: PluginEntry
  prefs: PluginPrefs
  active: boolean
  busy: boolean
  onToggle: (p: PluginEntry, enabled: boolean) => void
  onTheme: (p: PluginEntry) => void
  onUninstall: (p: PluginEntry) => void
}) {
  const name = pluginName(p)
  const enabled = effectiveEnabled(p, prefs)
  const themeData = getThemeData(p)
  const themeLabel = themeData?.name || name
  const isThemePlugin = hasTheme(p)
  /** v1.5：主题带背景层（background）或自定义样式（css）时，给一枚标识徽章。 */
  const themeHasExtras = isThemePlugin && Boolean(
    themeData && (themeData.background || (themeData.css && themeData.css.length > 0)),
  )
  return (
    <div data-testid='plugin-card' className='card-lift min-w-0 rounded-xl border border-line bg-surface elev-1 p-4'>
      <div className='flex min-w-0 items-start gap-3'>
        <span className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-ink-3'>
          {isThemePlugin ? <Palette size={16} /> : <Puzzle size={16} />}
        </span>
        <div className='min-w-0 flex-1'>
          <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
            <span className='min-w-0 truncate text-14 font-medium text-ink' title={name}>{name}</span>
            {p.version ? <Badge tone='neutral'>{p.version}</Badge> : null}
            {active ? <Badge tone='primary'>当前主题</Badge> : null}
            {!enabled ? <Badge tone='warn'>已停用</Badge> : null}
            {themeHasExtras ? <Badge tone='neutral' title='该主题带背景层或自定义样式注入'>含背景层/自定义样式</Badge> : null}
          </div>
          {p.description ? <p className='mt-0.5 break-words text-12 leading-[1.55] text-ink-3'>{p.description}</p> : null}
          {p.permissions?.length ? (
            <div className='mt-1.5 flex min-w-0 flex-wrap items-center gap-1'>
              <span className='shrink-0 text-11 text-ink-4'>权限</span>
              {p.permissions.map((permission) => (
                <span
                  key={permission}
                  title={permission}
                  className='shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-11 text-ink-4'
                >
                  {PERMISSION_LABELS[permission] ?? permission}
                </span>
              ))}
            </div>
          ) : null}
          {/* v2 能力概览：技能 / MCP / 子智能体 / 斜杠命令 的数量（壳侧 plugin_list 下发） */}
          {(p.skills?.length || p.mcpCount || p.subagents?.length || p.slash?.length) ? (
            <div className='mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5'>
              {p.skills?.length ? <Badge tone='neutral'>{p.skills.length} 技能</Badge> : null}
              {p.mcpCount ? <Badge tone='neutral'>{p.mcpCount} MCP</Badge> : null}
              {p.subagents?.length ? <Badge tone='neutral'>{p.subagents.length} 子智能体</Badge> : null}
              {p.slash?.length ? <Badge tone='neutral'>{p.slash.length} 斜杠命令</Badge> : null}
            </div>
          ) : null}
          {/* 斜杠命令预览：输入 / 时出现在 Composer 的斜杠菜单里 */}
          {p.slash?.length ? (
            <div className='mt-1.5 flex min-w-0 flex-wrap items-center gap-1'>
              {p.slash.slice(0, 5).map((sc) => (
                <span
                  key={sc.name}
                  title={sc.description ?? undefined}
                  className='shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-11 text-ink-4'
                >
                  /{sc.name}
                </span>
              ))}
              {p.slash.length > 5 ? <span className='shrink-0 text-11 text-ink-4'>+{p.slash.length - 5}</span> : null}
            </div>
          ) : null}
          {/* 子智能体模板预览：出现在对话页子智能体面板的新建区 */}
          {p.subagents?.length ? (
            <div className='mt-1.5 flex min-w-0 flex-wrap items-center gap-1'>
              {p.subagents.slice(0, 3).map((s) => (
                <span key={s.name} title={s.description ?? undefined} className='shrink-0 rounded bg-sunken px-1.5 py-0.5 text-11 text-ink-4'>
                  {s.name}
                </span>
              ))}
              {p.subagents.length > 3 ? <span className='shrink-0 text-11 text-ink-4'>+{p.subagents.length - 3}</span> : null}
            </div>
          ) : null}
          {/* 人设预览：启用后 Composer 上方显示「插件人设已生效」 */}
          {p.persona ? (
            <div className='mt-1.5 rounded-md border border-primary/20 bg-primary-soft px-2 py-1.5'>
              <p className='flex items-center gap-1.5 text-11 text-primary'>
                <Sparkles size={12} className='shrink-0' /> 人设：{p.persona.name}
                <span className='ml-auto text-ink-4'>启用后对话输入区上方生效</span>
              </p>
              {p.persona.description ? (
                <p className='mt-0.5 break-words text-11 leading-[1.5] text-ink-3'>{p.persona.description}</p>
              ) : null}
            </div>
          ) : null}
          {isThemePlugin && !themeData ? (
            <p className='mt-1 text-11 text-warn'>
              声明了主题（{typeof p.theme === 'string' ? p.theme : 'theme.json'}），但壳还没下发主题内容，暂不能渲染。
            </p>
          ) : null}
        </div>
      </div>
      <div className='mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-soft pt-2.5'>
        <div className='flex shrink-0 items-center gap-2'>
          <Switch
            checked={enabled}
            disabled={busy}
            aria-label={'启用 ' + name}
            onCheckedChange={(v) => onToggle(p, v)}
          />
          <span className='text-11 text-ink-4'>{enabled ? '已启用' : '已停用'}</span>
        </div>
        <div className='ml-auto flex min-w-0 flex-wrap items-center gap-1.5'>
          {isThemePlugin ? (
            <Button
              variant={active ? 'primary' : 'secondary'}
              size='sm'
              disabled={busy || !enabled}
              title={!enabled ? '启用后可设为当前主题' : active ? '点击恢复内置主题' : '应用主题「' + themeLabel + '」'}
              onClick={() => onTheme(p)}
            >
              {active ? <CheckCircle2 size={13} /> : <Palette size={13} />}
              {active ? '当前主题' : '设为当前主题'}
            </Button>
          ) : null}
          <Button
            variant='ghost'
            size='sm'
            className='text-ink-3 hover:text-danger'
            disabled={busy}
            title='卸载插件'
            onClick={() => onUninstall(p)}
          >
            <Trash2 size={13} /> 卸载
          </Button>
        </div>
      </div>
    </div>
  )
}

export function PluginManager() {
  const plugins = usePluginStore((s) => s.plugins)
  const status = usePluginStore((s) => s.status)
  const error = usePluginStore((s) => s.error)
  const prefs = usePluginStore((s) => s.prefs)
  const activeId = usePluginStore((s) => activeThemePluginId(s.plugins, s.prefs))
  const refresh = usePluginStore((s) => s.refresh)
  const setEnabled = usePluginStore((s) => s.setEnabled)
  const setThemeSelected = usePluginStore((s) => s.setThemeSelected)
  const installFromDir = usePluginStore((s) => s.installFromDir)
  const installFromZip = usePluginStore((s) => s.installFromZip)
  const uninstall = usePluginStore((s) => s.uninstall)

  const [notice, setNotice] = useState('')
  /** 正在操作中的插件 id（或 '__install__'）：操作期间锁住整组控件，别让人连点。 */
  const [busyId, setBusyId] = useState<string | null>(null)
  const flashTimer = useRef(0)
  const flash = useCallback((text: string): void => {
    setNotice((prev) => (prev === text ? prev : text))
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setNotice(''), 2600)
  }, [])
  useEffect(() => () => window.clearTimeout(flashTimer.current), [])

  const activeEntry = plugins.find((p) => p.id === activeId) ?? null
  const activeMissingData = activeEntry ? getThemeData(activeEntry) === null : false

  const handleToggle = async (p: PluginEntry, enabled: boolean): Promise<void> => {
    if (busyId) return
    setBusyId(p.id)
    try {
      await setEnabled(p.id, enabled)
      flash(enabled ? '已启用「' + pluginName(p) + '」' : '已停用「' + pluginName(p) + '」')
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const handleTheme = (p: PluginEntry): void => {
    if (activeId === p.id) {
      setThemeSelected(null)
      flash('已恢复内置主题')
      return
    }
    setThemeSelected(p.id)
    const data = getThemeData(p)
    flash(data ? '已应用主题「' + (data.name || pluginName(p)) + '」' : '已选为当前主题；壳下发 theme.json 内容后即生效')
  }

  const handleUninstall = async (p: PluginEntry): Promise<void> => {
    if (busyId) return
    if (!window.confirm('卸载插件「' + pluginName(p) + '」？\n若它正被用作当前主题，主题会一起恢复为内置。')) return
    setBusyId(p.id)
    try {
      await uninstall(p.id)
      flash('已卸载「' + pluginName(p) + '」')
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const handleInstall = async (): Promise<void> => {
    if (busyId) return
    setBusyId('__install__')
    try {
      const r = await installFromDir()
      if (r.message) flash(r.message)
    } finally {
      setBusyId(null)
    }
  }

  const handleInstallZip = async (): Promise<void> => {
    if (busyId) return
    setBusyId('__install__')
    try {
      const r = await installFromZip()
      if (r.message) flash(r.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className='flex min-w-0 flex-col gap-2.5 px-5 py-4' data-testid='plugins-panel'>
      {notice ? <p className='px-0.5 text-12 text-ok'>{notice}</p> : null}

      {error ? (
        <p className='flex min-w-0 items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-12 leading-[1.65] text-warn'>
          <AlertTriangle size={13} className='mt-0.5 shrink-0' />
          <span className='min-w-0 flex-1 break-words'>{error}</span>
          <Button variant='ghost' size='sm' disabled={busyId !== null} onClick={() => void refresh()}>重试</Button>
        </p>
      ) : null}

      <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5'>
        <p className='min-w-0 flex-1 text-11 leading-[1.6] text-ink-4'>
          插件从文件夹安装（需要 plugin.json）；主题插件装好后可在「外观」分组的插件主题里切换。
        </p>
        <Button variant='ghost' size='sm' disabled={busyId !== null || status === 'loading'} onClick={() => void refresh()}>
          <RefreshCw size={13} /> 刷新
        </Button>
        <Button variant='primary' size='sm' disabled={busyId !== null} onClick={() => void handleInstall()}>
          <FolderOpen size={13} /> 安装文件夹
        </Button>
        <Button variant='ghost' size='sm' disabled={busyId !== null} onClick={() => void handleInstallZip()}>
          <FileArchive size={13} /> 本地 zip
        </Button>
      </div>

      {status === 'loading' && !plugins.length ? <SkeletonRows rows={3} className='px-1' /> : null}

      {status === 'ready' && !plugins.length ? (
        <Empty
          compact
          icon={<Puzzle size={18} />}
          title='还没有安装插件'
          description={error || '点「安装插件」选择一个包含 plugin.json 的文件夹；主题插件安装后即可在设置里切换。'}
          action={<Button variant='primary' size='sm' onClick={() => void handleInstall()}><FolderOpen size={13} /> 安装插件</Button>}
        />
      ) : null}

      {activeMissingData ? (
        <p className='rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-12 leading-[1.65] text-warn'>
          当前主题「{activeEntry ? pluginName(activeEntry) : ''}」还拿不到主题数据（壳侧未在 plugin_list 里下发
          theme.json 内容），暂沿用内置主题。
        </p>
      ) : null}

      {plugins.map((p) => (
        <PluginRow
          key={p.id}
          p={p}
          prefs={prefs}
          active={p.id === activeId}
          busy={busyId !== null}
          onToggle={handleToggle}
          onTheme={handleTheme}
          onUninstall={handleUninstall}
        />
      ))}
    </div>
  )
}

withDisplayName(PluginManager, 'PluginManager')
