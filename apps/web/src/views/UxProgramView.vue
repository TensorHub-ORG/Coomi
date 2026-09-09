<script setup lang="ts">
/**
 * 用户体验改进计划页（#/ux-program）。
 * 本地画像优先：生成 → 查看（只读）→ 用户自主决定是否加入计划（允许上传）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { goBack } from '@/bridge/navigation'
import { useUxProgramStore } from '@/stores/uxProgram'
import { useConfigStore } from '@/stores/config'

const router = useRouter()
const ux = useUxProgramStore()
const config = useConfigStore()
const generating = ref(false)
const generateError = ref('')
/** 加入计划：需先勾选同意（计划名是可点开的超文本） */
const agreed = ref(false)
const showPlan = ref(false)
/** 退出问询：选项或自定义原因 */
const showExit = ref(false)
const exitCustom = ref('')
const EXIT_OPTIONS = ['我不想被收集信息', '收集信息过于详细了', '单纯想退出']

const modelReady = computed(() => Boolean(config.currentProviderId && config.currentModel))
const canGenerate = computed(() => modelReady.value && !ux.busy && !generating.value)
/** 手动更新 24h 冷却。 */
const updateCooldown = computed(() => {
  if (!ux.lastGeneratedAt) return false
  return Date.now() - new Date(ux.lastGeneratedAt).getTime() < 24 * 3600 * 1000
})

async function generate() {
  if (!canGenerate.value) return
  generating.value = true
  generateError.value = ''
  const result = await ux.generate()
  generating.value = false
  if (!result.ok) generateError.value = result.error ?? '启动失败'
}

function shortTime(value?: string): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function levelLabel(level?: string): string {
  return level === 'high' ? '高频' : level === 'medium' ? '中频' : '低频'
}

async function exitPlan(reason: string) {
  await ux.setConsent('local_only', reason)
  showExit.value = false
  exitCustom.value = ''
  agreed.value = false
}

onMounted(() => { void ux.refresh() })
</script>

