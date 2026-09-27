import type { AgentEvent } from '@/protocol/events'
import { PROTOCOL_VERSION, type AgentCommand, type InboundEnvelope } from '@/protocol/commands'
import type { ConnectionState, ConnectionStatus, Transport } from './transport'
import { emitCancelled, playDemoRun, type DemoCtx } from './demoScript'
import { nextId } from './envelope'

/** 中断脚本用的哨兵：sleep 里抛出来，一路把 async 脚本解开。 */
class DemoAbort extends Error {}

/**
 * 演示传输：把脚本事件按真实节奏喂给 store。
 *
 * 和 WsTransport 实现同一个接口，所以 store / 组件完全不知道自己在演示模式 ——
 * 这正是要点：看到的界面就是真跑起来时的界面。
 */
export class DemoTransport implements Transport {
  private msgHandlers: ((env: InboundEnvelope) => void)[] = []
  private stateHandlers: ((status: ConnectionStatus) => void)[] = []
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private running = false
  private closed = false
  private aborting = false
  private resolveApproval: ((d: 'allow' | 'deny' | 'always') => void) | null = null
  private resolveAnswer: ((text: string) => void) | null = null

  connect(): void {
    this.emitState('connecting')
    this.after(240, () => this.emitState('open'))
  }

  close(): void {
    this.closed = true
    this.aborting = true
    this.timers.forEach(t => clearTimeout(t))
    this.timers.clear()
    this.emitState('closed')
  }

  send(command: AgentCommand): void {
    switch (command.command) {
      case 'send_message':
        if (!this.running) void this.run()
        break
      case 'cancel':
        if (this.running) {
          this.aborting = true
          this.resolveApproval = null
          this.resolveAnswer = null
          emitCancelled({ emit: ev => this.emitEvent(ev) })
        }
        break
      case 'approve_tool':
        this.resolveApproval?.(command.decision)
        this.resolveApproval = null
        break
      case 'answer_question':
        this.resolveAnswer?.(Object.values(command.answers).join('；'))
        this.resolveAnswer = null
        break
      default:
        // set_permission_mode / plan mode / select_model：演示模式下无副作用
        break
    }
  }

  onMessage(handler: (env: InboundEnvelope) => void): void { this.msgHandlers.push(handler) }
  onStateChange(handler: (status: ConnectionStatus) => void): void { this.stateHandlers.push(handler) }

  private async run(): Promise<void> {
    this.running = true
    this.aborting = false
    try {
      await playDemoRun(this.ctx())
    } catch (e) {
      if (!(e instanceof DemoAbort)) throw e
    } finally {
      this.running = false
    }
  }

  private ctx(): DemoCtx {
    return {
      emit: ev => this.emitEvent(ev),
      sleep: ms => this.sleep(ms),
      type: (content, kind) => this.typeOut(content, kind ?? 'text'),
      // 授权 / 提问就一直等着 —— 该谁点谁点。无人值守（?auto=1）由界面侧的
      // 自动驾驶去点按钮，走的是和真手指一样的那条路，卡片状态才对得上。
      waitApproval: () => new Promise(resolve => { this.resolveApproval = resolve }),
      waitAnswer: () => new Promise(resolve => { this.resolveAnswer = resolve }),
    }
  }

  /** 逐字吐字。ASCII 一次多吐几个，中文一个一个来，看起来才像模型在写。 */
  private async typeOut(content: string, kind: 'text' | 'reasoning'): Promise<void> {
    const eventType = kind === 'reasoning' ? 'reasoning_chunk' : 'text_chunk'
    let i = 0
    while (i < content.length) {
      const ascii = content.charCodeAt(i) < 128
      const n = ascii ? 3 + Math.floor(Math.random() * 3) : 1 + Math.floor(Math.random() * 2)
      const piece = content.slice(i, i + n)
      i += n
      this.emitEvent({ event_type: eventType, content: piece } as AgentEvent)
      let delay = 22 + Math.random() * 18
      if (/[。！？\n]/.test(piece)) delay += 120
      else if (/[，、：；]/.test(piece)) delay += 55
      await this.sleep(delay)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.aborting || this.closed) { reject(new DemoAbort()); return }
      this.after(ms, () => {
        if (this.aborting || this.closed) reject(new DemoAbort())
        else resolve()
      })
    })
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); fn() }, ms)
    this.timers.add(t)
  }

  private emitEvent(payload: AgentEvent): void {
    if (this.closed) return
    const env: InboundEnvelope = { v: PROTOCOL_VERSION, type: 'event', id: nextId(), ts: Date.now() / 1000, payload }
    this.msgHandlers.forEach(h => h(env))
  }

  private emitState(state: ConnectionState): void { this.stateHandlers.forEach(h => h({ state })) }
}
