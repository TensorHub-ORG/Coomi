import { splitSettled } from '../src/components/richtext/parse'
console.log('reached')
const s = 'a\n\nb\n'
console.log('len', s.length)
console.log(JSON.stringify(splitSettled(s)))
console.log('ok')
