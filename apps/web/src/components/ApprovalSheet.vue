<script setup lang="ts">
/**
 * 授权弹层。破坏性操作必须先勾确认，勾之前「允许」是禁用的 ——
 * 手机上误触成本太高，这一层摩擦是故意留的。
 */
import { computed, ref } from 'vue'
import type { ToolCard } from '@/stores/viewModel'
import type { ApprovalDecision } from '@/protocol/commands'
import { asText, toolMeta, toolTarget } from '@/utils/toolMeta'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ card: ToolCard }>()
const emit = defineEmits<{ decide: [decision: ApprovalDecision] }>()

const confirmed = ref(false)
const isDestructive = computed(() => props.card.access === 'destructive')
const meta = computed(() => toolMeta(props.card.toolName))
const target = computed(() => toolTarget(props.card.arguments))

const accessMeta = computed(() => {
  switch (props.card.access) {
    case 'read_only': return { label: '只读', cls: 'read' }
    case 'write': return { label: '写入', cls: 'write' }
    case 'destructive': return { label: '破坏性', cls: 'destructive' }
    default: return { label: '', cls: '' }
  }
})

const detail = computed(() => {
  const a = props.card.arguments ?? {}
  if (typeof a.command === 'string') return a.command
  const rows = Object.entries(a).map(([k, v]) => `${k}: ${asText(v)}`)
  return rows.join('\n')
})
</script>

<template>
  <div class="scrim" @click.self="emit('decide', 'deny')">
    <div class="sheet">
      <div class="grip" />

      <div class="head">
        <span class="title">需要你的授权</span>
        <span v-if="accessMeta.label" class="access" :class="accessMeta.cls">{{ accessMeta.label }}</span>
      </div>

      <div class="tool">
        <span class="tile" :class="{ danger: isDestructive }"><CoomiIcon :name="meta.icon" :size="18" /></span>
        <span class="tinfo">
          <span class="verb">{{ meta.verb }}</span>
          <code v-if="target" class="target">{{ target }}</code>
        </span>
      </div>

      <p v-if="card.riskSummary" class="risk">
        <CoomiIcon name="alert" :size="15" /><span>{{ card.riskSummary }}</span>
      </p>

      <pre class="mono">{{ detail }}</pre>

      <label v-if="isDestructive" class="confirm">
        <input v-model="confirmed" type="checkbox" />
        <span>我已了解这是<b>不可恢复</b>的操作</span>
      </label>

      <div class="actions">
        <button class="act ghost" @click="emit('decide', 'deny')">拒绝</button>
        <button class="act soft" :disabled="isDestructive && !confirmed" @click="emit('decide', 'always')">始终允许</button>
        <button class="act primary" :class="{ danger: isDestructive }" :disabled="isDestructive && !confirmed" @click="emit('decide', 'allow')">允许一次</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed; inset: 0; z-index: 70;
  display: flex; align-items: flex-end;
  background: rgba(17, 22, 31, .36);
  animation: fade .18s ease-out;
}
@keyframes fade { from { opacity: 0; } }

.sheet {
  width: 100%; padding: 6px 16px calc(var(--safe-bottom) + 16px);
  border-radius: 22px 22px 0 0; background: var(--bg);
  box-shadow: var(--shadow-sheet);
  animation: rise .26s cubic-bezier(.2, .8, .2, 1);
}
@keyframes rise { from { transform: translateY(100%); } }

.grip { width: 38px; height: 4px; margin: 4px auto 14px; border-radius: 2px; background: var(--border-strong); }

.head { display: flex; align-items: center; justify-content: space-between; }
.title { font-size: 17px; font-weight: 650; color: var(--text); }
.access {
  padding: 4px 11px; border-radius: var(--r-pill);
  background: var(--fill-strong); color: var(--text-2);
  font-size: 11.5px; font-weight: 650;
}
.access.write { background: var(--orange-soft); color: var(--orange); }
.access.destructive { background: var(--danger); color: #fff; }

.tool { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.tile {
  display: grid; place-items: center; flex-shrink: 0;
  width: 34px; height: 34px; border-radius: 10px;
  background: var(--blue-soft); color: var(--blue);
}
.tile.danger { background: var(--danger-soft); color: var(--danger); }
.tinfo { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.verb { font-size: 14.5px; font-weight: 600; color: var(--text); }
.target {
  font-family: var(--font-mono); font-size: 11.8px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.risk {
  display: flex; align-items: flex-start; gap: 7px; margin-top: 12px;
  padding: 9px 12px; border-radius: var(--r-md);
  background: var(--orange-soft); color: #8a4a30;
  font-size: 13px; line-height: 1.55;
}
.risk :deep(svg) { flex-shrink: 0; margin-top: 1px; color: var(--orange); }

.mono {
  max-height: 30vh; margin-top: 12px; padding: 11px 12px;
  border-radius: var(--r-md); background: var(--code-bg);
  font-family: var(--font-mono); font-size: 12px; line-height: 1.6;
  color: var(--code-text); white-space: pre-wrap; word-break: break-word;
  overflow: auto;
}

.confirm {
  display: flex; align-items: center; gap: 9px; margin-top: 12px;
  padding: 11px 13px; border-radius: var(--r-md);
  background: var(--danger-soft); font-size: 13px; color: var(--text);
}
.confirm input { flex-shrink: 0; width: 18px; height: 18px; accent-color: var(--danger); }
.confirm b { color: var(--danger); }

.actions { display: flex; gap: 8px; margin-top: 14px; }
.act {
  flex: 1; min-height: 46px; padding: 0 8px;
  border: 0; border-radius: var(--r-md);
  font-size: 13.5px; font-weight: 600;
  transition: transform .06s;
}
.act.ghost { background: var(--fill); color: var(--text-2); }
.act.soft { background: var(--blue-soft); color: var(--blue); }
.act.primary { background: var(--blue); color: #fff; }
.act.primary.danger { background: var(--danger); }
.act:disabled { opacity: .4; pointer-events: none; }
.act:active { transform: scale(.98); }
</style>

