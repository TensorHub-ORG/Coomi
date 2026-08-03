<script setup lang="ts">
/**
 * 提问弹层（AskUserQuestion）。选项优先，自由输入兜底。
 */
import { ref } from 'vue'
import type { QuestionCard } from '@/stores/viewModel'
import CoomiIcon from './CoomiIcon.vue'

defineProps<{ card: QuestionCard }>()
const emit = defineEmits<{ answer: [text: string] }>()

const custom = ref('')
function submitCustom() {
  const t = custom.value.trim()
  if (t) emit('answer', t)
}
</script>

<template>
  <div class="scrim">
    <div class="sheet">
      <div class="grip" />

      <div class="qhead">
        <p class="question">{{ card.question }}</p>
        <button class="skip" @click="emit('answer', '')">跳过</button>
      </div>

      <div v-if="card.options?.length" class="options">
        <button
          v-for="(opt, i) in card.options"
          :key="opt"
          class="opt cascade"
          :style="{ animationDelay: 30 * i + 'ms' }"
          @click="emit('answer', opt)"
        >
          <span>{{ opt }}</span>
          <CoomiIcon name="chevronRight" :size="14" />
        </button>
      </div>

      <div v-if="card.allowFreeText" class="free">
        <input
          v-model="custom"
          class="finput"
          :placeholder="card.options?.length ? '或者自己写一个答案…' : '输入你的回答…'"
          enterkeyhint="send"
          @keydown.enter="submitCustom"
        />
        <button class="send" :disabled="!custom.trim()" aria-label="发送" @click="submitCustom">
          <CoomiIcon name="arrowUp" :size="18" />
        </button>
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

.qhead { display: flex; align-items: center; gap: 10px; }
.question { flex: 1; min-width: 0; word-break: break-word; font-size: 15.5px; font-weight: 600; line-height: 1.5; color: var(--text); }
.skip {
  flex-shrink: 0; padding: 5px 12px;
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--fill); font-size: 12.5px; color: var(--text-3);
  transition: background .14s, color .14s, border-color .14s;
}
.skip:active { background: var(--danger-soft); border-color: var(--danger-border); color: var(--danger); }

.options { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.opt {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  width: 100%; min-height: 48px; padding: 11px 13px;
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); text-align: left;
  font-size: 14px; line-height: 1.5; color: var(--text);
  transition: transform .06s, background .14s, border-color .14s;
}
.opt :deep(svg) { flex-shrink: 0; color: var(--text-3); }
.opt:active {
  background: var(--blue-soft); border-color: var(--blue-border);
  color: var(--blue); transform: scale(.99);
}
.opt:active :deep(svg) { color: var(--blue); }

.free { display: flex; align-items: flex-end; gap: 8px; margin-top: 12px; }
.finput {
  flex: 1; min-width: 0; min-height: 46px; padding: 0 15px;
  border: 1.5px solid var(--border); border-radius: var(--r-pill);
  background: var(--fill); font-size: 14.5px; color: var(--text);
  transition: background .14s, border-color .14s;
}
.finput::placeholder { color: var(--text-3); }
.finput:focus { background: var(--bg); border-color: var(--blue-border); outline: none; }

.send {
  display: grid; place-items: center; flex-shrink: 0;
  width: 46px; height: 46px; border: 0; border-radius: 50%;
  background: var(--blue); color: #fff;
  transition: transform .06s, background .14s;
}
.send:disabled { background: var(--fill-strong); color: var(--text-3); pointer-events: none; }
.send:active { background: var(--blue-press); transform: scale(.94); }
</style>

