<script setup lang="ts">
/**
 * 左侧会话抽屉。
 * DeepSeek 的抽屉是「推开主内容」而不是盖住，主体的位移由 ChatView 负责，
 * 这里只管面板自己的滑入、搜索、分组列表和行内操作。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { formatSessionTime, useSessionsStore, type SessionMeta } from '@/stores/sessions'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const router = useRouter()
const session = useSessionStore()
const sessions = useSessionsStore()

const menuFor = ref<SessionMeta | null>(null)
const renamingId = ref('')
const renameText = ref('')

const isEmpty = computed(() => sessions.groups.length === 0)

// 抽屉一关就把临时态清掉；打开时立即刷新一次各会话的「后台运行中」
// 状态（常驻轮询由 ChatView 全局负责，这里只保证打开瞬间是最新的）。
watch(() => props.open, v => {
  if (!v) {
    menuFor.value = null; renamingId.value = ''
    return
  }
  sessions.refreshRunning()
})

function pick(id: string) {
  if (renamingId.value) return
  session.openSession(id)
  emit('close')
}

function startNew() {
  session.newSession()
  emit('close')
}

function closeMenu() { menuFor.value = null }

/** WebView 里 window.prompt 默认被吞掉，所以重命名走行内输入框。 */
async function beginRename() {
  const m = menuFor.value
  if (!m) return
  renamingId.value = m.id
  renameText.value = m.title
  menuFor.value = null
  await nextTick()
  const el = document.querySelector<HTMLInputElement>('.drawer-root .rename')
  el?.focus()
  el?.select()
}

function commitRename() {
  if (!renamingId.value) return
  sessions.rename(renamingId.value, renameText.value)
  renamingId.value = ''
}

function doPin() {
  if (!menuFor.value) return
  sessions.togglePin(menuFor.value.id)
  closeMenu()
}

function doDelete() {
  if (!menuFor.value) return
  session.deleteSession(menuFor.value.id)
  closeMenu()
}

function go(path: string) { router.push(path); emit('close') }
function openDashboard() {
  emit('close')
  if (window.CoomiAndroid?.openDashboard) window.CoomiAndroid.openDashboard()
  else window.location.href = 'coomi://dashboard'
}
</script>

<template>
  <div class="drawer-root" :class="{ open }">
    <div class="scrim" @click="emit('close')" />

    <aside class="panel" role="dialog" aria-label="会话历史">
      <header class="dhead">
        <div class="sfield">
          <CoomiIcon name="search" :size="17" />
          <input v-model="sessions.query" type="text" placeholder="搜索历史会话" enterkeyhint="search" />
          <button v-if="sessions.query" class="clr" aria-label="清空" @click="sessions.query = ''">
            <CoomiIcon name="close" :size="12" />
          </button>
        </div>
        <button class="close-btn" aria-label="设置" @click="go('/settings')">
          <CoomiIcon name="settings" :size="19" />
        </button>
      </header>

      <button class="newrow" @click="startNew">
        <span class="nicon"><CoomiIcon name="pencil" :size="17" /></span>
        <span>开启新对话</span>
      </button>

      <div class="list">
        <!-- 历史会话列表始终可见；「全局会话记忆」开关只控制模型能否读取这些记录。 -->
        <p v-if="isEmpty" class="empty">
          还没有历史会话。<br />随便说点什么，标题会用你的第一句话。
        </p>
        <template v-for="g in sessions.groups" :key="g.label">
          <p class="sec-label">{{ g.label }}</p>
          <div
            v-for="m in g.items"
            :key="m.id"
            class="row"
            :class="{ cur: m.id === session.sessionId }"
            @click="pick(m.id)"
          >
            <div class="rmain">
              <input
                v-if="renamingId === m.id"
                v-model="renameText"
                class="rename"
                @click.stop
                @keyup.enter="commitRename"
                @blur="commitRename"
              />
              <p v-else class="rtitle">{{ m.title }}</p>
              <p class="rmeta">
                <CoomiIcon v-if="m.pinned" name="pin" :size="11" />
                <span>{{ formatSessionTime(m.updatedAt) }}</span>
                <template v-if="m.turns">
                  <span>·</span><span>{{ m.turns }} 轮</span>
                </template>
                <span v-if="sessions.isRunning(m.id)" class="rspin" aria-label="后台运行中" />
              </p>
            </div>
            <button class="rmore" aria-label="更多" @click.stop="menuFor = m">
              <CoomiIcon name="more" :size="17" />
            </button>
          </div>
        </template>
      </div>

      <footer class="dfoot">
        <button class="frow console" @click="openDashboard">
          <CoomiIcon name="terminal" :size="20" />
          <span class="fname">返回控制台</span>
          <CoomiIcon name="chevronRight" :size="17" class="fgear" />
        </button>
      </footer>
    </aside>

    <div v-if="menuFor" class="sheet-wrap" @click.self="closeMenu">
      <div class="sheet">
        <p class="sheet-title">{{ menuFor.title }}</p>
        <button class="sheet-item" @click="beginRename">
          <CoomiIcon name="pencil" :size="18" /><span>重命名</span>
        </button>
        <button class="sheet-item" @click="doPin">
          <CoomiIcon name="pin" :size="18" /><span>{{ menuFor.pinned ? '取消置顶' : '置顶' }}</span>
        </button>
        <button class="sheet-item danger" @click="doDelete">
          <CoomiIcon name="trash" :size="18" /><span>删除会话</span>
        </button>
        <button class="sheet-cancel" @click="closeMenu">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drawer-root { position: fixed; inset: 0; z-index: 60; pointer-events: none; }
