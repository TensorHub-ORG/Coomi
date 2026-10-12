import { useEffect, useId, useMemo, useState } from 'react'
import { ChevronRight, FileText, Pencil, Save, Search, Terminal, GitBranch, Globe, Wrench, AlertTriangle, LoaderCircle } from 'lucide-react'
import { m, type MotionProps } from 'motion/react'
import type { ToolCall } from '../../lib/chat'
import { markCollapseMotion } from './collapseMotion'
import { useEngine } from '../../stores/engine'
import { useSession } from '../../stores/session'

type Args = Record<string, unknown>
function argsOf(raw: string): Args {
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
}
function pick(args: Args, keys: string[]): string {
  for (const key of keys) if (typeof args[key] === 'string' && args[key]) return args[key] as string
  return ''
}

/** Only actual unified patches get line numbers and counts. Requested replacements
 * remain explicitly labelled as input, never as confirmed file changes. */
function patchLines(source: string) {
  let old = 0, next = 0, inHunk = false, numbered = false
  return source.replace(/\r\n?/g, '\n').split('\n').map(text => {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (/^(diff --git |--- |\+\+\+ )/.test(text)) inHunk = false
    if (head) { old = +head[1]; next = +head[2]; inHunk = true; numbered = true }
    else if (/^@@/.test(text)) { inHunk = true; numbered = false }
    if (/^\*\*\* /.test(text)) inHunk = false
    const type = inHunk && !head ? text[0] : ''
    const oldNo = numbered && ['-', ' '].includes(type) ? old++ : null
    const newNo = numbered && ['+', ' '].includes(type) ? next++ : null
    return { text, type, oldNo, newNo }
  })
}

