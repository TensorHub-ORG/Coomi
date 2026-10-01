const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})([^`]*)$/
const text = '第一段。\n\n```ts\nconst a = 1\n```\n\n第二段。\n'
console.log('text len', text.length, JSON.stringify(text))
let from = 0, n = 0
for (;;) {
  n++
  if (n > 20) { console.log('LOOP TOO MANY'); break }
  const nl = text.indexOf('\n', from)
  const lineEnd = nl === -1 ? text.length : nl
  const raw = text.slice(from, lineEnd)
  console.log('iter', n, 'from', from, 'lineEnd', lineEnd, 'raw', JSON.stringify(raw), 'fence', JSON.stringify(FENCE_LINE.exec(raw)))
  if (lineEnd === -1) break
  from = lineEnd + 1
}
console.log('done', n)
