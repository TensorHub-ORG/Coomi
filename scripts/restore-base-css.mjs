import { readFileSync, writeFileSync } from 'node:fs'

const CUR = 'G:/DSH/coomi-full-project/apps/desktop-ui-react/src/styles/base.css'
const BAK = 'G:/DSH/coomi-full-project/backups/desktop-ui-react-20261006-172620/src/styles/base.css'
const cur = readFileSync(CUR, 'utf8')
const bak = readFileSync(BAK, 'utf8')

/** 按「顶层规则组」切：深度 0 出现 `{` 的行是组起点，配平到 0 结束。
 *  纯注释/空行归到相邻组，不单独处理。 */
function groups(src) {
  const out = []
  let buf = []
  let depth = 0
  for (const line of src.split('\n')) {
    buf.push(line)
    for (const ch of line) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1 }
    if (depth === 0 && buf.length) { out.push(buf.join('\n')); buf = [] }
  }
  if (buf.length) out.push(buf.join('\n'))
  return out
}

/** 组开头的选择器列表（去掉注释、按顶层逗号切）。 */
function selectors(group) {
  const i = group.indexOf('{')
  if (i < 0) return []
  return group.slice(0, i).replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim()).filter(Boolean)
}

const norm = (s) => s.replace(/\s+/g, ' ').trim()
const curNorm = norm(cur)
const seen = new Set()
const restored = []
let out = cur

for (const g of groups(bak)) {
  const sels = selectors(g)
  if (!sels.length) continue
  // 原文还在 → 没丢，跳过（这一条同时挡住了「改过但仍在」的规则被回退）
  if (curNorm.includes(norm(g))) continue
  // 只要**任一**选择器还存在于现文件，就认为这条规则没丢（避免了 .pop-surface /
  // [data-panel][data-pane-anim] 这类「被本会话改过」的规则被备份回退掉）。
  if (sels.some((s) => cur.includes(s))) continue
  const key = sels.join(',')
  if (seen.has(key)) continue
  seen.add(key)
  restored.push(sels[0])
  out += '\n\n/* 以下规则在 2026-10-07 的 base.css 事故里被误删，此处按备份原文恢复。 */\n' + g.trim() + '\n'
}

writeFileSync(CUR, out)
console.log('restored groups: ' + restored.length)
console.log(restored.slice(0, 40).join('\n'))