function Patch({ source }: { source: string }) {
  const lines = useMemo(() => patchLines(source), [source])
  const [visible, setVisible] = useState(300)
  useEffect(() => setVisible(300), [source])
  return <div data-tool-diff className='my-2 max-h-96 overflow-auto font-mono text-11 leading-6 sel-text'>
    {lines.slice(0, visible).map((line, i) => <div key={i} className={'flex min-w-max ' + (line.type === '+' ? 'bg-[color-mix(in_srgb,var(--ok)_12%,transparent)]' : line.type === '-' ? 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]' : '')}>
      <span className='w-10 shrink-0 select-none pr-2 text-right text-ink-4'>{line.oldNo}</span>
      <span className='w-10 shrink-0 select-none pr-2 text-right text-ink-4'>{line.newNo}</span>
      <span className='whitespace-pre pr-3 text-ink-2'>{line.text || ' '}</span>
    </div>)}
    {visible < lines.length ? <button type='button' className='px-2 py-1 font-sans text-primary' onClick={() => setVisible(v => v + 300)}>继续显示 · 剩余 {lines.length - visible} 行</button> : null}
  </div>
}

function Replacement({ args }: { args: Args }) {
  const edits = Array.isArray(args.edits) ? args.edits : [args]
  return <div data-tool-replacements className='my-2 max-h-96 overflow-auto font-mono text-11 leading-6 sel-text'>
    <p className='font-sans text-ink-4'>替换片段（请求参数，非完整文件差异）</p>
    {edits.map((edit, i) => {
      if (!edit || typeof edit !== 'object') return null
      const value = edit as Args
      if (typeof value.old_string !== 'string' || typeof value.new_string !== 'string') return null
      return <div key={i} className='my-1'>
        {(['old_string', 'new_string'] as const).map(key => (value[key] as string).split('\n').map((line, j) => <div key={key + j} className={'whitespace-pre px-2 ' + (key === 'new_string' ? 'bg-[color-mix(in_srgb,var(--ok)_12%,transparent)]' : 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]')}>
          <span className={'mr-3 select-none ' + (key === 'new_string' ? 'text-ok' : 'text-danger')}>{key === 'new_string' ? '+' : '−'}</span>{line || ' '}
        </div>))}
      </div>
    })}
  </div>
}

export function ToolWaterfallRow({ tool, enter, defaultOpen }: { tool: ToolCall; enter: MotionProps; defaultOpen?: boolean }) {
  const bad = tool.status === 'error' || tool.status === 'denied'
  const [open, setOpen] = useState(!!defaultOpen || bad)
  const id = useId()
  const [loaded, setLoaded] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  useEffect(() => { setLoaded(null); setLoadError('') }, [tool.preview])
  useEffect(() => { if (bad) setOpen(true) }, [bad])
  const output = loaded ?? tool.output ?? tool.preview
  const abbreviated = loaded === null && tool.output === undefined && !!tool.preview && (tool.preview.length >= 8000 || (tool.preview.length >= 1000 && tool.preview.endsWith('...')))
  const loadFull = async () => {
    const engine = useEngine.getState()
    const sessionId = useSession.getState().sessionId
    setLoading(true); setLoadError('')
    try {
      const data = await engine.api<{ messages?: Array<{ role?: string; tool_call_id?: string; content?: string }> }>('/api/sessions/' + encodeURIComponent(sessionId))
      if (useSession.getState().sessionId !== sessionId || useEngine.getState().port !== engine.port || useEngine.getState().token !== engine.token) return
      const result = data.messages?.find(m => m.role === 'tool' && m.tool_call_id === tool.callId)
      if (typeof result?.content !== 'string') throw new Error('完整结果尚未写入会话，请在本轮结束后重试')
      setLoaded(result.content)
    } catch (error) { setLoadError(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }
  const args = useMemo(() => argsOf(tool.args), [tool.args])
  const name = tool.name.toLowerCase().split(/[.:/]/).pop() || tool.name
  const command = pick(args, ['command', 'cmd', 'script'])
  const path = pick(args, ['path', 'file_path', 'filePath', 'filename', 'file', 'target_file', 'notebook_path'])
  const git = /^(git[_-])/.test(name) || /(^|[\s;&|])git\s/.test(command)
  const edit = /edit|replace|patch/.test(name)
  const write = /write|create_file|append|save_file/.test(name)
  const shell = !!command || /exec|shell|terminal|run_command/.test(name)
  const search = /search|grep|glob|find/.test(name)
  const read = /read|view|open_file|list_directory/.test(name)
  const fetch = /fetch|browse|web/.test(name)
  const Icon = git ? GitBranch : edit ? Pencil : write ? Save : shell ? Terminal : search ? Search : read ? FileText : fetch ? Globe : Wrench
  const verb = git ? 'Git' : edit ? '编辑' : write ? '写入' : shell ? '终端' : search ? '搜索' : read ? '读取' : fetch ? '浏览' : tool.name
  const patchPath = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(pick(args, ['patch', 'diff']))?.[1] || ''
  const target = path || command || patchPath || pick(args, ['pattern', 'query', 'url', 'glob', 'description', 'task'])
  const normalized = target.replace(/\\/g, '/')
  const filename = path || patchPath ? normalized.split('/').pop() : target
  const parent = (path || patchPath) && normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : ''
  const patch = useMemo(() => {
    if (output && /^@@ -\d+(?:,\d+)? \+\d+/m.test(output)) return { source: output, actual: true }
    const requested = pick(args, ['patch', 'diff'])
    return requested ? { source: requested, actual: false } : null
  }, [output, args])
  const counts = useMemo(() => patch?.actual && !abbreviated ? patchLines(patch.source).reduce((sum, line) => ({ add: sum.add + +(line.type === '+'), del: sum.del + +(line.type === '-') }), { add: 0, del: 0 }) : null, [patch, abbreviated])
  const active = tool.status === 'running' || tool.status === 'queued'
  return <m.div {...enter} data-tool-row={tool.callId} className='min-w-0 py-0.5'>
    <button type='button' aria-expanded={open} aria-controls={id} title={target || tool.name}
      onClick={() => { markCollapseMotion(); setOpen(v => !v) }}
      className='group flex min-h-7 w-full min-w-0 items-center gap-2 py-1 text-left text-12 text-ink-3 hover:text-ink'>
      <Icon size={14} className='shrink-0 text-ink-4' />
      <span className='shrink-0'>{verb}</span>
      <span className='min-w-0 truncate font-mono text-ink-2'>{filename}</span>
      {parent ? <span className='min-w-0 truncate text-11 text-ink-4'>{parent}</span> : null}
      {counts ? <span className='flex shrink-0 gap-1.5 text-11'><span className='text-ok'>+{counts.add}</span><span className='text-danger'>−{counts.del}</span></span> : null}
      {bad ? <span className='flex shrink-0 items-center gap-1 text-danger'><AlertTriangle size={12} />{tool.status === 'denied' ? '已拒绝' : '失败 / 未确认'}</span> : active ? <span className='flex shrink-0 items-center gap-1 text-11 text-ink-4'>{tool.status === 'running' ? <LoaderCircle size={12} className='animate-spin' /> : null}{tool.status === 'running' ? '执行中' : '等待'}</span> : null}
      {tool.cacheHit ? <span className='shrink-0 text-11 text-ink-4'>缓存</span> : null}
      <ChevronRight size={12} className={'shrink-0 text-ink-4 ' + (open ? 'rotate-90' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')} />
    </button>
    {open ? <div id={id} className='min-w-0 pb-3 pl-[22px]' data-tool-detail>
      <div className='mb-1 flex flex-wrap gap-2 text-11 text-ink-4'><span>{tool.name}</span>{tool.elapsedMs != null ? <span>{tool.elapsedMs}ms</span> : null}</div>
      {patch ? <><p className='text-11 text-ink-4'>{patch.actual ? '执行结果差异' : '请求变更（以执行结果为准）'}</p><Patch source={patch.source} /></> : null}
      {!patch && edit && (typeof args.old_string === 'string' || Array.isArray(args.edits)) ? <Replacement args={args} /> : null}
      {tool.args && tool.args !== '{}' ? <details className='my-1' open={!patch}>
        <summary className='cursor-pointer text-11 text-ink-4'>完整参数</summary>
        <pre className='sel-text max-h-80 overflow-auto whitespace-pre-wrap break-words py-2 font-mono text-11 leading-[1.7] text-ink-3'>{tool.args}</pre>
      </details> : null}
      {patch?.actual ? <details className='mt-2'>
        <summary className='cursor-pointer text-11 text-ink-4'>完整原始结果</summary>
        <pre className='sel-text max-h-96 overflow-auto whitespace-pre-wrap break-words py-1 font-mono text-11 leading-[1.7] text-ink-2'>{output}</pre>
      </details> : <>
        <p className='mt-2 text-11 text-ink-4'>执行结果</p>
        <pre className='sel-text max-h-96 overflow-auto whitespace-pre-wrap break-words py-1 font-mono text-11 leading-[1.7] text-ink-2'>{output || (active ? '等待执行结果…' : '没有输出')}</pre>
      </>}
      {abbreviated ? <button type='button' data-tool-load-full disabled={loading} onClick={() => void loadFull()} className='py-1 text-11 text-primary disabled:opacity-50'>{loading ? '正在加载…' : '当前为摘要 · 加载完整结果'}</button> : null}
      {loadError ? <p role='alert' className='text-11 text-danger'>{loadError}</p> : null}
      {tool.images?.map((src, i) => <img key={i} src={src} loading='lazy' alt={'工具输出 ' + (i + 1)} className='my-2 max-h-96 max-w-full object-contain' />)}
    </div> : null}
  </m.div>
}
