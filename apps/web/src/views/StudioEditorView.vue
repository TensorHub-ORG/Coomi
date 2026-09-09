<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { useStudioStore, type StudioMember, type ToolPermission } from '@/stores/studio'
import { useConfigStore } from '@/stores/config'
import { goBack } from '@/bridge/navigation'

const router = useRouter()
const route = useRoute()
const studio = useStudioStore()
const config = useConfigStore()

const isNew = computed(() => route.name === 'studio-new')
const studioId = computed(() => route.params.id as string | undefined)

const name = ref('')
const description = ref('')
const sharedDir = ref('')
const hostId = ref('')
const members = ref<StudioMember[]>([])
const saving = ref(false)
const message = ref('')
const error = ref('')

const providerOptions = computed(() =>
  config.providers.filter(p => p.hasKey && p.models.length > 0).map(p => ({ value: p.id, label: p.name }))
)

const modelOptions = (providerId: string) =>
  config.providers.find(p => p.id === providerId)?.models.map(m => ({ value: m, label: m })) ?? []

watch(() => studio.currentStudio, (s) => {
  if (!s) return
  name.value = s.name
  description.value = s.description ?? ''
  sharedDir.value = s.sharedDir ?? ''
  hostId.value = s.hostId ?? ''
  members.value = s.members.map(m => ({ ...m }))
}, { immediate: true })

onMounted(async () => {
  if (isNew.value) return
  if (studioId.value) {
    await studio.fetchStudio(studioId.value)
    await studio.fetchWorkItems()
  }
})

function addMember() {
  if (members.value.length >= 12) return
  const id = `member-${Date.now().toString(36)}-${members.value.length + 1}`
  const provider = config.providers.find(p => p.hasKey && p.models.length > 0)
  members.value.push({
    id,
    name: `成员 ${members.value.length + 1}`,
    providerId: provider?.id ?? '',
    model: provider?.models[0] ?? '',
    role: '',
    systemPrompt: '',
    toolPermission: 'ask',
    status: 'idle',
  })
  if (!hostId.value) hostId.value = id
}

function removeMember(id: string) {
  members.value = members.value.filter(m => m.id !== id)
  if (hostId.value === id) hostId.value = members.value[0]?.id ?? ''
}

function setHost(id: string) { hostId.value = id }

