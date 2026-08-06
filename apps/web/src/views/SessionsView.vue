<script setup lang="ts">
/**
 * 会话历史整页版（抽屉的补充：多了搜索结果计数和「清空全部」）。
 *
 * 列表来自引擎磁盘会话（/api/sessions 为权威源），本地 localStorage 保存标题/置顶等
 * 元数据与最近对话正文；删除会话会同时删除引擎磁盘记录与本地记录。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useSessionsStore, formatSessionTime, type SessionMeta } from '@/stores/sessions'
import { useConfigStore } from '@/stores/config'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

const router = useRouter()
const session = useSessionStore()
const sessions = useSessionsStore()
const config = useConfigStore()

const menuFor = ref<SessionMeta | null>(null)
const askDelete = ref<SessionMeta | null>(null)
const askClear = ref(false)

function open(id: string) {
  session.openSession(id)
  router.push('/')
}

function startNew() {
  session.newSession()
  router.push('/')
}

function doPin() {
  if (menuFor.value) sessions.togglePin(menuFor.value.id)
  menuFor.value = null
}

function confirmDelete() {
  if (askDelete.value) session.deleteSession(askDelete.value.id)
  askDelete.value = null
  menuFor.value = null
}

function doClear() {
  askClear.value = false
  sessions.clearAll()
  session.newSession()
  router.push('/')
}

// 进入页面时先同步引擎磁盘会话（权威源），再刷新各会话的后台运行状态。
// 只刷新 running 会导致直接从对话页跳进来时列表为空/无摘要。
onMounted(() => {
  void sessions.syncFromEngine()
  sessions.refreshRunning()
})
</script>
<template>
  <div class="page">
    <PageHead title="会话历史" @back="router.push('/')">
      <template #right>
        <button class="icon-btn blue" aria-label="新对话" @click="startNew">
          <CoomiIcon name="plus" />
        </button>
      </template>
    </PageHead>

    <div class="searchrow">
      <span class="search">
        <CoomiIcon name="search" :size="16" />
        <input v-model="sessions.query" class="sinput" placeholder="搜索会话标题" />
        <button v-if="sessions.query" class="clr" aria-label="清空" @click="sessions.query = ''">
          <CoomiIcon name="close" :size="14" />
        </button>
      </span>
    </div>

    <main class="body">
      <!-- 历史会话列表始终可见；「全局会话记忆」开关只控制模型能否读取这些记录。 -->
      <p v-if="sessions.metas.length === 0" class="empty">
        还没有历史会话。回到对话随便说点什么，标题会用你的第一句话。
      </p>
      <p v-else-if="sessions.filtered.length === 0" class="empty">没有匹配「{{ sessions.query }}」的会话。</p>

        <template v-for="g in sessions.groups" :key="g.label">
          <p class="sec-label">{{ g.label }}</p>
          <div class="group">
            <div v-for="m in g.items" :key="m.id" class="row" :class="{ cur: m.id === session.sessionId }">
              <button class="rmain" @click="open(m.id)">
                <span class="rtitle">
                  <CoomiIcon v-if="m.pinned" name="pin" :size="13" class="pin" />
                  <span class="ttext">{{ m.title }}</span>
                </span>
                <span v-if="m.summary" class="rsummary">{{ m.summary }}</span>
                <span class="rmeta">
                  <span v-if="m.id === session.sessionId" class="badge">当前</span>
                  {{ formatSessionTime(m.updatedAt) }} · {{ m.turns }} 轮
                  <span v-if="sessions.isRunning(m.id)" class="rspin" aria-label="后台运行中" />
                </span>
              </button>
              <button class="more" aria-label="更多" @click="menuFor = m"><CoomiIcon name="more" :size="18" /></button>
            </div>
          </div>
        </template>
        <button v-if="sessions.metas.length" class="btn btn-danger wide" @click="askClear = true">清空全部记录</button>
        <p class="note">
          历史会话保存在引擎里（这台手机的应用私有目录），最近 12 条会留完整对话内容。
          用同一个会话继续时，只要引擎进程还活着就是真的接上了上下文；引擎重启过的话，
          就只剩本机这份记录。
        </p>
    </main>
    <div v-if="menuFor" class="scrim" @click.self="menuFor = null">
      <div class="sheet">
        <div class="grip" />
        <p class="stitle">{{ menuFor.title }}</p>
        <button class="sact" @click="doPin">
          <CoomiIcon name="pin" :size="17" /><span>{{ menuFor.pinned ? '取消置顶' : '置顶' }}</span>
        </button>
        <button class="sact danger" @click="askDelete = menuFor; menuFor = null">
          <CoomiIcon name="trash" :size="17" /><span>删除会话</span>
        </button>
        <button class="sact plain" @click="menuFor = null"><span>取消</span></button>
      </div>
    </div>

    <div v-if="askDelete" class="scrim" @click.self="askDelete = null">
      <div class="sheet">
        <div class="grip" />
        <p class="stitle">删除这个会话？</p>
        <p class="ssub">「{{ askDelete.title }}」的引擎记录与本机记录都会被删除，无法恢复。</p>
        <div class="sacts">
          <button class="btn" @click="askDelete = null">取消</button>
          <button class="btn btn-danger" @click="confirmDelete">删除</button>
        </div>
      </div>
    </div>

    <div v-if="askClear" class="scrim" @click.self="askClear = false">
      <div class="sheet">
        <div class="grip" />
        <p class="stitle">清空全部 {{ sessions.metas.length }} 条记录？</p>
        <p class="ssub">本机的标题和对话内容都会删掉，无法恢复。</p>
        <div class="sacts">
          <button class="btn" @click="askClear = false">取消</button>
          <button class="btn btn-danger" @click="doClear">清空</button>
        </div>
      </div>
    </div>

  </div>
</template>
<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.icon-btn.blue { color: var(--blue); }

.searchrow { flex-shrink: 0; padding: 10px 12px 4px; background: var(--page); }
.search {
  display: flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 12px; border-radius: var(--r-pill);
  background: var(--bg); color: var(--text-3); box-shadow: var(--shadow-1);
}
.sinput { flex: 1; min-width: 0; border: 0; background: none; font-size: 14px; color: var(--text); }
.sinput:focus { outline: none; }
.sinput::placeholder { color: var(--text-3); }
.clr { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--fill-strong); color: var(--text-2); }

.body { flex: 1; overflow-y: auto; padding: 6px 12px calc(var(--safe-bottom) + 24px); }
.empty { padding: 26px 10px; text-align: center; font-size: 13.5px; line-height: 1.75; color: var(--text-3); }
.sec-label { margin: 14px 0 0; }

.group { border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.row { display: flex; align-items: stretch; }
.row + .row { border-top: 1px solid var(--border); }
.row.cur { background: var(--blue-soft); }
.rmain { flex: 1; min-width: 0; padding: 12px 4px 12px 14px; text-align: left; }
.rmain:active { background: var(--fill); }
.rtitle { display: flex; align-items: center; gap: 5px; }
.pin { flex-shrink: 0; color: var(--blue); }
.rmeta { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 12px; color: var(--text-3); }
/* 会话在后台执行中的小圈（放在时间/轮数之后，与 meta 文字同高） */
.rspin {
  flex-shrink: 0;
  width: 9px; height: 9px; border-radius: 50%;
  border: 2px solid var(--blue-soft);
  border-top-color: var(--blue);
  animation: coomi-rspin 0.9s linear infinite;
}
@keyframes coomi-rspin { to { transform: rotate(360deg); } }
.ttext {
  min-width: 0; font-size: 14.5px; font-weight: 550; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 会话摘要（引擎侧推导，供检索与快速识别内容） */
.rsummary {
  display: block; margin-top: 3px; font-size: 12px; line-height: 1.5; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rmeta { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 12px; color: var(--text-3); }
.badge { padding: 1px 7px; border-radius: var(--r-pill); background: var(--blue); color: #fff; font-size: 10.5px; font-weight: 650; }
.more { display: grid; place-items: center; flex-shrink: 0; width: 44px; color: var(--text-3); }
.more:active { background: var(--fill); }

.wide { width: 100%; margin-top: 18px; }
.note { margin-top: 14px; padding: 0 4px; font-size: 12px; line-height: 1.75; color: var(--text-3); }
.scrim {
  position: fixed; inset: 0; z-index: 70;
  display: flex; align-items: flex-end;
  background: rgba(17, 22, 31, .36); animation: fade .18s ease-out;
}
@keyframes fade { from { opacity: 0; } }
.sheet {
  width: 100%; padding: 6px 14px calc(var(--safe-bottom) + 14px);
  border-radius: 22px 22px 0 0; background: var(--bg);
  box-shadow: var(--shadow-sheet); animation: rise .26s cubic-bezier(.2, .8, .2, 1);
}
@keyframes rise { from { transform: translateY(100%); } }
.grip { width: 38px; height: 4px; margin: 4px auto 12px; border-radius: 2px; background: var(--border-strong); }
.stitle {
  padding: 0 6px 10px; font-size: 14px; font-weight: 600; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ssub { padding: 0 6px; font-size: 13px; line-height: 1.6; color: var(--text-2); }
.sact {
  display: flex; align-items: center; gap: 11px;
  width: 100%; min-height: 50px; padding: 0 12px;
  border-radius: var(--r-md); text-align: left;
  font-size: 15px; color: var(--text);
}
.sact:active { background: var(--fill); }
.sact :deep(svg) { color: var(--text-2); }
.sact.danger, .sact.danger :deep(svg) { color: var(--danger); }
.sact.plain { justify-content: center; margin-top: 4px; color: var(--text-2); font-weight: 550; }
.sacts { display: flex; gap: 8px; margin-top: 16px; }
.sacts .btn { flex: 1; }

</style>


