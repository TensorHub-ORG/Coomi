const path = 'G:/DSH/coomi-full-project/apps/desktop-ui-react/.smoke-build/probe3.cjs'
const fs = require('fs')
let src = fs.readFileSync(path, 'utf8')
src = src.replace('    prevIndented = indentOf(raw) >= 4;', '    if (n++ > 6) { console.log("TRACE from", from, "lineEnd", lineEnd, "raw", JSON.stringify(raw)); if (n > 12) break }\n    prevIndented = indentOf(raw) >= 4;')
src = src.replace('function splitSettled(text) {', 'function splitSettled(text) {\n  let n = 0;')
fs.writeFileSync(path + '.dbg.cjs', src)
console.log('patched')
