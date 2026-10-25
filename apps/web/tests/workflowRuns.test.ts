import assert from 'node:assert/strict'
import test from 'node:test'
import { activeWorkflowStatus, createWorkflowRunPoller, type WorkflowRun } from '../src/utils/workflowRuns.ts'

function run(status: string): WorkflowRun { return { id: 'r', started_at: 1, trigger: 'manual', status, steps: [] } }
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('workflow polling continues beyond sixty seconds and stops on completion', async () => {
  const callbacks: Array<() => void> = [], received: WorkflowRun[][] = []
  let calls = 0
  const poller = createWorkflowRunPoller({
    load: async () => [run(++calls <= 40 ? 'running' : 'completed')],
    receive: runs => received.push(runs), error: assert.fail,
    schedule: callback => { callbacks.push(callback); return callbacks.length }, clear: () => {},
  })
  poller.start('one'); await flush()
  for (let i = 0; i < 40; i++) { assert.ok(callbacks.length); callbacks.shift()!(); await flush() }
  assert.equal(calls, 41)
  assert.equal(received.at(-1)![0].status, 'completed')
  assert.equal(callbacks.length, 0)
  poller.stop()
})

test('workflow polling discards late responses after navigation and unmount', async () => {
  let oldResolve!: (runs: WorkflowRun[]) => void
  const received: WorkflowRun[][] = []
  const poller = createWorkflowRunPoller({
    load: id => id === 'old' ? new Promise(resolve => { oldResolve = resolve }) : Promise.resolve([run('completed')]),
    receive: runs => received.push(runs), error: assert.fail,
  })
  poller.start('old'); poller.start('new'); await flush()
  oldResolve([run('running')]); await flush()
  assert.equal(received.length, 1)
  poller.start('old'); poller.stop(); oldResolve([run('running')]); await flush()
  assert.equal(received.length, 1)
})

test('approval and paused states stay active; failed and interrupted runs stop polling', () => {
  for (const status of ['queued', 'running', 'pause_pending', 'paused', 'awaiting_input', 'awaiting_approval']) assert.equal(activeWorkflowStatus(status), true)
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) assert.equal(activeWorkflowStatus(status), false)
})
