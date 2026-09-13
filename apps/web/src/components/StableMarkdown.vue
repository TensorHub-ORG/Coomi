<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { patchMarkdown } from '@/utils/patchMarkdown'

const props = defineProps<{ html: string }>()
const root = ref<HTMLElement | null>(null)
function update() { if (root.value) patchMarkdown(root.value, props.html) }
onMounted(update)
watch(() => props.html, update, { flush: 'post' })
</script>

<template><div ref="root" /></template>
