<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

export interface ThemeSelectOption {
  value: string
  label: string
  note?: string
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: ThemeSelectOption[]
  title?: string
  ariaLabel?: string
  disabled?: boolean
}>(), {
  title: '选择选项',
  ariaLabel: '选择选项',
  disabled: false,
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const open = ref(false)
const overlayId = `theme-select:${Math.random().toString(36).slice(2)}`
const selected = computed(() => props.options.find(option => option.value === props.modelValue))

function show() {
  if (props.disabled) return
  open.value = true
  registerOverlay(overlayId, close)
}

function close() {
  unregisterOverlay(overlayId)
  open.value = false
}

function choose(value: string) {
  emit('update:modelValue', value)
  close()
}

onBeforeUnmount(close)
</script>

<template>
  <button type="button" class="select-trigger" :disabled="disabled" :aria-label="ariaLabel" @click="show">
    <span>{{ selected?.label || modelValue || '请选择' }}</span>
    <CoomiIcon name="chevronDown" :size="14" />
  </button>
  <Teleport to="body">
    <div v-if="open" class="select-mask" @click.self="close">
      <section class="select-sheet" role="dialog" aria-modal="true" :aria-label="title">
        <div class="grip" />
        <header>
          <h2>{{ title }}</h2>
          <button type="button" class="icon-btn" aria-label="关闭" @click="close"><CoomiIcon name="close" :size="18" /></button>
        </header>
        <div class="option-list">
          <button
            v-for="option in options"
            :key="option.value"
            type="button"
            class="option-row"
            :class="{ selected: option.value === modelValue }"
            @click="choose(option.value)"
          >
            <span><strong>{{ option.label }}</strong><small v-if="option.note">{{ option.note }}</small></span>
            <i class="radio"><i /></i>
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.select-trigger { display:flex; align-items:center; justify-content:space-between; gap:6px; width:100%; min-width:0; min-height:30px; padding:0 8px; border:1px solid var(--border); border-radius:5px; background:var(--bg); color:var(--text-2); font-size:11px; text-align:left; }
.select-trigger > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.select-trigger:disabled { opacity:.45; }
.select-mask { position:fixed; inset:0; z-index:110; display:flex; align-items:flex-end; background:color-mix(in srgb, var(--text) 42%, transparent); }
.select-sheet { width:100%; max-height:min(72vh, 600px); padding:7px 14px calc(var(--safe-bottom) + 14px); border-radius:20px 20px 0 0; background:var(--bg); color:var(--text); box-shadow:var(--shadow-sheet); }
.grip { width:38px; height:4px; margin:3px auto 10px; border-radius:2px; background:var(--border-strong); }
header { display:flex; align-items:center; justify-content:space-between; min-height:42px; }
h2 { font-size:16px; }
.option-list { max-height:calc(min(72vh, 600px) - 70px); overflow-y:auto; border:1px solid var(--border); border-radius:8px; background:var(--bg); }
.option-row { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; min-height:52px; padding:9px 13px; text-align:left; }
.option-row + .option-row { border-top:1px solid var(--border); }
.option-row:active { background:var(--fill); }
.option-row > span { display:flex; min-width:0; flex-direction:column; }
.option-row strong { overflow-wrap:anywhere; color:var(--text); font-size:13.5px; font-weight:550; }
.option-row small { margin-top:1px; color:var(--text-3); font-size:11px; line-height:1.4; }
.radio { display:grid; place-items:center; flex:0 0 20px; width:20px; height:20px; border:2px solid var(--border-strong); border-radius:50%; }
.selected .radio { border-color:var(--blue); }
.selected .radio i { width:10px; height:10px; border-radius:50%; background:var(--blue); }
</style>
