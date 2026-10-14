import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Maximize2, Minimize2, X, Hand, Send, Square, RefreshCw, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useDeck, type DeckTerminal } from '../../stores/deck'
import { confirmAction } from '../../stores/dialogs'
import { Button } from '../ui/Button'
import { useUi } from '../../stores/ui'
import { terminalThemes } from './terminalTheme'

// xterm emits terminal-generated protocol replies through onData as well as
// real keystrokes. Treat the replies as transport traffic so they never take
// back a freshly granted coordinator slot. The `u` form is used by modern
// Codex/ZCode keyboard protocol negotiation; OSC replies are used for theme
// queries by some terminal clients.
function isTerminalReply(text: string): boolean {
  return /^\x1b\[[?>]?[\d;]*[Rcn]$/.test(text)
    || /^\x1b\[[?>][\d;]*u$/.test(text)
    || /^\x1b\[[?>]?[\d;]*\$y$/.test(text)
    || /^\x1b\[[?>]?[\d;]*t$/.test(text)
    || /^\x1b\][^\x07]*(?:\x07|\x1b\\)$/.test(text)
    || /^\x1bP[^\x1b]*(?:\x1b\\)$/.test(text)
    || /^\x1b\[[IO]$/.test(text)
}

export function TerminalPanel({ taskId, terminal, maximized, onMaximize }: { taskId: string; terminal: DeckTerminal; maximized: boolean; onMaximize: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerminal | null>(null)
  const repaint = useRef<() => void>(() => {})
  const themePref = useUi((state) => state.prefs.terminalTheme)
  const [interfaceTheme, setInterfaceTheme] = useState<'light' | 'dark'>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const theme = themePref === 'interface' ? interfaceTheme : themePref
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState('')
  const [inputError, setInputError] = useState('')
  const [exited, setExited] = useState(terminal.status !== 'running')
  const [ready, setReady] = useState(terminal.coomi_ready)
  const [controlling, setControlling] = useState(false)
  const owned = useRef(terminal.coomi_ready)
  const ownershipChanging = useRef(false)
  const inputChain = useRef<Promise<unknown>>(Promise.resolve())
  const pending = useRef(0)
  const inputRevision = useRef(0)
  const running = useRef(terminal.status === 'running')
  running.current = terminal.status === 'running'
  const run = async <T = unknown>(action: Record<string, unknown>) => useDeck.getState().action<T>(taskId, { ...action, terminal_id: terminal.id })
  useEffect(() => { owned.current = terminal.coomi_ready; setReady(terminal.coomi_ready) }, [terminal.coomi_ready])
  useEffect(() => {
    const observer = new MutationObserver(() => setInterfaceTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (term.current) { term.current.options.theme = terminalThemes[theme]; term.current.refresh(0, term.current.rows - 1) }
  }, [theme])
  useEffect(() => {
    if (!host.current) return
    let active = true
    let timer: number | undefined
    let frame = 0
    let settleTimer = 0
    let after = 0
    let replaying = false
    let replySource = 0
    const xterm = new XTerminal({ cursorBlink: false, fontSize: 13, fontFamily: 'Cascadia Code, Consolas, monospace', scrollback: 8000, theme: terminalThemes[theme], allowProposedApi: false })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(host.current)
    term.current = xterm
    const action = <T,>(body: Record<string, unknown>) => useDeck.getState().action<T>(taskId, { ...body, terminal_id: terminal.id })
    let wantedSize: { rows: number; cols: number; repaint: boolean } | null = null
    let syncing = false
    let sentSize = ''
    const syncSize = async () => {
      if (syncing) return
      syncing = true
      try {
        while (active && wantedSize && running.current) {
          const size = wantedSize
          wantedSize = null
          const key = size.rows + ':' + size.cols
          if (key !== sentSize || size.repaint) {
            try { await action({ action: 'resize', ...size }); sentSize = key } catch { sentSize = '' }
          }
        }
      } finally { syncing = false }
    }
    const resize = (force = false) => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        if (!active || !host.current?.getClientRects().length || !host.current.clientWidth || !host.current.clientHeight) return
        const size = fit.proposeDimensions()
        if (!size || size.cols < 2 || size.rows < 2) return
        xterm.resize(Math.min(500, size.cols), Math.min(500, size.rows))
        xterm.refresh(0, xterm.rows - 1)
        wantedSize = { rows: xterm.rows, cols: xterm.cols, repaint: force || !!wantedSize?.repaint }
        void syncSize()
      })
    }
    const scheduleResize = () => {
      resize()
      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => resize(), 180)
    }
    repaint.current = () => resize(true)
    const observer = new ResizeObserver(scheduleResize)
    observer.observe(host.current)
    const visibleObserver = new IntersectionObserver((entries) => { if (entries.some(entry => entry.isIntersecting)) scheduleResize() })
    visibleObserver.observe(host.current)
    window.addEventListener('resize', scheduleResize)
    document.addEventListener('visibilitychange', scheduleResize)
    document.fonts.addEventListener('loadingdone', scheduleResize)
    void document.fonts.ready.then(() => { if (active) scheduleResize() })
    const input = xterm.onData((text) => {
      if (!running.current) return
      if (isTerminalReply(text)) {
        if (replaying) return
        const source_after = replySource
        inputChain.current = inputChain.current.then(() => action({ action: 'reply', text, source_after })).catch((error) => { if (active) setInputError(String(error)) })
        return
      }
      // Keep xterm stdin enabled: disableStdin also suppresses automatic device
      // responses. Gate human input here and in the backend owner lock instead.
      if (owned.current || ownershipChanging.current) return
      inputRevision.current += 1
      pending.current += 1
      inputChain.current = inputChain.current.then(async () => { await action({ action: 'input', text }); if (active) setInputError('') }).catch((error) => { if (active) setInputError(String(error)) }).finally(() => { pending.current -= 1 })
    })
    // Local clipboard only; never forward browser shortcuts as shell commands.
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      event.stopPropagation()
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') { event.preventDefault(); void navigator.clipboard.writeText(xterm.getSelection()).catch((error) => toast.error(String(error))); return false }
      if (event.ctrlKey && event.code === 'KeyC' && xterm.hasSelection()) { event.preventDefault(); void navigator.clipboard.writeText(xterm.getSelection()).catch((error) => toast.error(String(error))); return false }
      if (owned.current || ownershipChanging.current) { event.preventDefault(); return false }
      if ((event.ctrlKey && event.code === 'KeyV') || (event.shiftKey && event.code === 'Insert')) {
        event.preventDefault()
        void navigator.clipboard.readText().then((text) => xterm.paste(text)).catch((error) => toast.error(String(error)))
        return false
      }
      return true
    })
    const poll = async () => {
      if (!active) return
      if (!host.current?.getClientRects().length || document.hidden) { timer = window.setTimeout(() => void poll(), 750); return }
      try {
        const result = await action<{ data: string; next: number; reset: boolean; exited: boolean; reply_after?: number }>({ action: 'read', after })
        if (!active) return
        if (result.reset) xterm.reset()
        if (result.data) {
          const bytes = Uint8Array.from(atob(result.data), (value) => value.charCodeAt(0))
          const history = Math.max(0, Math.min(bytes.length, (result.reply_after || 0) - (result.next - bytes.length)))
          const write = (data: Uint8Array) => new Promise<void>((resolve) => xterm.write(data, resolve))
          // Rebuild the old screen without answering already-consumed queries.
          // New bytes still send automatic protocol replies while input is locked.
          if (history) { replaying = true; await write(bytes.subarray(0, history)); replaying = false }
          if (history < bytes.length) { replySource = result.next; await write(bytes.subarray(history)) }
        }
        if (!active) return
        xterm.refresh(0, xterm.rows - 1)
        after = result.next
        setError('')
        setExited(result.exited)
        if (result.exited) { void useDeck.getState().refresh(); return }
        timer = window.setTimeout(() => void poll(), result.data ? 100 : 350)
      } catch (error) {
        if (active) { setError(String(error)); timer = window.setTimeout(() => void poll(), 2000) }
      }
    }
    if (host.current.clientWidth && host.current.clientHeight) fit.fit()
    scheduleResize()
    void poll()
    return () => {
      active = false; window.clearTimeout(timer); window.clearTimeout(settleTimer); window.cancelAnimationFrame(frame)
      observer.disconnect(); visibleObserver.disconnect()
      window.removeEventListener('resize', scheduleResize); document.removeEventListener('visibilitychange', scheduleResize); document.fonts.removeEventListener('loadingdone', scheduleResize)
      repaint.current = () => {}; input.dispose(); xterm.dispose(); term.current = null
    }
  }, [taskId, terminal.id])
  useEffect(() => {
    const textarea = host.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (textarea) {
      textarea.readOnly = ready || controlling
      textarea.setAttribute('aria-label', ready ? 'Coomi 控制的终端，解除控制后可输入' : '终端输入')
    }
  }, [ready, controlling])
  const control = async () => {
    if (controlling) return
    const revision = inputRevision.current
    if (pending.current > 0) { toast.error('输入正在提交，请稍后再交给 Coomi'); return }
    if (!ready && !await confirmAction({ title: '交给 Coomi', description: 'Coomi 将持续控制此终端，可多次派发指令和回应 CLI。接管期间禁止人工输入，只有点击解除控制后才能自行操作。', confirmLabel: '交给 Coomi' })) return
    if (revision !== inputRevision.current || pending.current > 0) { toast.error('终端输入已改变，请确认 CLI 就绪后重新交给 Coomi'); return }
    setControlling(true)
    ownershipChanging.current = true
    try {
      // Drain earlier manual input before handing over. Block later keystrokes
      // throughout handover/release so they cannot cross the ownership boundary.
      const update = inputChain.current.then(() => run<{ ok: boolean; coomi_ready: boolean }>({ action: 'control', ready: !ready }))
      inputChain.current = update.catch(() => {})
      const result = await update
      owned.current = result.coomi_ready
      setReady(result.coomi_ready)
      await inputChain.current
      await useDeck.getState().refresh()
    } catch (error) { toast.error(String(error)) } finally { ownershipChanging.current = false; setControlling(false) }
  }
  const stopOrClose = async (close: boolean) => {
    if (closing) return
    if (running.current && !await confirmAction({ title: close ? '关闭此终端？' : '停止此终端？', description: close ? '将终止 CLI 进程并移除面板，请确认工作已保存。' : '将终止 CLI 进程，保留面板中的输出记录。', danger: true })) return
    setClosing(true)
    try {
      await inputChain.current
      await run({ action: close ? 'close' : 'stop' })
      setExited(true)
      await useDeck.getState().refresh()
    } catch (error) { toast.error(String(error)) } finally { setClosing(false) }
  }
  const copyTerminalId = async () => {
    try { await navigator.clipboard.writeText(`#${String(terminal.number).padStart(2, '0')} · ${terminal.id}`); toast.success(`已复制终端 #${terminal.number} 编号和 ID`) }
    catch (error) { toast.error(String(error)) }
  }
  return <section className={'deck-terminal ' + (maximized ? 'deck-terminal-maximized' : '')} data-terminal-theme={theme} data-terminal-id={terminal.id} data-coomi-owned={ready}>
    <header><span className={'deck-terminal-dot ' + (exited ? 'is-exited' : '')} /><span className='deck-terminal-number' title={`任务内终端编号 #${terminal.number}`}>#{String(terminal.number).padStart(2, '0')}</span><strong>{terminal.profile === 'powershell' ? 'PowerShell' : terminal.profile.startsWith('install-') ? terminal.profile.slice(8) + ' · 安装' : terminal.profile}</strong><span className='deck-terminal-state' title={ready ? 'Coomi 持续控制，解除后才能人工输入' : undefined}>{exited ? '已停止' : ready ? 'Coomi 控制中' : '人工操作'}</span>
      <Button variant='ghost' size='icon-sm' aria-label={`复制终端 #${terminal.number} 编号和 ID`} title={`复制终端 #${terminal.number} 编号和 ID`} onClick={() => void copyTerminalId()}><Copy size={13} /></Button>
      <Button variant='ghost' size='icon-sm' title={ready ? '解除 Coomi 控制' : '交给 Coomi'} disabled={exited || controlling || terminal.profile.startsWith('install-')} onClick={() => void control()}>{ready ? <Hand size={14} /> : <Send size={14} />}</Button>
      <Button variant='ghost' size='icon-sm' title='刷新终端显示' onClick={() => repaint.current()}><RefreshCw size={14} /></Button>
      <Button variant='ghost' size='icon-sm' title={maximized ? '恢复多列' : '最大化终端'} onClick={onMaximize}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</Button>
      {!exited ? <Button variant='ghost' size='icon-sm' title='停止终端' disabled={closing} onClick={() => void stopOrClose(false)}><Square size={12} /></Button> : null}
      <Button variant='ghost' size='icon-sm' title='关闭终端' disabled={closing} onClick={() => void stopOrClose(true)}><X size={14} /></Button>
    </header>
    <div ref={host} className='deck-terminal-body' />
    {error || inputError ? <p role='alert' className='deck-terminal-error'>{inputError || error}</p> : null}
  </section>
}
