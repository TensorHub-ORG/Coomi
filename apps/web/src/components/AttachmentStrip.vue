<script setup lang="ts">
import type { ChatAttachment } from '@/utils/attachments'
import { engineToken } from '@/bridge/http'
import CoomiIcon from './CoomiIcon.vue'

const props = withDefaults(defineProps<{ items: ChatAttachment[]; removable?: boolean }>(), { removable: false })
const emit = defineEmits<{ remove: [path: string] }>()

function previewSrc(path: string): string {
  return `/api/fs/raw?path=${encodeURIComponent(path)}&token=${encodeURIComponent(engineToken())}`
}

function open(item: ChatAttachment) {
  if (props.removable) return
  if (window.CoomiAndroid?.openFile) window.CoomiAndroid.openFile(item.path)
  else window.open(previewSrc(item.path), '_blank', 'noopener')
}
</script>

<template>
  <div class="attachment-strip" :class="{ removable }" aria-label="已选附件">
    <button v-for="item in items" :key="item.path" type="button" class="attachment-chip" :class="item.kind" :title="item.path" @click="open(item)">
      <img v-if="item.kind === 'image'" :src="previewSrc(item.path)" :alt="item.name" loading="lazy" decoding="async" />
      <span v-else class="file-icon"><CoomiIcon name="fileRead" :size="15" /></span>
      <span class="attachment-name">{{ item.name }}</span>
      <span v-if="removable" class="remove" role="button" :aria-label="`移除 ${item.name}`" @click.stop="emit('remove', item.path)">
        <CoomiIcon name="close" :size="12" />
      </span>
    </button>
  </div>
</template>

<style scoped>
.attachment-strip { display:flex; flex-wrap:wrap; gap:7px; max-width:100%; }
.attachment-chip { display:flex; align-items:center; gap:7px; min-width:0; max-width:min(220px,100%); height:38px; padding:4px 8px 4px 5px; border:1px solid var(--border); border-radius:11px; background:color-mix(in srgb,var(--fill) 72%,var(--bg)); color:var(--text-2); text-align:left; }
.attachment-chip:active { background:var(--fill-press); }
.attachment-chip img,.file-icon { width:28px; height:28px; flex:0 0 28px; border-radius:7px; }
.attachment-chip img { display:block; object-fit:cover; background:var(--fill-strong); }
.file-icon { display:grid; place-items:center; color:var(--blue); background:var(--blue-soft); }
.attachment-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
.remove { display:grid; place-items:center; flex:0 0 22px; width:22px; height:22px; margin-left:-1px; border-radius:50%; color:var(--text-3); }
.remove:active { background:var(--border); color:var(--text); }
</style>