.drawer-root.open { pointer-events: auto; }

.scrim {
  position: absolute; inset: 0;
  background: rgba(17, 22, 31, .34);
  opacity: 0; transition: opacity .28s ease;
}
.drawer-root.open .scrim { opacity: 1; }

.panel {
  position: absolute; inset: 0 auto 0 0;
  display: flex; flex-direction: column;
  width: 82%; max-width: 340px;
  padding-top: var(--safe-top);
  background: var(--bg);
  box-shadow: var(--shadow-drawer);
  transform: translateX(-102%);
  transition: transform .3s cubic-bezier(.22, .68, .19, 1);
}
.drawer-root.open .panel { transform: none; }

.dhead { display: flex; align-items: center; gap: 6px; padding: 10px 10px 6px 12px; }
.sfield {
  flex: 1; display: flex; align-items: center; gap: 7px;
  height: 38px; padding: 0 10px 0 11px;
  border-radius: var(--r-pill); background: var(--fill); color: var(--text-3);
}
.sfield input {
  flex: 1; min-width: 0; border: 0; background: none; outline: none;
  font: inherit; font-size: 14.5px; color: var(--text);
}
.sfield input::placeholder { color: var(--text-3); }
.clr {
  display: grid; place-items: center; width: 18px; height: 18px;
  border: 0; border-radius: 50%; background: var(--border-strong); color: #fff;
}
.close-btn {
  display: grid; place-items: center; width: 36px; height: 36px;
  border: 0; border-radius: 50%; background: none; color: var(--text-2);
}

.newrow {
  display: flex; align-items: center; gap: 10px;
  margin: 2px 10px 4px; padding: 8px 10px;
  border: 0; border-radius: var(--r-md); background: none;
  font-size: 15.5px; font-weight: 600; color: var(--blue);
}
.newrow:active { background: var(--fill); }
.nicon {
  display: grid; place-items: center; width: 30px; height: 30px;
  border-radius: 50%; background: var(--blue-soft);
}

.list { flex: 1; overflow-y: auto; padding: 2px 10px 10px; -webkit-overflow-scrolling: touch; }
.empty { margin: 26px 12px; font-size: 13.5px; line-height: 1.8; color: var(--text-3); }

.row {
  display: flex; align-items: center; gap: 4px;
  padding: 9px 6px 9px 10px; border-radius: var(--r-md);
}
.row:active { background: var(--fill); }
.row.cur { background: var(--blue-soft); }
.rmain { flex: 1; min-width: 0; }
.rtitle {
  font-size: 14.8px; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row.cur .rtitle { color: var(--blue); font-weight: 600; }
.rmeta {
  display: flex; align-items: center; gap: 4px; margin-top: 3px;
  font-size: 11.5px; color: var(--text-3);
}
/* 会话在后台执行中的小圈（放在时间/轮数之后，与 meta 文字同高） */
.rspin {
  flex: none;
  width: 9px; height: 9px; border-radius: 50%;
  border: 2px solid var(--blue-soft);
  border-top-color: var(--blue);
  animation: coomi-rspin 0.9s linear infinite;
}
@keyframes coomi-rspin { to { transform: rotate(360deg); } }
.rmeta {
  display: flex; align-items: center; gap: 4px; margin-top: 3px;
  font-size: 11.5px; color: var(--text-3);
}
.rename {
  width: 100%; padding: 4px 7px;
  border: 1px solid var(--blue-border); border-radius: var(--r-sm);
  background: var(--bg); outline: none;
  font: inherit; font-size: 14.5px; color: var(--text);
}
.rmore {
  display: grid; place-items: center; width: 30px; height: 30px;
  border: 0; border-radius: 50%; background: none; color: var(--text-3);
}

.dfoot { border-top: 1px solid var(--border); padding: 8px 10px calc(8px + var(--safe-bottom)); }
.frow.console { color: var(--blue); }
.frow {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px; border: 0; border-radius: var(--r-md); background: none;
}
.frow:active { background: var(--fill); }
.fname { flex: 1; text-align: left; font-size: 15px; font-weight: 600; color: var(--text); }
.fgear { color: var(--text-3); }

.sheet-wrap {
  position: absolute; inset: 0; z-index: 2;
  display: flex; align-items: flex-end;
  background: rgba(17, 22, 31, .34);
}
.sheet {
  width: 100%; padding: 4px 10px calc(10px + var(--safe-bottom));
  background: var(--bg); border-radius: 18px 18px 0 0;
  box-shadow: var(--shadow-sheet);
  animation: rise .22s cubic-bezier(.22, .68, .19, 1) both;
}
@keyframes rise { from { transform: translateY(18px); opacity: .5; } to { transform: none; opacity: 1; } }
.sheet-title {
  padding: 12px 12px 8px; font-size: 12.5px; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sheet-item {
  display: flex; align-items: center; gap: 12px;
  width: 100%; height: 50px; padding: 0 12px;
  border: 0; border-radius: var(--r-md); background: none;
  font-size: 15.5px; color: var(--text);
}
.sheet-item:active { background: var(--fill); }
.sheet-item.danger { color: var(--danger); }
.sheet-cancel {
  width: 100%; height: 48px; margin-top: 6px;
  border: 0; border-radius: var(--r-md); background: var(--fill);
  font-size: 15.5px; font-weight: 600; color: var(--text-2);
}
</style>
