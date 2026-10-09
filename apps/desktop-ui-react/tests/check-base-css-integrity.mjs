#!/usr/bin/env node
/**
 * base.css 完整性护栏。
 *
 * 背景：2026-10-07 我误用 read 的截断结果做「读取→切片→重写」，把 base.css 中间约 97 行
 * **原始规则**删掉了（含 [data-msg-scroller] 的 overflow-anchor、[data-msg-index] 的 contain）。
 * 当时括号仍然平衡、构建也照过 —— 所以「编译通过」根本挡不住这类事故。
 * 这一组断言把「必须存在的原始规则」钉死，再出同类问题会当场红。
 * 运行：node tests/check-base-css-integrity.mjs
 */
import { readFileSync } from 'node:fs'

let failed = 0
let total = 0
function ok(name, condition, detail) {
  total += 1
  if (condition) return
  failed += 1
  console.error('FAIL ' + name + (detail === undefined ? '' : '\n  ' + detail))
}
const css = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8')

/* ① 体量下限：整段被删时最先暴露。低于这个数说明有东西没了。 */
const lines = css.split('\n').length
ok('base.css 行数不低于 1000（当前 ' + lines + '）', lines >= 1000)

/* ② 括号必须配平：结构坏了后面全是连锁故障。 */
const open = (css.match(/\{/g) || []).length
const close = (css.match(/\}/g) || []).length
ok('花括号配平（' + open + '/' + close + '）', open === close)

/* ③ 事故中丢失、且属于**原有行为**的规则——逐条钉死。 */
const MUST_HAVE = [
  ['消息滚动锚定', 'overflow-anchor: auto'],
  ['消息行布局隔离', "[data-msg-index]"],
  ['折叠冻结窗口', "[data-msg-freeze='1']"],
  ['关动效档', "[data-motion='off']"],
  ['导航轨', '[data-msg-nav-track]'],
  ['导航标记', '[data-nav-marker]'],
]
for (const [label, needle] of MUST_HAVE) {
  ok(label + ' 仍在（' + needle + '）', css.includes(needle))
}

/* ④ 本会话**故意改过**的规则：不能被「从备份恢复」这类操作回退。 */
ok('空态大标题保持 27px', css.includes('calc(27px * var(--ui-font-scale))'))
ok('面板展开过渡仍在', css.includes('transition: flex-grow var(--motion-fast)'))
ok('pop-surface 仍是 forwards', /\.pop-surface \{[^}]*forwards/.test(css))

if (failed) {
  console.error('\n' + failed + '/' + total + ' 条断言失败')
  process.exit(1)
}
console.log('OK  ' + total + ' 条断言全部通过（base.css 完整性与关键规则）')
