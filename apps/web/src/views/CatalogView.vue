<script setup lang="ts">
/**
 * SKILL / MCP 管理（控制台入口）。
 * 数据来自引擎 /api/catalog；安装走 /api/catalog/{mcp,skills}/install。
 * 交互：点击「安装」→ 弹出确认（名称/描述/来源/生效方式）→ MCP 再填参数，Skill 直接安装。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { authedFetch } from '@/bridge/http'

const router = useRouter()

/** 解析引擎响应：兼容空 body（旧引擎进程对未知路由返回 404 空体），错误带可读信息。 */
async function parseRes(res: Response): Promise<any> {
  const text = await res.text()
  let data: any = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!res.ok) {
    const detail = data.error ?? data.message ?? ''
    throw new Error(detail || `HTTP ${res.status}${text ? '' : '（引擎响应为空，可能版本过旧，请重启应用）'}`)
  }
  return data
}

type Tab = 'mcp' | 'skills'
const tab = ref<Tab>('mcp')

interface RequiredParam { key: string; label: string; secret?: boolean }
interface McpItem {
  id: string; name: string; description: string; transport: string
  required_parameters: RequiredParam[]; installed: boolean; enabled: boolean
}
interface SkillItem { id: string; name: string; description: string; repository: string; installed: boolean; enabled: boolean }

const mcp = ref<McpItem[]>([])
const skills = ref<SkillItem[]>([])
const loading = ref(true)
const error = ref('')
const busy = ref<string | null>(null)
const notice = ref('')

// ── 安装确认（所有安装必须先确认，不能点击即装）──
const askMcp = ref<McpItem | null>(null)
const askSkill = ref<SkillItem | null>(null)

// ── MCP 安装参数表单（按目录的 required_parameters 动态生成）──
const installingMcp = ref<McpItem | null>(null)
const installValues = ref<Record<string, string>>({})

/** 必填参数是否都已填写（未填完不允许安装，避免 500）。 */
const installReady = computed(() => {
  const item = installingMcp.value
  if (!item) return false
  return item.required_parameters.every(
    p => (installValues.value[p.key] ?? '').trim().length > 0,
  )
})

function confirmMcpInstall(item: McpItem) {
  askMcp.value = item
}

function proceedMcp() {
  const item = askMcp.value
  askMcp.value = null
  if (!item) return
  installingMcp.value = item
  installValues.value = {}
  notice.value = ''
}

function confirmSkillInstall(item: SkillItem) {
  askSkill.value = item
}

// ── 停用 / 启用（管理页卸载 = 停用可恢复；删除 = 彻底删除）──
const askDelete = ref<{ kind: 'mcp' | 'skill'; item: McpItem | SkillItem } | null>(null)

