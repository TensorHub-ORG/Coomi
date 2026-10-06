<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { useStudioStore } from '@/stores/studio'
import { goBack } from '@/bridge/navigation'

const router = useRouter()
const studio = useStudioStore()
const askDelete = ref('')

onMounted(() => { studio.fetchStudios() })

function createNew() { router.push('/studio/new') }
function openStudio(id: string) { router.push(`/studio/${encodeURIComponent(id)}/chat`) }
function editStudio(id: string) { router.push(`/studio/${encodeURIComponent(id)}/edit`) }

async function confirmDelete() {
  if (!askDelete.value) return
  await studio.deleteStudio(askDelete.value)
  askDelete.value = ''
}

function fmtTime(ts?: number) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString()
}
</script>

<template>
  <div class="page">
    <PageHead title="AI 工作室" @back="goBack(router, 'dashboard')">
      <template #right>
        <button class="icon-btn blue" aria-label="新建工作室" @click="createNew">
          <CoomiIcon name="plus" />
        </button>
      </template>
    </PageHead>

    <main class="body">
      <p v-if="studio.error" class="notice err">{{ studio.error }}</p>
      <p v-if="studio.loading" class="hint">加载中…</p>
      <p v-else-if="studio.studios.length === 0" class="empty">
        <CoomiIcon name="chat" :size="28" />
        <b>还没有工作室</b>
        <span>创建一个工作室，配置多个智能体协同工作。</span>
      </p>

      <div v-else class="cards">
        <div v-for="s in studio.studios" :key="s.id" class="card" @click="openStudio(s.id)">
          <div class="title-row">
            <span class="tile"><CoomiIcon name="chat" :size="18" /></span>
            <div class="meta">
              <span class="cname">{{ s.name }}</span>
              <span class="cdesc">{{ s.description || '（无描述）' }}</span>
            </div>
            <span v-if="s.running" class="badge on">运行中</span>
          </div>
          <div class="foot">
            <span>{{ s.memberCount }} 成员</span>
            <span class="last">{{ fmtTime(s.lastActive) }}</span>
            <button class="act" @click.stop="editStudio(s.id)"><CoomiIcon name="pencil" :size="14" />编辑</button>
            <button class="act peril" @click.stop="askDelete = s.id"><CoomiIcon name="trash" :size="14" />删除</button>
          </div>
        </div>
      </div>
    </main>

    <div v-if="askDelete" class="scrim" @click.self="askDelete = ''">
      <div class="sheet">
        <div class="grip" />
        <p class="stitle">删除工作室？</p>
        <p class="ssub">工作室的所有配置、消息和工单都会被删除，无法恢复。</p>
        <div class="sacts">
          <button class="btn" @click="askDelete = ''">取消</button>
          <button class="btn danger" @click="confirmDelete">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); min-width: 0; }
.icon-btn.blue { color: var(--blue); }
.notice { margin: 0 0 10px; padding: 8px 12px; border-radius: 8px; font-size: 12.5px; }
.notice.err { background: color-mix(in srgb, var(--orange) 16%, var(--bg)); color: var(--orange); }
.hint { padding: 4px; text-align: center; font-size: 13px; color: var(--text-3); }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 16px; text-align: center; color: var(--text-3); }
.empty b { font-size: 15px; color: var(--text); }
.empty span { font-size: 12.5px; }
.cards { display: flex; flex-direction: column; gap: 8px; }
.card { padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-elev); cursor: pointer; }
.title-row { display: flex; align-items: flex-start; gap: 10px; }
.tile { display: grid; place-items: center; width: 34px; height: 34px; flex-shrink: 0; border-radius: 9px; background: var(--blue-soft); color: var(--blue); }
.meta { flex: 1; min-width: 0; }
.cname { display: block; font-size: 14.5px; font-weight: 650; color: var(--text); }
.cdesc { display: block; margin-top: 2px; font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { flex-shrink: 0; font-size: 11px; padding: 3px 8px; border-radius: var(--r-pill); background: var(--fill); color: var(--text-3); }
.badge.on { background: var(--blue-soft); color: var(--blue); }
.foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 12px; color: var(--text-3); }
.last { margin-left: auto; }
.act { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 9px; border: 0; border-radius: 6px; background: none; font-size: 12.5px; color: var(--text-3); }
.act.peril { color: var(--orange); }
.act:active { background: var(--fill-press); }
.scrim { position: fixed; inset: 0; z-index: 70; display: flex; align-items: flex-end; background: rgba(17, 22, 31, .36); }
.sheet { width: 100%; padding: 6px 14px calc(var(--safe-bottom) + 14px); border-radius: 22px 22px 0 0; background: var(--bg); box-shadow: var(--shadow-sheet); }
.grip { width: 38px; height: 4px; margin: 4px auto 12px; border-radius: 2px; background: var(--border-strong); }
.stitle { padding: 0 6px 10px; font-size: 14px; font-weight: 600; color: var(--text); }
.ssub { padding: 0 6px; font-size: 13px; line-height: 1.6; color: var(--text-2); }
.sacts { display: flex; gap: 8px; margin-top: 16px; }
.sacts .btn { flex: 1; }
.btn { min-height: 38px; border-radius: 8px; font-size: 13px; font-weight: 600; background: var(--fill); color: var(--text-2); }
.btn.danger { background: var(--orange); color: #fff; }
</style>
