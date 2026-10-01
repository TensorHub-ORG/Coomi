import { splitSettled } from '../src/components/richtext/parse'
const F = '```'
for (let i = 0; i < 3; i++) {
  console.log('iter', i)
  const r = splitSettled('第一段。\n\n' + F + 'ts\nconst a = 1\n' + F + '\n\n第二段。\n')
  console.log('done', i, r.settled.length, r.tail.length)
}
console.log('all done')
