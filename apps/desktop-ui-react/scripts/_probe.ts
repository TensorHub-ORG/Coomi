import { chunkSettled, scanFenceBlocks, splitSettled } from '../src/components/richtext/parse'
const F = '```'
const cases = [
  '第一段。\n\n' + F + 'ts\nconst a = 1\n' + F + '\n\n第二段。\n',
  '前置。\n\n' + F + 'ts\nconst a = 1\n\nconst b = 2\n' + F + '\n',
  '第一段。\n\n' + F + 'ts\nconst a = 1\n',
]
for (const text of cases) {
  console.log('---', JSON.stringify(text))
  console.log('fences', JSON.stringify(scanFenceBlocks(text)))
  console.log('split', JSON.stringify(splitSettled(text)))
}