async function setEnabled(kind: 'mcp' | 'skill', item: McpItem | SkillItem, enabled: boolean) {
  busy.value = item.id
  notice.value = ''
  try {
    // 注意：引擎路由为 /api/catalog/{mcp,skills}/...（skills 是复数）
    const resource = kind === 'mcp' ? 'mcp' : 'skills'
    const res = await authedFetch(`/api/catalog/${resource}/${item.id}/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    await parseRes(res)
    // 本地乐观更新：立即反映按钮/徽标状态（不依赖后续 load 是否成功）。
    item.enabled = enabled
    notice.value = enabled
      ? `已启用${kind === 'mcp' ? ' MCP' : ' Skill'}「${item.name}」，新开会话后生效`
      : `已停用${kind === 'mcp' ? ' MCP' : ' Skill'}「${item.name}」，文件与配置已保留，可随时重新启用`
    await load()
  } catch (e) {
    notice.value = `${enabled ? '启用' : '停用'}失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = null
  }
}

function confirmDelete(kind: 'mcp' | 'skill', item: McpItem | SkillItem) {
  askDelete.value = { kind, item }
}

async function deleteItem() {
  const target = askDelete.value
  if (!target) return
  busy.value = target.item.id
  notice.value = ''
  try {
    // 注意：引擎路由为 /api/catalog/{mcp,skills}/...（skills 是复数）
    const resource = target.kind === 'mcp' ? 'mcp' : 'skills'
    const res = await authedFetch(`/api/catalog/${resource}/${target.item.id}`, { method: 'DELETE' })
    await parseRes(res)
    notice.value = `已彻底删除${target.kind === 'mcp' ? ' MCP' : ' Skill'}「${target.item.name}」`
    askDelete.value = null
    await load()
  } catch (e) {
    notice.value = `删除失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = null
  }
}

function proceedSkill() {
  const item = askSkill.value
  askSkill.value = null
  if (!item) return
  installSkill(item)
}

function closeInstallForm() {
  installingMcp.value = null
  installValues.value = {}
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await authedFetch('/api/catalog')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await parseRes(res)
    mcp.value = data.mcp ?? []
    skills.value = data.skills ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function installMcp() {
  const item = installingMcp.value
  if (!item) return
  busy.value = item.id
  notice.value = ''
  try {
    const res = await authedFetch('/api/catalog/mcp/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, values: installValues.value }),
    })
    await parseRes(res)
    notice.value = `已安装 MCP「${item.name}」，重启引擎或新开会话后生效`
    closeInstallForm()
    await load()
  } catch (e) {
    notice.value = `安装失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = null
  }
}

async function installSkill(item: SkillItem) {
  busy.value = item.id
  notice.value = ''
  try {
    const res = await authedFetch('/api/catalog/skills/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id }),
    })
    await parseRes(res)
    notice.value = `已安装 Skill「${item.name}」，重启引擎或新开会话后生效`
    await load()
  } catch (e) {
    notice.value = `安装失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = null
  }
}

onMounted(load)
// 从控制台进入：返回统一回控制台（浏览器环境回聊天主页）
function goDashboard() {
  if (window.CoomiAndroid?.openDashboard) window.CoomiAndroid.openDashboard()
  else router.push('/')
}
</script>

<template>
  <div class="page">
    <PageHead title="SKILL / MCP 管理" @back="goDashboard" />
    <main class="body">
      <div class="tabs">
        <button class="tab" :class="{ on: tab === 'mcp' }" @click="tab = 'mcp'">
          <CoomiIcon name="plug" :size="15" />MCP
          <span class="cnt">{{ mcp.length }}</span>
        </button>
        <button class="tab" :class="{ on: tab === 'skills' }" @click="tab = 'skills'">
          <CoomiIcon name="wrench" :size="15" />Skills
          <span class="cnt">{{ skills.length }}</span>
        </button>
      </div>

      <p v-if="notice" class="notice" :class="{ err: notice.startsWith('安装失败') }">{{ notice }}</p>
      <p v-if="error" class="notice err">加载失败：{{ error }}</p>
      <p v-if="loading" class="hint">加载中…</p>

      <!-- MCP -->
      <template v-if="tab === 'mcp'">
        <p v-if="!loading && mcp.length === 0" class="hint">目录为空，暂时没有可安装的 MCP Server。</p>
        <div v-else class="cards">
          <div v-for="item in mcp" :key="item.id" class="card">
            <span class="tile" :class="{ on: item.installed }">
              <CoomiIcon name="plug" :size="18" />
            </span>
            <div class="cbody">
              <div class="cline">
                <span class="cname">{{ item.name }}</span>
                <span v-if="item.installed" class="badge" :class="item.enabled ? 'ok' : 'off'">
                  {{ item.enabled ? '已启用' : '已停用' }}
                </span>
                <span v-else class="badge plain">未安装</span>
              </div>
              <p class="cdesc">{{ item.description }}</p>
              <span class="cmeta"><CoomiIcon name="link" :size="12" />{{ item.transport }}</span>
            </div>
            <template v-if="item.installed">
              <button
                class="act"
                :disabled="busy !== null"
                @click="setEnabled('mcp', item, !item.enabled)"
              >
                {{ item.enabled ? '停用' : '启用' }}
              </button>
              <button class="act danger" :disabled="busy !== null" @click="confirmDelete('mcp', item)">
                删除
              </button>
            </template>
            <button
              v-else
              class="act"
              :disabled="busy !== null"
              @click="confirmMcpInstall(item)"
            >
              {{ busy === item.id ? '安装中…' : '安装' }}
            </button>
          </div>
        </div>
      </template>

      <!-- Skills -->
      <template v-else>
        <p v-if="!loading && skills.length === 0" class="hint">目录为空，暂时没有可安装的 Skill。</p>
        <div v-else class="cards">
          <div v-for="item in skills" :key="item.id" class="card">
            <span class="tile" :class="{ on: item.installed }">
              <CoomiIcon name="wrench" :size="18" />
            </span>
            <div class="cbody">
              <div class="cline">
                <span class="cname">{{ item.name }}</span>
                <span v-if="item.installed" class="badge" :class="item.enabled ? 'ok' : 'off'">
                  {{ item.enabled ? '已启用' : '已停用' }}
                </span>
                <span v-else class="badge plain">未安装</span>
              </div>
              <p class="cdesc">{{ item.description }}</p>
              <span v-if="item.repository" class="cmeta"><CoomiIcon name="globe" :size="12" />{{ item.repository }}</span>
            </div>
            <template v-if="item.installed">
              <button
                class="act"
                :disabled="busy !== null"
                @click="setEnabled('skill', item, !item.enabled)"
              >
                {{ item.enabled ? '停用' : '启用' }}
              </button>
              <button class="act danger" :disabled="busy !== null" @click="confirmDelete('skill', item)">
                删除
              </button>
            </template>
            <button
              v-else
              class="act"
              :disabled="busy !== null"
              @click="confirmSkillInstall(item)"
            >
              {{ busy === item.id ? '安装中…' : '安装' }}
            </button>
          </div>
        </div>
      </template>

      <!-- 彻底删除确认（管理页卸载 = 停用可恢复，删除 = 彻底删除） -->
      <div v-if="askDelete" class="sheet-mask" @click.self="askDelete = null">
        <div class="sheet">
          <div class="grip" />
          <div class="stitle">
            <CoomiIcon :name="askDelete.kind === 'mcp' ? 'plug' : 'wrench'" :size="17" />
            彻底删除{{ askDelete.kind === 'mcp' ? ' MCP' : ' Skill' }}「{{ askDelete.item.name }}」？
          </div>
          <p class="sdesc">
            {{ askDelete.kind === 'mcp'
              ? '将从 config/mcp_servers.json 中移除该服务（不可恢复）。若只是想暂时不用，请改用「停用」。'
              : '将删除已安装的 Skill 目录与配置记录（不可恢复）。若只是想暂时不用，请改用「停用」。' }}
          </p>
          <div class="sheet-actions">
            <button class="btn ghost" @click="askDelete = null">取消</button>
            <button class="btn danger-solid" :disabled="busy !== null" @click="deleteItem">确认彻底删除</button>
          </div>
        </div>
      </div>

      <!-- MCP 安装确认 -->
      <div v-if="askMcp" class="sheet-mask" @click.self="askMcp = null">
        <div class="sheet">
          <div class="grip" />
          <div class="stitle"><CoomiIcon name="plug" :size="17" />安装 MCP「{{ askMcp.name }}」？</div>
          <p class="sdesc">{{ askMcp.description }}</p>
          <div class="sinfo">
            <span><CoomiIcon name="link" :size="13" />{{ askMcp.transport }}</span>
            <span><CoomiIcon name="folder" :size="13" />写入 config/mcp_servers.json</span>
            <span><CoomiIcon name="refresh" :size="13" />重启引擎或新开会话后生效</span>
          </div>
          <div class="sheet-actions">
            <button class="btn ghost" @click="askMcp = null">取消</button>
            <button class="btn primary" @click="proceedMcp">继续配置</button>
          </div>
        </div>
      </div>

      <!-- Skill 安装确认 -->
      <div v-if="askSkill" class="sheet-mask" @click.self="askSkill = null">
        <div class="sheet">
          <div class="grip" />
          <div class="stitle"><CoomiIcon name="wrench" :size="17" />安装 Skill「{{ askSkill.name }}」？</div>
          <p class="sdesc">{{ askSkill.description }}</p>
          <div class="sinfo">
            <span v-if="askSkill.repository"><CoomiIcon name="globe" :size="13" />{{ askSkill.repository }}</span>
            <span><CoomiIcon name="folder" :size="13" />安装到 skills 目录</span>
            <span><CoomiIcon name="refresh" :size="13" />重启引擎或新开会话后生效</span>
          </div>
          <div class="sheet-actions">
            <button class="btn ghost" @click="askSkill = null">取消</button>
            <button class="btn primary" :disabled="busy !== null" @click="proceedSkill">
              {{ busy === askSkill.id ? '安装中…' : '确认安装' }}
            </button>
          </div>
        </div>
      </div>

      <!-- MCP 安装参数表单 -->
      <div v-if="installingMcp" class="sheet-mask" @click.self="closeInstallForm">
        <div class="sheet">
          <div class="grip" />
          <div class="stitle">配置 {{ installingMcp.name }}</div>
          <p class="sdesc">{{ installingMcp.description }}</p>
          <label v-for="p in installingMcp.required_parameters" :key="p.key" class="field">
            <span>{{ p.label }}<em v-if="!p.secret" class="req">必填</em></span>
            <input
              v-model="installValues[p.key]"
              :type="p.secret ? 'password' : 'text'"
              :placeholder="p.key"
              autocomplete="off"
            />
          </label>
          <p v-if="installingMcp.required_parameters.length === 0" class="sdesc">该 MCP 无需额外配置，直接安装即可。</p>
          <div class="sheet-actions">
            <button class="btn ghost" @click="closeInstallForm">取消</button>
            <button class="btn primary" :disabled="busy !== null || !installReady" @click="installMcp">
              {{ busy === installingMcp.id ? '安装中…' : installReady ? '安装' : '请填写必填项' }}
            </button>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 14px 12px calc(var(--safe-bottom) + 24px);
  -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain;
}
.tabs { display: flex; gap: 8px; margin-bottom: 14px; }
.tab {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 42px; border-radius: var(--r-md);
  background: var(--fill-strong); color: var(--text-2);
  font-size: 14px; font-weight: 550;
}
.tab.on { background: var(--blue-soft); color: var(--blue); }
.cnt {
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--r-pill);
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--fill); font-size: 11px; font-weight: 650;
}
.tab.on .cnt { background: var(--blue); color: #fff; }

.notice {
  margin: 0 0 12px; padding: 10px 12px; border-radius: var(--r-md);
  background: var(--fill); font-size: 13px; line-height: 1.6; color: var(--text);
}
.notice.err { background: var(--danger-soft, #ffeceb); color: var(--danger, #d43d2e); }
.hint { margin: 18px 0; text-align: center; font-size: 13px; color: var(--text-3); }

.cards { display: flex; flex-direction: column; gap: 10px; }
.card {
  display: flex; align-items: center; gap: 12px;
  padding: 12px; border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-1);
}
.tile {
  flex-shrink: 0; width: 40px; height: 40px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  background: var(--fill-strong); color: var(--text-2);
}
.tile.on { background: var(--blue-soft); color: var(--blue); }
.cbody { flex: 1; min-width: 0; }
.cline { display: flex; align-items: center; gap: 6px; }
.cname { font-size: 14.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge {
  flex-shrink: 0; padding: 1.5px 8px; border-radius: var(--r-pill);
  font-size: 10.5px; font-weight: 650;
}
.badge.ok { background: var(--ok-soft, #e6f4ea); color: var(--ok, #2e9e5b); }
.badge.off { background: var(--fill); color: var(--text-2); }
.badge.plain { background: var(--fill); color: var(--text-3); }
.cdesc {
  margin: 3px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--text-2);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.cmeta {
  display: inline-flex; align-items: center; gap: 4px; margin-top: 5px;
  font-size: 11px; color: var(--text-3);
}
.act {
  flex-shrink: 0; min-width: 62px; height: 34px; padding: 0 14px; border-radius: var(--r-pill);
  background: var(--blue); color: #fff; font-size: 13px; font-weight: 600;
}
.act:active { opacity: 0.85; }
.act:disabled { opacity: 0.5; }
.act.danger { background: var(--danger-soft); color: var(--danger); }
.done { flex-shrink: 0; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--ok-soft, #e6f4ea); color: var(--ok, #2e9e5b); }

/* ── 弹层 ── */
.sheet-mask {
  position: fixed; inset: 0; z-index: 90;
  display: flex; align-items: flex-end; justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  padding: 12px;
}
.sheet {
  width: 100%; max-width: 460px; padding: 10px 18px 18px;
  border-radius: var(--r-card); background: var(--bg);
  box-shadow: var(--shadow-2);
}
.grip { width: 36px; height: 4px; margin: 0 auto 12px; border-radius: 2px; background: var(--fill-strong); }
.stitle {
  display: flex; align-items: center; gap: 8px;
  font-size: 15.5px; font-weight: 650; color: var(--text);
}
.sdesc { margin: 8px 0 0; font-size: 12.5px; line-height: 1.65; color: var(--text-2); }
.sinfo {
  display: flex; flex-direction: column; gap: 6px; margin-top: 12px;
  padding: 10px 12px; border-radius: var(--r-md); background: var(--fill);
  font-size: 12px; color: var(--text-2);
}
.sinfo span { display: flex; align-items: center; gap: 6px; }
.field { display: flex; flex-direction: column; gap: 5px; margin-top: 12px; font-size: 12.5px; color: var(--text-2); }
.req { margin-left: 5px; padding: 0 5px; border-radius: 4px; background: var(--blue-soft); color: var(--blue); font-style: normal; font-size: 10px; font-weight: 650; }
.field input {
  height: 42px; padding: 0 12px; border-radius: var(--r-md); border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text); font-size: 15px;
}
.sheet-actions { display: flex; gap: 10px; margin-top: 18px; }
.sheet-actions .btn { flex: 1; }
.btn { min-height: 42px; border-radius: var(--r-md); font-size: 14.5px; font-weight: 600; }
.btn.primary { background: var(--blue); color: #fff; }
.btn.ghost { background: var(--fill-strong); color: var(--text); }
.btn.danger-solid { background: var(--danger, #d43d2e); color: #fff; }
.btn:disabled { opacity: 0.6; }
</style>
