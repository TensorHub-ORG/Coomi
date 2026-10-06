<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import FileInline from '@/components/FileInline.vue'
import { apiGet, apiSend } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'

interface Activity {
  id: string
  kind: string
  content?: string
  toolName?: string
  arguments?: unknown
  toolStatus?: string
  tsMs?: number
}
interface Agent {
  id: string
  name: string
  status: string
  output?: string
  reasoning?: string
  currentMessage?: string
  activities?: Activity[]
}
interface CollabEvent {
  seq: number
  eventType?: string
  event_type?: string
  detail?: Record<string, unknown>
  tsMs?: number
}
interface Artifact { id: string; path: string; name: string; kind?: string; agentId?: string; size?: number }
interface Task {
  id: string
  title: string
  objective: string
  status: string
  mode: string
  agents: Agent[]
  summary?: string
  artifacts?: Artifact[]
}

const route = useRoute()
const router = useRouter()
const id = computed(() => String(route.params.id))
const task = ref<Task | null>(null)
const events = ref<CollabEvent[]>([])
const nextSeq = ref(0)
const error = ref('')
const input = ref('')
const busy = ref(false)
const polling = ref(false)
const activeTab = ref<'deliver' | 'agents' | 'events' | 'artifacts'>('deliver')
const selectedAgentId = ref('')
let timer: number | undefined

