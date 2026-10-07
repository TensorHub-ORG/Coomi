import { ref } from 'vue'

export const settingsTab = ref<'chat' | 'link' | 'app'>('chat')
export const settingsScroll = new Map<string, number>()
export const chatScroll = new Map<string, { top: number; following: boolean }>()
