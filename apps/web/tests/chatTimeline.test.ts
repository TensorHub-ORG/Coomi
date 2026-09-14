import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  MAX_TRANSCRIPT_ITEMS,
  buildTimelineBlocks,
  parseTranscript,
  transcriptTail,
} from '../src/utils/chatTimeline.ts'
import type { Timelineitem, ToolCard } from '../src/stores/viewModel.ts'

function tool(callId: string, images?: string[]): ToolCard {
  return {
    kind: 'tool',
    callId,
    toolName: 'show_image',
    arguments: { path: `/tmp/${callId}.png` },
    status: 'success',
    images,
  }
}

test('groups consecutive tool cards without losing stable timeline keys', () => {
  const items: Timelineitem[] = [
    { kind: 'user', id: 'u1', content: 'start' },
    tool('t1'),
    tool('t2'),
    { kind: 'assistant', id: 'a1', content: 'done', streaming: false },
    tool('t3'),
  ]

  const blocks = buildTimelineBlocks(items)
  assert.deepEqual(blocks.map(block => block.key), ['user:u1', 'g:t1', 'assistant:a1', 'g:t3'])
  assert.equal(blocks[1].t, 'tools')
  assert.deepEqual(blocks[1].t === 'tools' ? blocks[1].cards.map(card => card.callId) : [], ['t1', 't2'])
  assert.equal(blocks[3].t === 'tools' ? blocks[3].cards[0] : null, items[4])
})

test('reuses unchanged timeline blocks across polling recomputations', () => {
  const items: Timelineitem[] = [
    { kind: 'assistant', id: 'a-stable', content: 'unchanged', streaming: false },
    tool('t-stable-1'),
    tool('t-stable-2'),
  ]
  const first = buildTimelineBlocks(items)
  const second = buildTimelineBlocks(items)
  assert.equal(second[0], first[0])
  assert.equal(second[1], first[1])
  assert.equal(second[1].t === 'tools' ? second[1].cards : null,
    first[1].t === 'tools' ? first[1].cards : null)
})

test('builds a 5,000-item variable-height timeline without truncating content', () => {
  const longMarkdown = `${'# Long response\n\n'}${'| cell | value |\n|---|---|\n'.repeat(2_000)}END_MARKER`
  const image = 'data:image/png;base64,iVBORw0KGgo='
  const items: Timelineitem[] = Array.from({ length: 4_997 }, (_, index) => index % 2 === 0
    ? { kind: 'user', id: `m${index}`, content: `message ${index}` }
    : { kind: 'assistant', id: `m${index}`, content: `message ${index}`, streaming: false })
  items.push({ kind: 'assistant', id: 'long', content: longMarkdown, streaming: false })
  items.push(tool('image-1', [image]))
  items.push(tool('image-2', [image]))

  const blocks = buildTimelineBlocks(items)
  assert.equal(items.length, 5_000)
  assert.equal(blocks.length, 4_999)
  const markdownBlock = blocks[4_997]
  assert.equal(
    markdownBlock.t === 'one' && markdownBlock.item.kind === 'assistant'
      ? markdownBlock.item.content
      : '',
    longMarkdown,
  )
  const finalBlock = blocks.at(-1)
  assert.deepEqual(
    finalBlock?.t === 'tools' ? finalBlock.cards.flatMap(card => card.images ?? []) : [],
    [image, image],
  )
})

test('session fallback persistence keeps the newest bounded transcript intact', () => {
  const items: Timelineitem[] = Array.from({ length: 1_200 }, (_, index) => ({
    kind: 'assistant',
    id: `a${index}`,
    content: index === 1_199 ? `${'large markdown\n'.repeat(3_000)}LAST` : `message ${index}`,
    streaming: false,
  }))

  const tail = transcriptTail(items)
  assert.equal(tail.length, MAX_TRANSCRIPT_ITEMS)
  assert.equal('id' in tail[0] ? tail[0].id : '', 'a800')
  const last = tail.at(-1)
  assert.match(last?.kind === 'assistant' ? last.content : '', /LAST$/)
  assert.deepEqual(parseTranscript(JSON.stringify(tail)), tail)
  assert.deepEqual(parseTranscript('{broken'), [])
  assert.deepEqual(transcriptTail(items, 0), [])
})

test('chat templates retain dynamic measurement and lazy image contracts', async () => {
  const chat = await readFile(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')
  const toolCard = await readFile(new URL('../src/components/ToolCardItem.vue', import.meta.url), 'utf8')
  const fileInline = await readFile(new URL('../src/components/FileInline.vue', import.meta.url), 'utf8')

  assert.match(chat, /<DynamicScroller\b/)
  assert.match(chat, /<DynamicScrollerItem\b/)
  assert.match(chat, /key-field="key"/)
  assert.match(chat, /:size-dependencies=/)
  assert.match(chat, /ResizeObserver/)
  assert.match(toolCard, /loading="lazy"\s+decoding="async"/)
  assert.match(fileInline, /loading="lazy"\s+decoding="async"/)
  assert.match(toolCard, /card\.manualOpen/)
})

test('message actions use a theme-neutral transparent surface', async () => {
  const bubble = await readFile(new URL('../src/components/MessageBubble.vue', import.meta.url), 'utf8')
  const actions = bubble.match(/\.acts\s*\{([\s\S]*?)\}/)?.[1] ?? ''
  assert.match(actions, /background:\s*transparent/)
  assert.doesNotMatch(actions, /background:\s*var\(--fill\)/)
})

test('reasoning disclosure does not replay a root entrance animation', async () => {
  const reasoning = await readFile(new URL('../src/components/ReasoningBlock.vue', import.meta.url), 'utf8')
  const chat = await readFile(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(reasoning, /class="reasoning fade-in"/)
  assert.match(reasoning, /<div v-show="block\.expanded" class="body"/)
  assert.match(chat, /!\['assistant', 'reasoning'\]\.includes\(b\.item\.kind\)/)
})

test('usage scroll container reaches the orbit card edge', async () => {
  const tools = await readFile(new URL('../src/components/ContextTools.vue', import.meta.url), 'utf8')
  const usageRule = tools.match(/\.card-content :deep\(\.usage-details\)\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.match(usageRule, /width:\s*100%/)
  assert.match(usageRule, /padding:\s*0/)
  assert.doesNotMatch(usageRule, /margin-inline/)
})
