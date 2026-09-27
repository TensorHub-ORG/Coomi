<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { authedFetch } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'

type EventName = 'session_start' | 'turn_start' | 'turn_end' | 'pre_tool_use' | 'post_tool_use'
type KeywordMatch = 'disabled' | 'exact' | 'contains'
interface HookItem {
  enabled: boolean
  matcher: string
  keyword: string
  keyword_match: KeywordMatch
  command: string
  args: string[]
  timeout_ms: number
}
const EVENTS: Array<{ value: EventName; label: string }> = [
  { value: 'session_start', label: '会话开始' }, { value: 'turn_start', label: '每轮开始' },
  { value: 'turn_end', label: '每轮结束' }, { value: 'pre_tool_use', label: '工具调用前' },
  { value: 'post_tool_use', label: '工具调用后' },
]
const router = useRouter()
const hooks = ref<Record<EventName, HookItem[]>>({ session_start: [], turn_start: [], turn_end: [], pre_tool_use: [], post_tool_use: [] })
const saving = ref(false)
const notice = ref('')

onMounted(async () => {
  try {
    const response = await authedFetch('/api/runtime/hooks')
    const data = await response.json()
    for (const event of EVENTS) {
      hooks.value[event.value] = (data.hooks?.[event.value] ?? []).map((hook: Partial<HookItem>) => ({
        enabled: hook.enabled ?? true,
        matcher: hook.matcher ?? '*',
        keyword: hook.keyword ?? '',
        keyword_match: hook.keyword_match ?? 'disabled',
        command: hook.command ?? '',
        args: hook.args ?? [],
        timeout_ms: hook.timeout_ms ?? 10000,
      }))
    }
  } catch { notice.value = '加载钩子配置失败' }
})

function add(event: EventName) {
  hooks.value[event].push({ enabled: true, matcher: '*', keyword: '', keyword_match: 'disabled', command: '', args: [], timeout_ms: 10000 })
}

function isToolEvent(event: EventName) { return event === 'pre_tool_use' || event === 'post_tool_use' }

