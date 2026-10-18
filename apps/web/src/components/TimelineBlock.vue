<script setup lang="ts">
import type { TimelineBlockItem } from '@/utils/chatTimeline'
import TimelineEntry from './TimelineEntry.vue'
import ProcessBlock from './ProcessBlock.vue'
defineProps<{ block: TimelineBlockItem }>()
</script>
<template>
  <ProcessBlock v-if="block.t === 'process'" :block="block" />
  <TimelineEntry v-else :block="block" />
</template>
