import assert from 'node:assert/strict'
import test from 'node:test'
import { filterMarketItems } from '../src/utils/marketSearch.ts'

const items = [
  {
    id: 'context7',
    name: 'Context7',
    description: 'Fresh documentation for coding agents',
    repository: 'upstash/context7',
    author: 'Upstash',
    tags: ['Docs', 'Developer Tools'],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read local files',
    repository: 'example/filesystem',
    author: 'Example',
    tags: ['Storage'],
  },
]

test('filters market items across searchable metadata', () => {
  assert.deepEqual(filterMarketItems(items, ''), items)
  assert.deepEqual(filterMarketItems(items, '  CONTEXT  '), [items[0]])
  assert.deepEqual(filterMarketItems(items, 'coding agents'), [items[0]])
  assert.deepEqual(filterMarketItems(items, 'upstash/context7'), [items[0]])
  assert.deepEqual(filterMarketItems(items, 'developer tools'), [items[0]])
  assert.deepEqual(filterMarketItems(items, 'missing'), [])
})