async function save() {
  if (!name.value.trim()) { error.value = '请输入工作室名称'; return }
  if (members.value.length < 2) { error.value = '至少需要 2 个成员'; return }
  if (!hostId.value) { error.value = '请选择主持人'; return }
  saving.value = true
  error.value = ''
  try {
    if (isNew.value) {
      const now = Date.now()
      const created = await studio.createStudio({
        id: '', name: name.value.trim(),
        description: description.value.trim() || undefined,
        sharedDir: sharedDir.value.trim(),
        hostId: hostId.value,
        members: members.value.map(m => ({ ...m })),
        createdAt: now, updatedAt: now,
      })
      if (!created) { error.value = studio.error || '创建失败'; return }
      router.replace(`/studio/${encodeURIComponent(created.id)}/chat`)
    } else if (studioId.value) {
      const current = studio.currentStudio
      if (!current) { error.value = '工作室未加载'; return }
      await studio.updateStudio(studioId.value, {
        ...current,
        name: name.value.trim(),
        description: description.value.trim() || undefined,
        sharedDir: sharedDir.value.trim(),
        hostId: hostId.value,
        members: members.value.map(m => ({ ...m })),
        updatedAt: Date.now(),
      })
      message.value = '已保存'
      setTimeout(() => { message.value = '' }, 1500)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHead :title="isNew ? '新建工作室' : '编辑工作室'" @back="goBack(router, 'dashboard')" />

    <main class="body">
      <p v-if="message" class="notice ok">{{ message }}</p>
      <p v-if="error" class="notice err">{{ error }}</p>

      <section class="group">
        <p class="sec-label">基本信息</p>
        <label class="field"><span>名称</span><input v-model="name" placeholder="工作室名称" /></label>
        <label class="field"><span>说明</span><input v-model="description" placeholder="工作室说明（可选）" /></label>
        <label class="field"><span>共享目录</span><input v-model="sharedDir" placeholder="工作目录（可选）" /></label>
      </section>

      <section class="group">
        <div class="group-head">
          <p class="sec-label">成员 ({{ members.length }})</p>
          <button v-if="members.length < 12" class="add-btn" @click="addMember"><CoomiIcon name="plus" :size="14" />添加成员</button>
        </div>

        <div v-for="m in members" :key="m.id" class="member-card">
          <div class="member-head">
            <input v-model="m.name" class="member-name" placeholder="成员名称" />
            <label class="host-radio"><input type="radio" name="host" :checked="hostId === m.id" @change="setHost(m.id)" />主持人</label>
            <button class="icon-btn" @click="removeMember(m.id)"><CoomiIcon name="trash" :size="15" /></button>
          </div>
          <div class="member-grid">
            <label><span>提供商</span>
              <select v-model="m.providerId" @change="m.model = modelOptions(m.providerId)[0]?.value ?? ''">
                <option v-for="p in providerOptions" :key="p.value" :value="p.value">{{ p.label }}</option>
              </select>
            </label>
            <label><span>模型</span>
              <select v-model="m.model">
                <option v-for="o in modelOptions(m.providerId)" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>
          </div>
          <label class="field"><span>职责</span><input v-model="m.role" placeholder="成员职责描述" /></label>
          <label class="field"><span>系统提示词</span><textarea v-model="m.systemPrompt" rows="2" placeholder="自定义系统提示词（可选）" /></label>
          <label class="field"><span>工具权限</span>
            <select v-model="m.toolPermission">
              <option value="ask">询问</option>
              <option value="auto">自动</option>
              <option value="full">完全放行</option>
            </select>
          </label>
        </div>
      </section>

      <button class="save-btn" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存工作室' }}</button>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); min-width: 0; }
.notice { margin: 0 0 10px; padding: 8px 12px; border-radius: 8px; font-size: 12.5px; }
.notice.ok { background: var(--ok-soft); color: var(--ok); }
.notice.err { background: color-mix(in srgb, var(--orange) 16%, var(--bg)); color: var(--orange); }
.group { margin-bottom: 12px; overflow: hidden; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); padding: 12px; }
.sec-label { margin: 0 0 8px; font-size: 12px; font-weight: 650; color: var(--text-2); }
.group-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.group-head .sec-label { margin-bottom: 0; }
.add-btn { display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 10px; border: 0; border-radius: 6px; background: var(--blue-soft); color: var(--blue); font-size: 12px; font-weight: 600; }
.field { display: block; margin-bottom: 10px; }
.field > span { display: block; font-size: 11px; color: var(--text-3); margin-bottom: 4px; }
.field input, .field textarea, .field select { width: 100%; min-height: 36px; padding: 0 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--fill); color: var(--text); font-size: 12px; }
.field textarea { padding: 8px 10px; resize: vertical; }
.member-card { padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elev); margin-bottom: 8px; }
.member-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.member-name { flex: 1; min-width: 0; height: 32px; padding: 0 8px; border: 1px solid var(--border); border-radius: 5px; background: var(--fill); color: var(--text); font-size: 12px; font-weight: 600; }
.host-radio { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-2); white-space: nowrap; }
.icon-btn { display: grid; place-items: center; width: 30px; height: 30px; border: 0; background: none; color: var(--text-3); }
.member-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.member-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 10px; color: var(--text-3); }
.member-grid select { height: 32px; padding: 0 6px; border: 1px solid var(--border); border-radius: 5px; background: var(--fill); color: var(--text); font-size: 11px; }
.save-btn { width: 100%; min-height: 42px; border: 0; border-radius: 8px; background: var(--blue); color: #fff; font-size: 13px; font-weight: 600; }
.save-btn:disabled { opacity: .5; }
</style>
