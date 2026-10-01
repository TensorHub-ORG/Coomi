import { readdirSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'

const drives = ['C:', 'D:', 'E:', 'F:', 'G:']
for (const d of drives) {
  try {
    const s = statfsSync(d + '\\')
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize
    console.log(d + '  总 ' + (total / 1024 ** 3).toFixed(1) + ' GB  可用 ' + (free / 1024 ** 3).toFixed(1) + ' GB  已用 ' + ((total - free) / 1024 ** 3).toFixed(1) + ' GB')
  } catch { /* 没有这个盘 */ }
}

function sizeOf(dir, budget = { files: 0 }) {
  let total = 0
  let stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(cur, e.name)
      try {
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) { stack.push(p); continue }
        const st = statSync(p)
        total += st.size
        budget.files += 1
      } catch { /* 跳过不可读 */ }
    }
  }
  return total
}

const root = 'G:\\'
const dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink())
const rows = []
for (const d of dirs) {
  const budget = { files: 0 }
  const size = sizeOf(join(root, d.name), budget)
  rows.push({ name: d.name, size, files: budget.files })
}
rows.sort((a, b) => b.size - a.size)
console.log('\n=== G: 顶层目录（前 25）===')
let sum = 0
for (const r of rows) sum += r.size
for (const r of rows.slice(0, 25)) {
  console.log((r.size / 1024 ** 3).toFixed(2).padStart(8) + ' GB  ' + String(r.files).padStart(8) + ' 文件  ' + r.name)
}
console.log('合计 ' + (sum / 1024 ** 3).toFixed(1) + ' GB / ' + rows.length + ' 个顶层目录')