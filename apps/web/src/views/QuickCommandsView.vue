<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CoomiIcon from '@/components/CoomiIcon.vue'
import PageHead from '@/components/PageHead.vue'
import { goBack } from '@/bridge/navigation'
import {
  QUICK_COMMAND_ICONS,
  createQuickCommandSet,
  loadQuickCommandConfig,
  resetQuickCommandConfig,
  saveQuickCommandConfig,
  type QuickCommand,
} from '@/utils/quickCommands'

const router = useRouter()
const route = useRoute()
const config = ref(loadQuickCommandConfig())
const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | null = null

const iconLabels: Record<string, string> = {
  phone: '手机', globe: '网络', sparkle: '灵感', cube: '拓展', terminal: '终端', git: '版本',
  folder: '文件', chat: '对话', memory: '记忆', target: '目标', bolt: '快速', shield: '安全',
}

const activeSet = computed(() => config.value.sets.find(set => set.id === config.value.activeSetId) ?? config.value.sets[0])

function flash(message: string) {
  notice.value = message
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { notice.value = '' }, 1800)
}

function persist(message = '已保存') {
  try {
    config.value = saveQuickCommandConfig(config.value)
    flash(message)
  } catch {
    config.value = loadQuickCommandConfig()
    flash('保存失败，请重试')
  }
}

function selectSet(id: string) {
  config.value.activeSetId = id
  persist('已切换指令方案')
}

function addSet() {
  if (config.value.sets.length >= 12) {
    flash('最多保存 12 套指令方案')
    return
  }
  config.value = createQuickCommandSet(config.value, `指令方案 ${config.value.sets.length + 1}`)
  persist('已新建并切换方案')
}

function deleteActiveSet() {
  if (config.value.sets.length <= 1) return
  const id = activeSet.value.id
  config.value.sets = config.value.sets.filter(set => set.id !== id)
  config.value.activeSetId = config.value.sets[0].id
  persist('已删除方案')
}

function resetAll() {
  config.value = resetQuickCommandConfig()
  persist('已恢复默认指令')
}

function editContent(command: QuickCommand) {
  command.guide = undefined
}

function back() {
  if (route.query.native === '1' && window.CoomiAndroid?.closeHostActivity) {
    window.CoomiAndroid.closeHostActivity()
    return
  }
  goBack(router, '/')
}