const terminal = computed(() => ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(task.value?.status ?? ''))
const selectedAgent = computed(() => task.value?.agents.find(a => a.id === selectedAgentId.value) ?? task.value?.agents[0])
const completedCount = computed(() => task.value?.agents.filter(a => a.status === 'completed').length ?? 0)
const progress = computed(() => task.value?.agents.length ? Math.round(completedCount.value / task.value.agents.length * 100) : 0)
const artifactPaths = computed(() => (task.value?.artifacts ?? []).map(a => a.path))
const statusText = (status: string) => ({
  draft: '草稿', queued: '排队中', waiting: '等待中', starting: '启动中', running: '执行中', partial: '部分完成',
  completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
} as Record<string, string>)[status] || status
const eventText = (event: CollabEvent) => {
  const detail = event.detail ?? {}
  return String(detail.content ?? detail.message ?? detail.status ?? '')
}
const formatArgs = (value: unknown) => {
  if (value == null) return ''
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

async function refreshTask() {
  task.value = await apiGet<Task>(`/api/collab/tasks/${encodeURIComponent(id.value)}`)
}
async function refreshEvents(reset = false) {
  const cursor = reset ? 0 : nextSeq.value
  const payload = await apiGet<{ events: CollabEvent[]; next_seq?: number }>(
    `/api/collab/tasks/${encodeURIComponent(id.value)}/events?since_seq=${cursor}`,
  )
  const incoming = payload.events ?? []
  if (reset) events.value = incoming
  else if (incoming.length) {
    const known = new Set(events.value.map(event => event.seq))
    events.value.push(...incoming.filter(event => !known.has(event.seq)))
  }
  nextSeq.value = Number(payload.next_seq ?? (incoming.length ? incoming[incoming.length - 1].seq : cursor))
}
async function load(reset = false) {
  if (polling.value) return
  polling.value = true
  try {
    await Promise.all([refreshTask(), refreshEvents(reset)])
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    polling.value = false
  }
}
async function act(action: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await apiSend<{ taskId?: string; new_task_id?: string }>(
      `/api/collab/tasks/${encodeURIComponent(id.value)}/${action}`, 'POST',
    )
    const replacement = result?.taskId ?? result?.new_task_id
    if (action === 'retry' && replacement && replacement !== id.value) {
      await router.replace(`/collab/${replacement}`)
      events.value = []
      nextSeq.value = 0
    }
    await load(true)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
async function send() {
  const content = input.value.trim()
  if (!content || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await apiSend(`/api/collab/tasks/${encodeURIComponent(id.value)}/messages`, 'POST', { content, to: 'all' })
    input.value = ''
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await load(true)
  timer = window.setInterval(() => { void load() }, 1500)
})
onBeforeUnmount(() => { if (timer !== undefined) window.clearInterval(timer) })
</script>

<template>
  <div class="page">
    <PageHead :title="task?.title || '协同任务'" @back="goBack(router, '/collab')">
      <template #right>
        <button v-if="task?.status === 'running'" class="icon-btn" aria-label="打断任务" :disabled="busy" @click="act('interrupt')">
          <CoomiIcon name="stop" :size="17" />
        </button>
      </template>
    </PageHead>

    <main class="body">
      <p v-if="error" class="notice"><CoomiIcon name="alert" :size="14" />{{ error }}</p>

      <section v-if="task" class="overview">
        <div class="ov-title">
          <span class="state" :class="task.status">{{ statusText(task.status) }}</span>
          <span class="mode">{{ task.mode === 'parallel' ? '并行执行' : task.mode === 'coordinated' ? '协调执行' : '集中调度' }}</span>
        </div>
        <p>{{ task.objective }}</p><div class="progress"><i :style="{width:progress+'%'}"/></div><div class="stats"><span><b>{{completedCount}}</b>/{{task.agents.length}} 成员完成</span><span><b>{{task.artifacts?.length??0}}</b> 个产物</span><span><b>{{events.length}}</b> 条动态</span></div>
        <div class="actions">
          <button v-if="['draft', 'queued'].includes(task.status)" class="btn primary" :disabled="busy" @click="act('start')">启动</button>
          <button v-if="['starting', 'running'].includes(task.status)" class="btn danger" :disabled="busy" @click="act('cancel')">停止</button>
          <button v-if="terminal && task.status !== 'completed'" class="btn primary" :disabled="busy" @click="act('retry')">重试</button>
        </div>
      </section>

      <section v-if="task" class="team-strip"><button v-for="agent in task.agents" :key="agent.id" :class="['team-chip',agent.status,{selected:selectedAgent?.id===agent.id}]" @click="selectedAgentId=agent.id;activeTab='agents'"><span>{{agent.name.slice(0,1)}}</span><b>{{agent.name}}</b><i/></button></section><nav v-if="task" class="tabs" aria-label="任务详情">
        <button :class="{ on: activeTab === 'deliver' }" @click="activeTab = 'deliver'">交付</button><button :class="{ on: activeTab === 'agents' }" @click="activeTab = 'agents'">成员 <em>{{ task.agents.length }}</em></button>
        <button :class="{ on: activeTab === 'events' }" @click="activeTab = 'events'">执行流 <em>{{ events.length }}</em></button>
        <button :class="{ on: activeTab === 'artifacts' }" @click="activeTab = 'artifacts'">产物 <em>{{ task.artifacts?.length ?? 0 }}</em></button>
      </nav>

      <section v-if="task && activeTab === 'deliver'" class="panel deliver-pane">
        <div class="deliver-head"><b>最终交付</b><span>{{progress}}%</span></div>
        <div v-if="task.summary" class="merge-box">{{task.summary}}</div>
        <p v-else class="orch-hint">{{['starting','running'].includes(task.status)?'团队正在并行执行，完成后会在这里汇总结果。':'任务尚未生成汇总交付。'}}</p>
        <article v-for="agent in task.agents" :key="agent.id" class="delivery">
          <header><span>{{agent.name.slice(0,1)}}</span><b>{{agent.name}}</b><em :class="agent.status">{{statusText(agent.status)}}</em></header>
          <pre v-if="agent.output">{{agent.output}}</pre><p v-else>{{agent.currentMessage||'等待产出'}}</p>
        </article>
      </section><section v-if="task && activeTab === 'agents'" class="phase-track"><div class="phase done"><i/>准备</div><div :class="['phase',{done:task.status!=='draft'}]"><i/>并行执行</div><div :class="['phase',{done:terminal}]"><i/>汇总交付</div></section><section v-if="task && activeTab === 'agents'" class="panel agents">
        <article v-for="agent in task.agents" :key="agent.id" class="agent">
          <div class="agent-head">
            <span class="avatar"><CoomiIcon name="user" :size="15" /></span>
            <b>{{ agent.name }}</b>
            <em :class="agent.status">{{ statusText(agent.status) }}</em>
          </div>
          <p v-if="agent.currentMessage" class="agent-error">{{ agent.currentMessage }}</p>
          <details v-if="agent.reasoning"><summary>思考过程</summary><pre class="reasoning">{{ agent.reasoning }}</pre></details>
          <details v-if="agent.activities?.length"><summary>工具调用（{{ agent.activities.length }}）</summary>
            <div v-for="activity in agent.activities" :key="activity.id" class="tool-row">
              <div><CoomiIcon name="tool" :size="13" /><b>{{ activity.toolName || activity.kind }}</b><em :class="activity.toolStatus">{{ statusText(activity.toolStatus || '') }}</em></div>
              <pre v-if="formatArgs(activity.arguments)">{{ formatArgs(activity.arguments) }}</pre>
              <p v-if="activity.content">{{ activity.content }}</p>
            </div>
          </details>
          <pre v-if="agent.output" class="output">{{ agent.output }}</pre>
        </article>
      </section>

      <section v-if="activeTab === 'events'" class="panel events">
        <p v-if="!events.length" class="empty">等待团队产生执行动态</p>
        <div v-for="event in events" :key="event.seq" class="event">
          <span class="dot" /><code>#{{ event.seq }}</code>
          <span class="event-type">{{ event.eventType || event.event_type }}</span>
          <small>{{ eventText(event) }}</small>
        </div>
      </section>

      <section v-if="task && activeTab === 'artifacts'" class="panel artifacts">
        <p v-if="!artifactPaths.length" class="empty">任务完成后，产物会出现在这里</p>
        <FileInline v-else :paths="artifactPaths" />
        <p v-if="task.summary" class="summary">{{ task.summary }}</p>
      </section>
    </main>

    <form class="composer" @submit.prevent="send">
      <input v-model="input" :disabled="busy || ['starting', 'running'].includes(task?.status ?? '')" :placeholder="['starting', 'running'].includes(task?.status ?? '') ? '本轮执行中，停止或完成后可追加指令' : '追加指令，团队会基于历史继续'" />
      <button class="send" :disabled="busy || !input.trim()" aria-label="发送"><CoomiIcon name="arrowUp" :size="16" /></button>
    </form>
  </div>
</template>

<style scoped>
.page{display:flex;flex-direction:column;height:100%;min-width:0;overflow:hidden;background:var(--page)}.body{flex:1;min-width:0;min-height:0;overflow-x:hidden;overflow-y:auto;padding:12px}.icon-btn{display:grid;place-items:center;width:44px;height:44px;border:0;background:none;color:var(--danger)}.icon-btn:disabled{opacity:.4}.notice{display:flex;gap:7px;align-items:center;padding:9px;border-radius:var(--r-md);background:var(--danger-soft);color:var(--danger);font-size:12px}.overview,.panel{min-width:0;max-width:100%;overflow:hidden;margin-bottom:11px;padding:12px;border:1px solid var(--border);border-radius:var(--r-card);background:var(--bg)}.ov-title{display:flex;gap:8px;align-items:center}.state,.mode,.agent-head em,.tool-row em{padding:3px 8px;border-radius:var(--r-pill);background:var(--fill);color:var(--text-3);font-size:10.5px;font-style:normal}.state.running,.state.starting,.agent-head em.running,.tool-row em.running{background:var(--blue-soft);color:var(--blue)}.state.completed,.agent-head em.completed,.tool-row em.completed{background:var(--ok-soft);color:var(--ok)}.state.failed,.agent-head em.failed,.tool-row em.failed{background:var(--danger-soft);color:var(--danger)}.mode{margin-left:auto}.overview>p{margin:10px 0;color:var(--text-2);font-size:13px;line-height:1.6}.progress{height:4px;overflow:hidden;border-radius:2px;background:var(--fill-strong)}.progress i{display:block;height:100%;border-radius:inherit;background:var(--blue);transition:width .3s ease}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 0}.stats span{padding:7px;border-radius:var(--r-sm);background:var(--fill);color:var(--text-3);text-align:center;font-size:10px}.stats b{display:block;color:var(--text);font-size:14px}.team-strip{display:flex;gap:7px;margin-bottom:10px;overflow-x:auto}.team-chip{position:relative;display:flex;align-items:center;gap:6px;min-width:max-content;min-height:44px;padding:5px 10px 5px 5px;border:1px solid var(--border);border-radius:var(--r-pill);background:var(--bg);color:var(--text-2);animation:coomi-cascade .2s ease both}.team-chip>span{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--blue-soft);color:var(--blue);font-size:11px}.team-chip b{font-size:11px}.team-chip i{width:7px;height:7px;border-radius:50%;background:var(--text-3)}.team-chip.running i{background:var(--blue);animation:team-pulse 1.1s ease-in-out infinite}.team-chip.completed i{background:var(--ok)}.team-chip.failed i{background:var(--danger)}.phase-track{display:grid;grid-template-columns:repeat(3,1fr);margin-bottom:10px;padding:10px;border:1px solid var(--border);border-radius:var(--r-card);background:var(--bg)}.phase{position:relative;color:var(--text-3);text-align:center;font-size:10.5px}.phase:before{content:'';position:absolute;top:5px;left:-50%;width:100%;height:2px;background:var(--border)}.phase:first-child:before{display:none}.phase i{position:relative;z-index:1;display:block;width:11px;height:11px;margin:0 auto 5px;border:2px solid var(--border);border-radius:50%;background:var(--bg)}.phase.done{color:var(--blue)}.phase.done:before,.phase.done i{border-color:var(--blue);background:var(--blue)}@keyframes team-pulse{50%{opacity:.3}}.actions{display:flex;gap:8px}.btn{min-height:44px;padding:0 15px;border:0;border-radius:var(--r-md);background:var(--fill-strong);color:var(--text-2);font-size:12px;font-weight:600}.btn.primary{background:var(--blue);color:white}.btn.danger{background:var(--danger-soft);color:var(--danger)}.btn:disabled{opacity:.45}.tabs{display:grid;grid-template-columns:repeat(4,1fr);margin-bottom:10px;padding:3px;border-radius:var(--r-md);background:var(--fill)}.tabs button{min-height:44px;border:0;border-radius:var(--r-sm);background:none;color:var(--text-3);font-size:12px}.tabs button.on{background:var(--bg);color:var(--text);box-shadow:var(--shadow-2)}.tabs em{font-style:normal;font-size:10px;color:var(--text-3)}.agent{min-width:0;max-width:100%;overflow:hidden;margin-top:8px;padding:10px;border-radius:var(--r-md);background:var(--fill)}.agent:first-child{margin-top:0}.agent-head{display:flex;align-items:center;gap:7px;font-size:12px}.agent-head em{margin-left:auto}.avatar{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--blue-soft);color:var(--blue)}.agent-error{padding:7px;border-radius:var(--r-sm);background:var(--danger-soft);color:var(--danger);font-size:11px}details{margin-top:8px;color:var(--text-3);font-size:11px}summary{min-height:32px;line-height:32px}.reasoning,.output,.tool-row pre{overflow:auto;margin:7px 0 0;padding:8px;border-radius:var(--r-sm);background:var(--code-bg);color:var(--code-text);font:11px/1.55 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}.output{max-height:300px}.tool-row{margin-top:7px;padding:8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg)}.tool-row>div{display:flex;align-items:center;gap:6px;color:var(--text-2)}.tool-row>div em{margin-left:auto}.tool-row p{margin:6px 0 0;color:var(--text-3);white-space:pre-wrap}.empty{padding:20px 0;color:var(--text-3);text-align:center;font-size:12px}.event{display:grid;grid-template-columns:7px 34px minmax(90px,auto) 1fr;align-items:baseline;gap:6px;min-height:34px;padding:7px 0;border-top:1px solid var(--border);font-size:11px;color:var(--text-2)}.event:first-of-type{border-top:0}.dot{width:6px;height:6px;border-radius:50%;background:var(--blue)}.event code{color:var(--text-3)}.event-type{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.event small{min-width:0;color:var(--text-3);white-space:pre-wrap;word-break:break-word}.summary{margin-top:12px;padding-top:12px;border-top:1px solid var(--border);color:var(--text-2);font-size:12px;line-height:1.6;white-space:pre-wrap}.composer{display:flex;gap:6px;padding:8px 10px calc(var(--safe-bottom) + 8px);border-top:1px solid var(--border);background:var(--bg)}.composer input{flex:1;min-width:0;height:44px;padding:0 14px;border:1px solid var(--border);border-radius:var(--r-pill);background:var(--fill);color:var(--text);font-size:13px;outline:none}.send{display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:50%;background:var(--blue);color:white}.send:disabled{opacity:.4}
</style>
