<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { QuestionCard } from '@/stores/viewModel'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ card: QuestionCard }>()
const emit = defineEmits<{ answer: [answers: Record<string, string>] }>()

const index = ref(0)
const answers = reactive<Record<string, string>>({})
const custom = reactive<Record<string, string>>({})
const customMode = ref(false)
const current = computed(() => props.card.questions[index.value])
const isLast = computed(() => index.value === props.card.questions.length - 1)
const currentAnswered = computed(() => {
  const question = current.value
  return !!question && !!(answers[question.id] ?? '').trim()
})

watch(() => props.card.callId, () => {
  index.value = 0
  customMode.value = false
  for (const key of Object.keys(answers)) delete answers[key]
  for (const key of Object.keys(custom)) delete custom[key]
})

function choose(value: string) {
  const question = current.value
  if (!question) return
  answers[question.id] = value
  customMode.value = false
  if (!isLast.value) index.value += 1
}

function chooseCustom() {
  customMode.value = true
}

function updateCustom() {
  const question = current.value
  if (question) answers[question.id] = (custom[question.id] ?? '').trim()
}

function previous() {
  if (index.value > 0) index.value -= 1
  customMode.value = false
}

function next() {
  if (!isLast.value) index.value += 1
}

function submit() {
  const result: Record<string, string> = {}
  for (const question of props.card.questions) result[question.id] = answers[question.id] ?? ''
  emit('answer', result)
}
</script>

<template>
  <div class="scrim">
    <div class="sheet">
      <div class="grip" />
      <div v-if="current" class="progress">
        <span>{{ current.header }}</span>
        <span>{{ index + 1 }}/{{ card.questions.length }}</span>
      </div>
      <p v-if="current" class="question">{{ current.question }}</p>

      <div v-if="current" class="options">
        <button
          v-for="option in current.options"
          :key="option.label"
          class="opt"
          :class="{ selected: answers[current.id] === option.label }"
          @click="choose(option.label)"
        >
          <span><b>{{ option.label }}</b><small>{{ option.description }}</small></span>
          <CoomiIcon v-if="answers[current.id] === option.label" name="check" :size="16" />
        </button>
        <button class="opt" :class="{ selected: customMode }" @click="chooseCustom">
          <span><b>自定义</b><small>填写其他答案</small></span>
        </button>
      </div>

      <div v-if="current && customMode" class="free">
        <input v-model="custom[current.id]" class="finput" placeholder="输入自定义答案" @input="updateCustom" />
      </div>

      <div class="actions">
        <button class="nav ghost" :disabled="index === 0" @click="previous">上一题</button>
        <button v-if="current" class="nav ghost" @click="choose('')">跳过</button>
        <button v-if="!isLast" class="nav primary" :disabled="!currentAnswered" @click="next">下一题</button>
        <button v-else class="nav primary" :disabled="!currentAnswered" @click="submit">提交全部</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; z-index: 70; display: flex; align-items: flex-end; background: rgba(17, 22, 31, .36); }
.sheet { width: 100%; max-height: 88vh; overflow-y: auto; padding: 6px 16px calc(var(--safe-bottom) + 16px); border-radius: 20px 20px 0 0; background: var(--bg); box-shadow: var(--shadow-sheet); }
.grip { width: 38px; height: 4px; margin: 4px auto 14px; border-radius: 2px; background: var(--border-strong); }
.progress { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; font-weight: 650; color: var(--blue); }
.question { margin: 8px 0 0; font-size: 15.5px; font-weight: 600; line-height: 1.55; color: var(--text); word-break: break-word; }
.options { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.opt { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 50px; padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--fill); text-align: left; color: var(--text); }
.opt.selected { border-color: var(--blue-border); background: var(--blue-soft); color: var(--blue); }
.opt span { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.opt b { font-size: 14px; font-weight: 600; }
.opt small { font-size: 11.5px; line-height: 1.4; color: var(--text-3); }
.free { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.finput { flex: 1; min-width: 0; height: 44px; padding: 0 13px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg); color: var(--text); }
.nav:disabled { opacity: .45; }
.actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }
.nav { min-height: 42px; border-radius: var(--r-md); font-size: 13.5px; font-weight: 600; }
.nav.ghost { background: var(--fill-strong); color: var(--text-2); }
.nav.primary { background: var(--blue); color: #fff; }
</style>
