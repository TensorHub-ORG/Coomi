#!/usr/bin/env node
/**
 * 会话检索打分对拍脚本（前端侧）。
 * 与 apps/web/src/stores/sessions.ts 的 scoreSession 保持逐行一致（含 id 匹配）；
 * 与 apps/coomi-rs/ui/src/terminal_ui/mod.rs 的 session_search_score 共用
 * 同目录 session_search_cases.json 语料。任一侧改动打分逻辑必须同步此处并重跑：
 *   node apps/coomi-rs/ui/tests/check_session_search.mjs
 */
import { readFileSync } from 'node:fs'

const corpus = JSON.parse(
  readFileSync(new URL('./session_search_cases.json', import.meta.url), 'utf8'),
)

/** 与 web/src/stores/sessions.ts scoreSession 一致（改动需同步）。 */
function scoreSession(m, terms) {
  const hay = (s) => (s ?? '').toLowerCase()
  const title = hay(m.title)
  const summary = hay(m.summary)
  const preview = hay(m.preview)
  const model = hay(m.model)
  const id = hay(m.id)
  const compactTitle = title.replace(/\s+/g, '')
  const compactSummary = summary.replace(/\s+/g, '')
  const compactPreview = preview.replace(/\s+/g, '')
  const count = (s, t) => s.split(t).length - 1
  return terms.reduce((acc, t) => {
    let s = 0
    const th = count(title, t)
    const sh = count(summary, t)
    const ph = count(preview, t)
    if (th > 0) s += th * 5
    else s += count(compactTitle, t) * 2
    if (sh > 0) s += sh * 3
    else s += count(compactSummary, t)
    if (ph > 0) s += ph
    else s += count(compactPreview, t)
    if (model.includes(t)) s += 1
    if (id.includes(t)) s += 1
    return acc + s
  }, 0)
}

/** 与 web/src/stores/sessions.ts filtered 的分词一致。 */
function termsOf(query) {
  return query.trim().toLowerCase().match(/[\p{L}\p{N}_+.#-]{2,}/gu) ?? []
}

let failures = 0
let total = 0
for (const { query, sessions } of corpus.cases) {
  const terms = termsOf(query)
  for (const [i, session] of sessions.entries()) {
    total += 1
    const got = scoreSession(session, terms)
    if (got !== session.expect) {
      failures += 1
      console.error(
        `FAIL query=${JSON.stringify(query)} #${i} title=${JSON.stringify(session.title)} ` +
          `expect=${session.expect} got=${got}`,
      )
    }
  }
}
if (failures === 0) {
  console.log(`OK  ${total} 个对拍断言全部通过（query 分词 + scoreSession 打分）`)
} else {
  console.error(`FAIL ${failures}/${total} 个断言失败`)
  process.exit(1)
}