async function save() {
  saving.value = true; notice.value = ''
  try {
    const response = await authedFetch('/api/runtime/hooks', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hooks: hooks.value }),
    })
    if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`)
    notice.value = '已保存，新会话开始时生效'
  } catch (error) { notice.value = error instanceof Error ? error.message : String(error) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="page">
    <PageHead title="自定义钩子（实验）" @back="goBack(router, 'dashboard')" />
    <main class="body">
      <section v-for="event in EVENTS" :key="event.value" class="section">
        <div class="head"><b>{{ event.label }}</b><button @click="add(event.value)"><CoomiIcon name="plus" :size="16" /></button></div>
        <div v-for="(hook, index) in hooks[event.value]" :key="index" class="hook">
          <label class="toggle"><input v-model="hook.enabled" type="checkbox" />启用</label>
          <input v-model="hook.command" placeholder="命令绝对路径" />
          <input v-if="isToolEvent(event.value)" v-model="hook.matcher" placeholder="匹配工具名，默认 *" />
          <template v-if="event.value === 'turn_start'">
            <div class="match-mode" role="group" aria-label="触发方式">
              <button :class="{ on: hook.keyword_match === 'disabled' }" @click="hook.keyword_match = 'disabled'">每轮</button>
              <button :class="{ on: hook.keyword_match === 'exact' }" @click="hook.keyword_match = 'exact'">全匹配</button>
              <button :class="{ on: hook.keyword_match === 'contains' }" @click="hook.keyword_match = 'contains'">句中匹配</button>
            </div>
            <input v-if="hook.keyword_match !== 'disabled'" v-model="hook.keyword" maxlength="200" placeholder="触发关键词" />
          </template>
          <input :value="hook.args.join(' ')" placeholder="参数，以空格分隔" @input="hook.args = ($event.target as HTMLInputElement).value.split(/\s+/).filter(Boolean)" />
          <label class="timeout">超时（毫秒）<input v-model.number="hook.timeout_ms" type="number" min="100" max="60000" /></label>
          <button class="remove" @click="hooks[event.value].splice(index, 1)">删除</button>
        </div>
      </section>
      <button class="save" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存钩子' }}</button>
      <p v-if="notice" class="notice">{{ notice }}</p>
      <section class="guide" aria-label="配置说明">
        <h2>配置说明</h2>
        <p><b>事件：</b>会话开始、每轮开始/结束以及工具调用前后均可独立配置命令。</p>
        <p><b>工具匹配：</b>仅工具事件使用匹配项，填写工具名称；<code>*</code> 表示匹配全部工具。</p>
        <p><b>关键词：</b>在“每轮开始”中可设为全匹配或句中匹配。全匹配允许关键词前后出现空格、标点等符号，但不能有其他文字；句中匹配只要输入中包含关键词就会触发。</p>
        <p><b>命令：</b>必须填写本机可执行文件的完整路径。</p>
        <p><b>参数：</b>填写传给命令的命令行参数，以空格分隔，每一项会按顺序原样传入。参数不经过 Shell，不会展开 <code>~</code>、变量、通配符或引号；路径请使用完整路径，单个参数本身不能包含空格。</p>
        <p><b>超时：</b>默认 10 秒。钩子在本机执行，请只配置可信命令，并避免在命令参数中写入密钥。</p>
        <div class="example">
          <h3>样例：调用工具前运行 Bash 检查脚本</h3>
          <dl>
            <dt>事件</dt><dd>工具调用前</dd>
            <dt>命令</dt><dd>Runtime V2 提供的 Bash（按当前运行时 PREFIX 解析）</dd>
            <dt>匹配</dt><dd><code>local_shell</code></dd>
            <dt>参数</dt><dd><code>--noprofile &lt;运行时 HOME&gt;/hooks/check_tool.sh</code></dd>
          </dl>
          <p>上例等价于依次传入两个参数：<code>--noprofile</code> 和脚本完整路径。当前工具事件会以 JSON 写入脚本的标准输入；脚本不需要修改结果时可不输出，需要控制行为时应向标准输出返回合法 JSON。</p>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 12px 12px calc(var(--safe-bottom) + 24px); }
.section { margin-bottom: 12px; padding: 12px; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.head { display: flex; align-items: center; justify-content: space-between; font-size: 14px; color: var(--text); }
.head button { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: var(--blue-soft); color: var(--blue); }
.hook { display: grid; gap: 7px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
.hook input:not([type=checkbox]) { height: 40px; padding: 0 11px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--fill); color: var(--text); }
.toggle { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text-2); }
.match-mode { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; padding: 2px; border-radius: var(--r-md); background: var(--fill-strong); }
.match-mode button { min-height: 36px; border-radius: 9px; color: var(--text-2); font-size: 12.5px; }
.match-mode button.on { background: var(--bg); color: var(--blue); font-weight: 650; }
.timeout { display: grid; grid-template-columns: 1fr 130px; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-2); }
.remove { justify-self: end; color: var(--danger); font-size: 12.5px; background: none; }
.save { width: 100%; min-height: 44px; border-radius: var(--r-md); background: var(--blue); color: #fff; font-weight: 650; }
.notice { margin: 10px 2px; font-size: 12.5px; color: var(--text-2); }
.guide { margin-top: 18px; padding: 4px 2px 0; border-top: 1px solid var(--border); color: var(--text-2); }
.guide h2 { margin: 14px 0 8px; font-size: 14px; color: var(--text); }
.guide p { margin: 7px 0; font-size: 12.5px; line-height: 1.65; }
.guide code { padding: 1px 4px; border-radius: 4px; background: var(--fill); color: var(--text); }
.example { margin-top: 13px; padding: 11px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg); }
.example h3 { margin: 0 0 9px; font-size: 13px; color: var(--text); }
.example dl { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 7px 8px; margin: 0; font-size: 12px; line-height: 1.55; }
.example dt { color: var(--text-3); }
.example dd { min-width: 0; margin: 0; color: var(--text-2); overflow-wrap: anywhere; }
.example p { margin-bottom: 0; }
</style>