<template>
  <div class="page">
    <PageHead title="用户体验改进计划" @back="goBack(router, 'dashboard')" />

    <main class="body">
      <!-- 生成中横幅 -->
      <div v-if="ux.busy" class="banner running">
        <CoomiIcon name="refresh" :size="15" class="spin" />
        <span>本次凝练正在后台执行，您可以正常进行会话。完成后画像会自动展示在这里。</span>
      </div>

      <!-- 未生成 -->
      <template v-if="!ux.hasProfile && !ux.busy">
        <section class="card intro">
          <h2>TensorHub 邀请您加入《用户体验改进计划》</h2>
          <p class="intro-lead">
            Agent 会对您近 30 天的会话做一次<b>本地脱敏凝练</b>，生成属于您的使用偏好画像：
          </p>
          <ul>
            <li><b>使用场景偏好</b> —— 按大类与小类细致归类（编程开发、系统运维、文档写作、数据处理……），每类标注使用频率与典型示例</li>
            <li><b>具体任务偏好</b> —— 您习惯的执行方式、汇报粒度、常用配置等</li>
            <li><b>常遇到的环境问题与缺陷</b> —— 您的环境里高频踩的坑与已验证的规避方式</li>
          </ul>
          <p class="intro-note">
            画像先保存在本机、只有您能看到，先看再决定是否加入计划。密码、API Key、邮箱、手机号自动打码；凝练由您当前配置的模型完成。
          </p>
          <div v-if="!modelReady" class="hint warn-hint">请先在「模型服务」中配置模型后再生成画像。</div>
          <div v-if="generateError" class="hint error-hint">{{ generateError }}</div>
          <div v-if="ux.lastError && !generateError" class="hint error-hint">上次凝练失败：{{ ux.lastError }}</div>
          <button class="primary-btn" :disabled="!canGenerate" @click="generate">
            {{ generating ? '启动中…' : '生成我的偏好画像' }}
          </button>
        </section>
      </template>

      <!-- 画像展示（只读） -->
      <template v-else-if="ux.hasProfile && ux.profile">
        <section class="card status-card">
          <div class="status-row">
            <span class="status-label">画像生成于</span>
            <span class="status-value">{{ shortTime(ux.profile.generated_at) }}</span>
          </div>
          <div class="status-row">
            <span class="status-label">样本</span>
            <span class="status-value">
              {{ ux.profile.period?.sessions_scanned ?? 0 }} 个会话 ·
              {{ ux.profile.period?.user_messages_scanned ?? 0 }} 条消息
              <em v-if="ux.profile.sample_quality === 'thin'" class="thin-tag">样本较少，仅供参考</em>
            </span>
          </div>
          <div class="status-row">
            <span class="status-label">计划状态</span>
            <span class="status-value">
              <span v-if="ux.consent === 'joined'" class="pill joined">已加入 · 档案每周更新并上传</span>
              <span v-else-if="ux.consent === 'local_only'" class="pill local">仅保存在本机</span>
              <span v-else class="pill undecided">待您决定是否加入</span>
            </span>
          </div>
        </section>

        <!-- 场景偏好 -->
        <section class="card">
          <h3>使用场景偏好</h3>
          <div v-for="scene in ux.profile.scene_preferences ?? []" :key="scene.category" class="scene">
            <div class="scene-head">
              <span class="scene-name">{{ scene.category }}</span>
              <span class="scene-weight">约 {{ Math.round((scene.weight ?? 0) * 100) }}%</span>
            </div>
            <div class="sub-list">
              <div v-for="sub in scene.subcategories ?? []" :key="sub.name" class="sub-item">
                <span class="sub-name">{{ sub.name }}</span>
                <span class="sub-meta">
                  <i class="dot" :class="sub.level" />{{ levelLabel(sub.level) }}
                  <template v-if="sub.count"> · {{ sub.count }} 次</template>
                </span>
                <span v-if="sub.example" class="sub-example">如：{{ sub.example }}</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 任务偏好 -->
        <section v-if="ux.profile.task_preferences?.length" class="card">
          <h3>任务偏好</h3>
          <div v-for="pref in ux.profile.task_preferences" :key="pref.dimension" class="pref-row">
            <span class="pref-dim">{{ pref.dimension }}</span>
            <span class="pref-value">{{ pref.preference }}</span>
          </div>
        </section>

        <!-- 环境问题 -->
        <section v-if="ux.profile.environment_issues?.length" class="card">
          <h3>常遇到的环境问题</h3>
          <div v-for="(issue, index) in ux.profile.environment_issues" :key="index" class="issue-row">
            <span class="issue-cat">{{ issue.category }}</span>
            <div class="issue-body">
              <div>{{ issue.issue }} <em v-if="issue.frequency" class="issue-freq">×{{ issue.frequency }}</em></div>
              <div v-if="issue.workaround" class="issue-fix">规避：{{ issue.workaround }}</div>
            </div>
          </div>
        </section>

        <p class="readonly-note">画像由 Agent 自动凝练生成，仅供查看，不可修改。</p>

        <!-- 计划操作 -->
        <section class="card actions-card">
          <template v-if="ux.consent !== 'joined'">
            <label class="agree-row">
              <input v-model="agreed" type="checkbox" class="agree-check" />
              <span class="agree-text">
                我已阅读<a class="plan-link" @click.prevent="showPlan = true">《用户体验改进计划》</a>，同意每周上传脱敏档案
              </span>
            </label>
            <button class="primary-btn" :disabled="!agreed || ux.busy" @click="ux.setConsent('joined')">
              加入计划
            </button>
            <p class="consent-note">加入后：每周自动更新脱敏档案并上传，用于 TensorHub 改进产品；不含任何对话原文，可随时退出。</p>
          </template>
          <template v-else>
            <div class="joined-row">
              <CoomiIcon name="check" :size="15" />
              <span>已加入计划，档案每周自动更新并上传</span>
            </div>
            <button class="danger-btn" :disabled="ux.busy" @click="showExit = true">退出计划</button>
          </template>

          <div class="auto-row">
            <span>每周自动更新画像（消耗一次模型调用）</span>
            <button class="switch" :class="{ on: ux.autoUpdate }" @click="ux.setAutoUpdate(!ux.autoUpdate)">
              <i />
            </button>
          </div>
          <div class="auto-row">
            <span>会话页邀请提示（已加入计划后自动关闭）</span>
            <button class="switch" :class="{ on: !ux.neverAsk }" @click="ux.setNeverAsk(ux.neverAsk)">
              <i />
            </button>
          </div>
          <button class="ghost-btn" :disabled="ux.busy || updateCooldown || !modelReady" @click="generate">
            {{ ux.busy ? '凝练中…' : updateCooldown ? '今日已更新，明天可手动刷新' : '立即更新画像' }}
          </button>
        </section>
      </template>
    </main>

    <!-- 计划内容（点《用户体验改进计划》查看） -->
    <div v-if="showPlan" class="mask" @click="showPlan = false">
      <div class="sheet" @click.stop>
        <div class="sheet-head">
          <span class="sheet-title">用户体验改进计划</span>
          <button class="sheet-close" @click="showPlan = false">✕</button>
        </div>
        <div class="sheet-body">
          <p>加入计划后，Agent 会每周对你近 30 天的会话做一次<b>本地脱敏凝练</b>，生成使用画像并上传给 TensorHub，用于改进产品：</p>
          <ul>
            <li><b>上传内容</b>：场景偏好分类、任务偏好、高频环境问题——只有分类标签、频次和简短脱敏示例</li>
            <li><b>绝不包含</b>：对话原文、文件内容、密码、API Key、邮箱、手机号</li>
            <li><b>画像标识</b>：仅使用一个随机安装编号，不关联你的身份信息</li>
            <li><b>你的权利</b>：画像先存本机先看后定；可随时退出，退出后停止上传；每周更新可在计划页关闭</li>
          </ul>
          <p class="sheet-note">不加入计划也完全可以使用画像功能，它只保存在你的设备上。</p>
          <button class="primary-btn" @click="showPlan = false">我知道了</button>
        </div>
      </div>
    </div>

    <!-- 退出问询 -->
    <div v-if="showExit" class="mask" @click="showExit = false">
      <div class="sheet" @click.stop>
        <div class="sheet-head">
          <span class="sheet-title">您为什么退出计划？</span>
          <button class="sheet-close" @click="showExit = false">✕</button>
        </div>
        <div class="sheet-body">
          <button v-for="option in EXIT_OPTIONS" :key="option" class="exit-option" @click="exitPlan(option)">
            {{ option }}
          </button>
          <div class="exit-custom">
            <input v-model="exitCustom" type="text" placeholder="自定义原因（选填）" maxlength="200" />
            <button :disabled="!exitCustom.trim()" @click="exitPlan(exitCustom.trim())">提交</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; width: 100%; max-width: 720px; margin: 0 auto; padding: 4px 16px calc(var(--safe-bottom) + 28px); display: flex; flex-direction: column; gap: 12px; }
