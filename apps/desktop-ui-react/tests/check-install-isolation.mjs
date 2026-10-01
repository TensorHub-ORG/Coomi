#!/usr/bin/env node
/**
 * 并行安装的按钮状态隔离（源码级护栏，不需要浏览器/引擎）。
 *
 * 真机事故：技能中心里「正在安装」原本是**一个字符串**（只记得住最后点的那条），
 *   · 先点 A（A 转圈）→ 再点 B（state 变成 B）→ A 的按钮立刻解锁，用户以为 A 装完了；
 *   · A 请求回来时 finally 又把 state 清空 → B 的转圈也提前停掉。
 * 两条并排装的条目互相串台，看起来就是「按钮状态乱跳、不知道到底装没装上」。
 * 现在两处都改成 Set（按条记），这份断言把「别再退回单值」钉死。
 *
 * 运行：node tests/check-install-isolation.mjs
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

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const browser = read('../src/components/skills/RemoteMcpBrowser.tsx')
const skills = read('../src/views/SkillsView.tsx')

/* 远程 MCP 源浏览器：安装态必须是 Set（按 entry.key 记）。 */
ok('RemoteMcpBrowser：安装态是 ReadonlySet', /const \[installing, setInstalling\] = useState<ReadonlySet<string>>/.test(browser))
ok('RemoteMcpBrowser：卡片按钮读的是 installing.has(entry.key)', browser.includes('installing.has(entry.key)'))
ok('RemoteMcpBrowser：没有退化成 installing === entry.key', !browser.includes('installing === entry.key'))
ok('RemoteMcpBrowser：安装开始/结束成对标记', browser.includes('markInstalling(entry.key, true)') && browser.includes('markInstalling(entry.key, false)'))

/* 技能中心：装/卸/启停共用一份 busy，必须是 Set（按 id 记）。 */
ok('SkillsView：busy 是 ReadonlySet', /const \[busy, setBusy\] = useState<ReadonlySet<string>>/.test(skills))
ok('SkillsView：禁用判定走 busy.has(', skills.includes('busy.has(item.id)') && skills.includes('busy.has(e.id)') && skills.includes('busy.has(detail.id)'))
ok('SkillsView：没有退化成 busy ===', !/busy === /.test(skills))
const markCalls = (skills.match(/markBusy\(/g) ?? []).length
ok('SkillsView：四个入口都用 markBusy 成对标记（4 开始 + 4 结束）', markCalls === 8, 'markBusy(...) 调用次数 ' + markCalls)
ok('SkillsView：不再有 setBusy 清空全部这种写法', !skills.includes("setBusy('" + "')"))

if (failed) {
  console.error('\n' + failed + '/' + total + ' 条断言失败')
  process.exit(1)
}
console.log('OK  ' + total + ' 个断言通过：并行安装的按钮状态按条隔离')
