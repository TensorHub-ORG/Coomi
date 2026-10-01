#!/usr/bin/env node
/**
 * 「消息行不许开 content-visibility」的回归断言。
 *
 * 现场（2026-09-27 真机取证）：base.css 给 [data-msg-index] 开了 content-visibility:auto，
 * 浏览器把**落在视口里**的消息行判成「与用户无关」而跳过绘制 ——
 *   一条用户消息：可见重叠 96px（高度真实 96px，不是 160px 占位），
 *   checkVisibility({contentVisibilityAuto:true}) 依然返回 false（＝没画）。
 * 用户看到的就是「我发的消息会消失」，切视图/重挂后才恢复。
 * 这条断言从源码层面拦住它被重新加回来：消息行必须参与布局与绘制。
 *
 * 运行：node tests/check-msg-visibility.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failed = 0
let total = 0
function check(name, got, want) {
  total += 1
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed += 1
    console.error('FAIL ' + name + '\n  want=' + JSON.stringify(want) + '\n  got =' + JSON.stringify(got))
  }
}

const dir = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(dir, '../src/styles/base.css'), 'utf8')

/** 逐条 CSS 规则解析出「选择器 → 声明块」。 */
function rules(source) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  // 声明块里的注释也要剥掉：注释里会写「为什么不许动 opacity」，那不是违规。
  while ((m = re.exec(source))) {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
    out.push({ selector: strip(m[1]).trim(), body: strip(m[2]) })
  }
  return out
}

const all = rules(css)
const msgRows = all.filter((r) => r.selector.includes('[data-msg-index]'))
check('· 存在针对消息行的规则（选择器没被改名/删掉）', msgRows.length > 0, true)
const withCv = msgRows.filter((r) => /content-visibility\s*:\s*(auto|hidden)/.test(r.body))
check('· 消息行不得使用 content-visibility（会整行不绘制）', withCv.map((r) => r.selector), [])

// 卡片也不能用：卡片本来就长在消息行里，一样会被判成离屏而整块不画。
const cards = all.filter((r) => r.selector.includes('[data-card]') || r.selector.includes('.card-lift'))
const cardsCv = cards.filter((r) => /content-visibility\s*:\s*(auto|hidden)/.test(r.body))
check('· 卡片同样不得使用 content-visibility', cardsCv.map((r) => r.selector), [])

/* 内联样式里也不许出现 contentVisibility（TSX 里的长列表隔离是同一个坑）。 */
import { readdirSync, statSync } from 'node:fs'
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (/\.(tsx|ts|css)$/.test(name)) out.push(full)
  }
  return out
}
const offenders = []
for (const file of walk(path.join(dir, '../src'))) {
  // 先把注释整段剥掉：注释里会解释「为什么不许用」，那不是违规。
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  for (const line of text.split('\n')) {
    if (/contentVisibility\s*:/.test(line) && !/contentVisibility\s*:\s*('|`)?(visible|initial)/.test(line)) {
      offenders.push(path.relative(path.join(dir, '..'), file) + ': ' + line.trim().slice(0, 80))
    }
    if (/content-visibility\s*:\s*(auto|hidden)/.test(line)) {
      offenders.push(path.relative(path.join(dir, '..'), file) + ': ' + line.trim().slice(0, 80))
    }
  }
}
check('· 全仓没有把内容渲染隔离加回消息/列表行', offenders, [])

/* 消息内容的入场动画不许动 opacity：打断后停在半路 = 发淡 / 看不见。 */
const mdStart = css.match(/@starting-style\s*\{[^@]*?\.md-body[^{]*\{([^}]*)\}/)
check('· .md-body 段落的 @starting-style 不得含 opacity', mdStart ? /opacity/.test(mdStart[1]) : false, false)
const mdRule = all.find((r) => r.selector.includes('.md-body > :where('))
check('· .md-body 段落的 transition 不得含 opacity', mdRule ? /opacity/.test(mdRule.body) : true, false)
const msgEnter = all.find((r) => r.selector.includes('.msg-enter'))
check('· .msg-enter 只用纯位移关键帧（rise-y）', msgEnter ? /rise-y/.test(msgEnter.body) : true, true)

const listSrc = readFileSync(path.join(dir, '../src/components/chat/MessageList.tsx'), 'utf8')
const rise = listSrc.match(/function riseProps[\s\S]*?\n\}/)
check('· riseProps 入场不得含 opacity', rise ? /opacity/.test(rise[0]) : true, false)
const pop = listSrc.match(/function Pop\([\s\S]*?\n\}/)
check('· Pop 弹一下不得含 opacity', pop ? /opacity/.test(pop[0]) : true, false)

if (failed === 0) {
  console.log('OK  ' + total + ' 条断言全部通过（消息行 / 卡片都参与布局与绘制，不会被跳过渲染）')
} else {
  console.error('FAIL ' + failed + '/' + total + ' 条断言失败')
  process.exit(1)
}