.body > * { flex-shrink: 0; }

.banner.running {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-radius: 12px;
  background: var(--blue-soft); color: var(--blue);
  font-size: 12.5px; line-height: 1.55;
}
.spin { animation: spin 1.2s linear infinite; flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }

.card {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 14px; padding: 14px 15px;
}
.card h2 { font-size: 15px; margin-bottom: 6px; }
.card h3 { font-size: 13.5px; margin-bottom: 10px; color: var(--text); }
.intro-lead { font-size: 12.5px; color: var(--text-2); margin-bottom: 8px; line-height: 1.7; }
.intro-lead b { color: var(--text); }
.intro ul { padding-left: 18px; display: flex; flex-direction: column; gap: 5px; }
.intro li { font-size: 12.5px; color: var(--text-2); line-height: 1.65; }
.intro li b { color: var(--text); }
.intro-note { margin-top: 9px; font-size: 11.5px; color: var(--text-3); line-height: 1.7; }
.hint { font-size: 12px; margin-top: 8px; }
.warn-hint { color: var(--orange); }
.error-hint { color: var(--danger); word-break: break-all; }

.primary-btn {
  width: 100%; margin-top: 12px; height: 40px;
  border: 0; border-radius: 10px; background: var(--blue); color: #fff;
  font-size: 13px; font-weight: 700; cursor: pointer;
}
.primary-btn:disabled { opacity: .55; cursor: default; }
.ghost-btn {
  width: 100%; margin-top: 8px; height: 36px;
  border: 1px solid var(--border); border-radius: 10px; background: transparent;
  color: var(--text-2); font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.ghost-btn:disabled { opacity: .5; cursor: default; }

.status-card { display: flex; flex-direction: column; gap: 6px; }
.status-row { display: flex; gap: 10px; font-size: 12.5px; }
.status-label { color: var(--text-3); min-width: 70px; flex-shrink: 0; }
.status-value { color: var(--text); min-width: 0; overflow-wrap: anywhere; }
.pill { font-size: 11.5px; font-weight: 700; padding: 1px 9px; border-radius: 20px; }
.pill.joined { background: var(--ok-soft); color: var(--ok); }
.pill.local { background: var(--fill); color: var(--text-3); }
.pill.undecided { background: var(--blue-soft); color: var(--blue); }
.thin-tag { font-style: normal; color: var(--orange); font-size: 11px; }

.scene { padding: 7px 0; border-top: 1px solid var(--border); }
.scene:first-of-type { border-top: 0; }
.scene-head { display: flex; justify-content: space-between; align-items: baseline; }
.scene-name { font-size: 13px; font-weight: 700; }
.scene-weight { font-size: 11.5px; color: var(--text-3); font-family: var(--font-mono); }
.sub-list { margin-top: 5px; display: flex; flex-direction: column; gap: 4px; }
.sub-item { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.sub-name { color: var(--text); font-weight: 600; }
.sub-meta { color: var(--text-3); display: inline-flex; align-items: center; gap: 4px; }
.dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.dot.high { background: var(--ok); }
.dot.medium { background: var(--orange); }
.dot.low { background: var(--text-3); }
.sub-example { color: var(--text-3); font-size: 11.5px; }

.pref-row { display: flex; gap: 10px; padding: 5px 0; font-size: 12.5px; align-items: baseline; }
.pref-dim { color: var(--text-3); min-width: 64px; flex-shrink: 0; }
.pref-value { color: var(--text); line-height: 1.6; }

.issue-row { display: flex; gap: 9px; padding: 6px 0; align-items: flex-start; }
.issue-cat { flex-shrink: 0; font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 20px; background: var(--warn-soft); color: var(--orange); }
.issue-body { font-size: 12.5px; color: var(--text); line-height: 1.6; min-width: 0; }
.issue-freq { font-style: normal; color: var(--text-3); font-size: 11px; }
.issue-fix { color: var(--ok); font-size: 11.5px; margin-top: 2px; }

.sensitive-note { font-size: 11.5px; color: var(--text-3); margin-bottom: 7px; }
.sensitive-list { display: flex; gap: 7px; flex-wrap: wrap; }
.sensitive-pill { font-size: 11.5px; padding: 2px 10px; border-radius: 20px; background: var(--fill); color: var(--text-2); }

/* 勾选同意行 */
.agree-row { display: flex; align-items: flex-start; gap: 9px; cursor: pointer; padding: 2px 0 4px; }
.agree-check { width: 17px; height: 17px; margin-top: 2px; flex-shrink: 0; accent-color: var(--blue); cursor: pointer; }
.agree-text { font-size: 12.5px; line-height: 1.65; color: var(--text-2); min-width: 0; overflow-wrap: anywhere; }
.plan-link { color: var(--blue); font-weight: 600; text-decoration: underline; cursor: pointer; }
.danger-btn {
  width: 100%; margin-top: 10px; height: 38px;
  border: 1px solid var(--danger); border-radius: 10px; background: transparent;
  color: var(--danger); font-size: 13px; font-weight: 700; cursor: pointer;
}
.danger-btn:disabled { opacity: .5; cursor: default; }

/* 弹层（计划内容 / 退出问询） */
.mask { position: fixed; inset: 0; z-index: 90; background: rgba(17, 22, 31, .45); display: flex; align-items: flex-end; justify-content: center; }
.sheet { width: 100%; max-width: 560px; max-height: 82vh; overflow-y: auto; -webkit-overflow-scrolling: touch; background: var(--bg-card); border-radius: 18px 18px 0 0; padding: 16px 16px calc(20px + var(--safe-bottom)); }
.sheet-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.sheet-title { font-size: 15px; font-weight: 700; }
.sheet-close { border: 0; background: var(--fill); color: var(--text-3); font-size: 13px; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; }
.sheet-body p { font-size: 12.5px; line-height: 1.75; color: var(--text-2); margin-bottom: 8px; }
.sheet-body b { color: var(--text); }
.sheet-body ul { padding-left: 18px; display: flex; flex-direction: column; gap: 5px; margin-bottom: 8px; }
.sheet-body li { font-size: 12.5px; line-height: 1.7; color: var(--text-2); }
.sheet-note { font-size: 11.5px; color: var(--text-3); }
.exit-option {
  width: 100%; margin-bottom: 8px; height: 42px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg);
  color: var(--text); font-size: 13px; cursor: pointer;
}
.exit-option:active { background: var(--fill); }
.exit-custom { display: flex; gap: 8px; margin-top: 10px; }
.exit-custom input {
  flex: 1; min-width: 0; height: 40px; padding: 0 12px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg); color: var(--text); font-size: 13px; outline: none;
}
.exit-custom input:focus { border-color: var(--blue); }
.exit-custom button {
  flex-shrink: 0; height: 40px; padding: 0 18px;
  border: 0; border-radius: 10px; background: var(--danger); color: #fff;
  font-size: 13px; font-weight: 700; cursor: pointer;
}
.exit-custom button:disabled { opacity: .5; cursor: default; }
.readonly-note { font-size: 11px; color: var(--text-3); text-align: center; }

.actions-card { display: flex; flex-direction: column; }
.actions-card .primary-btn { margin-top: 2px; }
.consent-note { margin-top: 8px; font-size: 11px; color: var(--text-3); line-height: 1.7; }
.joined-row { display: flex; align-items: center; gap: 7px; color: var(--ok); font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.auto-row {
  display: flex; justify-content: space-between; align-items: center; gap: 10px;
  margin-top: 12px; font-size: 12.5px; color: var(--text-2);
}
.switch {
  width: 42px; height: 24px; border-radius: 12px; border: 0; position: relative;
  background: var(--fill-strong, #c9cfdd); cursor: pointer; transition: background .18s; flex-shrink: 0;
}
.switch i { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .18s; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
.switch.on { background: var(--blue); }
.switch.on i { left: 20px; }
</style>
