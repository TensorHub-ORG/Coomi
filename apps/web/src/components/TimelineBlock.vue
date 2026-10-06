<script setup lang="ts">
import type { TimelineBlockItem } from '@/utils/chatTimeline'
import MessageBubble from '@/components/MessageBubble.vue'
import ToolGroup from '@/components/ToolGroup.vue'
import ReasoningBlock from '@/components/ReasoningBlock.vue'
import NoticeItem from '@/components/NoticeItem.vue'

defineProps<{ block: TimelineBlockItem }>()
</script>

<template>
  <ToolGroup v-if="block.t === 'tools'" :cards="block.cards" />
  <template v-else>
    <MessageBubble
      v-if="block.item.kind === 'user' || block.item.kind === 'assistant'"
      :msg="block.item"
    />
    <ReasoningBlock v-else-if="block.item.kind === 'reasoning'" :block="block.item" />
    <NoticeItem v-else-if="block.item.kind === 'notice'" :notice="block.item" />
    <div
      v-else-if="block.item.kind === 'question' && block.item.answered"
      class="q-answered cascade"
    >
      <span class="q-label">已回答</span>
      {{ Object.values(block.item.answers ?? {}).filter(Boolean).join('；') || '已跳过' }}
    </div>
  </template>
</template>

<style scoped>
.q-answered {
  align-self: flex-end;
  max-width: 84%;
  padding: 7px 13px;
  border-radius: var(--r-pill);
  background: var(--fill);
  color: var(--text-2);
  font-size: 12.5px;
}
.q-label { color: var(--blue); font-weight: 600; }
</style>