onBeforeUnmount(() => {
  if (noticeTimer) clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="page">
    <PageHead title="新会话快捷指令" @back="back">
      <template #right><button class="head-save" @click="persist()">保存</button></template>
    </PageHead>
    <main class="body">
      <section class="sets" aria-label="指令方案">
        <div class="set-scroll">
          <button v-for="set in config.sets" :key="set.id" class="set-chip" :class="{ on: set.id === config.activeSetId }" @click="selectSet(set.id)">
            {{ set.name }}
          </button>
        </div>
        <button class="icon-action" :disabled="config.sets.length >= 12" aria-label="新建指令方案" @click="addSet"><CoomiIcon name="plus" :size="17" /></button>
      </section>

      <section class="set-meta">
        <label><span>方案名称</span><input v-model="activeSet.name" maxlength="30" placeholder="例如：开发工作" /></label>
        <button v-if="config.sets.length > 1" class="delete" @click="deleteActiveSet">删除方案</button>
      </section>

      <p class="intro">新会话待机页固定显示当前方案的四条指令。图标、名称和发送内容都可以单独修改。</p>

      <section class="command-list">
        <article v-for="(command, index) in activeSet.commands" :key="command.id" class="command-card">
          <header>
            <span class="icon-preview"><CoomiIcon :name="command.icon" :size="18" /></span>
            <strong>快捷指令 {{ index + 1 }}</strong>
          </header>
          <div class="fields">
            <label class="icon-field">
              <span>图标</span>
              <select v-model="command.icon">
                <option v-for="icon in QUICK_COMMAND_ICONS" :key="icon" :value="icon">{{ iconLabels[icon] }}</option>
              </select>
            </label>
            <label class="name-field"><span>指令名</span><input v-model="command.name" maxlength="40" placeholder="待机页显示名称" /></label>
            <label class="content-field"><span>指令内容</span><textarea v-model="command.content" rows="2" maxlength="4000" placeholder="点击后发送给 Coomi 的完整内容" @input="editContent(command)" /></label>
          </div>
        </article>
      </section>

      <div class="bottom-actions">
        <button class="reset" @click="resetAll"><CoomiIcon name="refresh" :size="15" />恢复默认</button>
        <span role="status">{{ notice }}</span>
        <button class="save" @click="persist()">保存当前方案</button>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page { display:flex; flex-direction:column; height:100%; background:var(--page); }
.head-save { min-height:34px; padding:0 12px; border-radius:var(--r-pill); background:var(--blue-soft); color:var(--blue); font-size:13px; font-weight:650; }
.body { flex:1; min-height:0; overflow-y:auto; padding:12px 12px calc(var(--safe-bottom) + 18px); }
.sets { display:flex; align-items:center; gap:8px; }
.set-scroll { display:flex; flex:1; min-width:0; gap:7px; overflow-x:auto; scrollbar-width:none; }
.set-scroll::-webkit-scrollbar { display:none; }
.set-chip { flex:0 0 auto; min-height:34px; padding:0 13px; border:1px solid var(--border); border-radius:var(--r-pill); background:var(--bg); color:var(--text-2); font-size:12.5px; }
.set-chip.on { border-color:var(--blue-border); background:var(--blue-soft); color:var(--blue); font-weight:650; }
.icon-action { display:grid; place-items:center; flex:0 0 34px; width:34px; height:34px; border-radius:50%; background:var(--blue); color:#fff; }
.icon-action:disabled { opacity:.35; }
.set-meta { display:flex; align-items:flex-end; gap:8px; margin-top:11px; }
.set-meta label { flex:1; min-width:0; }
label { display:flex; flex-direction:column; gap:5px; color:var(--text-3); font-size:11.5px; }
input, select, textarea { width:100%; border:1px solid var(--border); border-radius:10px; background:var(--bg-input); color:var(--text); font:inherit; font-size:13px; outline:none; }
input, select { height:38px; padding:0 10px; }
textarea { min-height:62px; padding:9px 10px; line-height:1.5; resize:vertical; }
input:focus, select:focus, textarea:focus { border-color:var(--blue-border); box-shadow:var(--ring-focus); }
.delete { height:38px; padding:0 11px; border-radius:10px; background:var(--danger-soft); color:var(--danger); font-size:12px; }
.intro { margin:12px 2px 10px; color:var(--text-3); font-size:12px; line-height:1.55; }
.command-list { display:flex; flex-direction:column; gap:9px; }
.command-card { overflow:hidden; border:1px solid color-mix(in srgb,var(--border) 80%,transparent); border-radius:var(--r-card); background:var(--bg); box-shadow:var(--shadow-1); }
.command-card header { display:flex; align-items:center; gap:9px; padding:9px 11px 7px; }
.command-card header strong { font-size:13.5px; color:var(--text); }
.icon-preview { display:grid; place-items:center; width:30px; height:30px; border-radius:9px; background:var(--blue-soft); color:var(--blue); }
.fields { display:grid; grid-template-columns:108px minmax(0,1fr); gap:8px; padding:0 11px 11px; }
.content-field { grid-column:1 / -1; }
.bottom-actions { position:sticky; bottom:calc(var(--safe-bottom) * -1); display:flex; align-items:center; gap:8px; margin-top:12px; padding:9px 0; background:linear-gradient(180deg,transparent,var(--page) 22%); }
.bottom-actions button { display:inline-flex; align-items:center; justify-content:center; gap:5px; height:38px; padding:0 13px; border-radius:11px; font-size:12.5px; }
.bottom-actions span { flex:1; color:var(--ok); font-size:11.5px; text-align:center; }
.reset { background:var(--fill); color:var(--text-2); }.save { background:var(--blue); color:#fff; font-weight:650; }
@media (max-width:360px) { .fields { grid-template-columns:92px minmax(0,1fr); } }
</style>
