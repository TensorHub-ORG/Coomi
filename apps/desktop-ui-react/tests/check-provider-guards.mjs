#!/usr/bin/env node
/**
 * 「添加厂商」HTTP 400 事故的护栏（2026-09-29）。
 *
 * 现象：重装 rc30 后新建厂商 → 提示 HTTP 400。
 * 根因：向导下拉的 UI 值（openai / anthropic / gemini / custom）被**原样**当成接口类型发给引擎，
 *       而引擎 upsert_provider 只认四个规范名（openai_compatible / openai_responses /
 *       anthropic_messages / gemini_native）→ 必然 400 "unsupported provider compatibility mode"。
 *       同一入口还有两条：模型上下文窗口 < 32000 → 400；固定 activate=true 但没填 Key → 400。
 *
 * 这份断言把「UI 值 == 引擎白名单」「越界夹紧」「本机地址免 Key」「错误可读」「留现场」钉住。
 * 运行：node tests/check-provider-guards.mjs
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
const wizard = read('../src/components/settings/ProviderWizard.tsx')
const engine = read('../../coomi-rs/ui/src/web/mod.rs')
const shellDiag = read('../../desktop/src/diagnostics.rs')
const shellMain = read('../../desktop/src/main.rs')

/* ── ① UI 的接口类型必须与引擎白名单逐字一致 ── */
const uiTypes = [...wizard.matchAll(/\{ value: '([a-z_]+)', label: '[^']+' \}/g)].map((m) => m[1])
const engineTypes = ['openai_compatible', 'openai_responses', 'anthropic_messages', 'gemini_native']
ok('向导的接口类型 = 引擎白名单（顺序也一致）', JSON.stringify(uiTypes) === JSON.stringify(engineTypes),
  'UI=' + JSON.stringify(uiTypes) + ' 引擎=' + JSON.stringify(engineTypes))
for (const type of engineTypes) {
  ok('引擎白名单里有 ' + type, engine.includes('"' + type + '"'))
}
ok('向导不再存在 openai/custom 这类非法值', !/'openai', label|'custom', label/.test(wizard))
ok('老配置回填会被归一（normalizeEngineType）', wizard.includes('function normalizeEngineType') && wizard.includes('setType(normalizeEngineType(editing.type))'))
ok('新建默认值就是规范名', wizard.includes("useState('openai_compatible')"))

/* ── ② 上下文窗口：区间提示 + 保存时夹紧 ── */
ok('区间常量与引擎同口径', wizard.includes('const CONTEXT_MIN = 32_000') && wizard.includes('const CONTEXT_MAX = 1_048_576'))
ok('越界时就地提示', wizard.includes('contextOutOfRange') && wizard.includes('区间 32000~1048576'))
ok('保存时按区间夹紧并如实提示', wizard.includes('Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, Math.round(ctx)))') && wizard.includes('adjusted'))

/* ── ③ 本机地址免 Key（两侧同判据） ── */
ok('前端有 loopback 判据', wizard.includes('function isLoopbackBase'))
ok('有 Key 或本机地址才自动激活', wizard.includes('const wantActivate = !!apiKey.trim() || isLoopbackBase(baseUrl)'))
ok('引擎侧放行本机地址', engine.includes('fn is_loopback_base_url') && engine.includes('&& !is_loopback_base_url(&provider.base_url)'))
ok('引擎有对应单测', /loopback_base_urls_are_recognized/.test(engine))

/* ── ④ 错误可读 ── */
ok('三条英文错误都有中文解释', wizard.includes('unsupported provider compatibility mode') && wizard.includes('model context window must be between') && wizard.includes('provider must have an API key before activation'))
ok('失败时走 explainProviderError', wizard.includes("setError('保存失败：' + explainProviderError(raw))"))

/* ── ⑥ 厂商标识：向导必须发 id；引擎也要能兜底派生（2026-09-29 第二层 400） ── */
ok('向导总是发送 id（不再是 editing?.id）', wizard.includes('id: currentId,') && !wizard.includes('id: editing?.id,'))
ok('前端有 slug / 避重 / 生成三个函数',
  wizard.includes('function slugifyProviderId') && wizard.includes('function uniqueProviderId') && wizard.includes('function providerIdFor'))
ok('中文名有回退（provider-<时间>）', wizard.includes("'provider-' + String(Date.now()).slice(-6)"))
ok('编辑态沿用原 id', wizard.includes('editing?.id ?? providerIdFor('))
ok('界面上显示标识（只读）', wizard.includes("label='标识（自动生成）'") && wizard.includes('readOnly'))
ok('提交前一次列全所有问题', wizard.includes('const problems: string[] = []') && wizard.includes("setError('还不能保存：' + blocking.join('；'))"))
ok('id 相关错误文案不再指向「厂商名称」输入框', !wizard.includes('厂商标识为空：请填写厂商名称后重试') && wizard.includes('厂商标识没生成出来'))
ok('失败现场带上 hasId', wizard.includes('hasId: !!currentId'))
ok('设置页把已有 id 交给向导', read('../src/views/SettingsView.tsx').includes('existingIds={providerIds}'))

ok('引擎能从名称派生 id', engine.includes('fn derive_provider_id(') && engine.includes('fn provider_id_slug('))
ok('引擎派生也有单测', engine.includes('provider_ids_are_derived_from_names'))
ok('引擎在响应里回传最终 id', engine.includes('Ok(Json(json!({ "ok": true, "id": id })))'))
ok('引擎不再直接以 bad_request 拦 id', !engine.includes('ApiError::bad_request("provider id is required")'))

/* ── ⑤ 留现场（诊断文件里能看到） ── */
ok('向导失败时记一条现场', wizard.includes("ipc('frontend_note'"))
// 现场记录里只写「有没有 Key」，不写 Key 本身
//（预览端点确实会把 Key 发给引擎，那是发给引擎的，不属于这一条的范围）。
const noteBlock = wizard.slice(wizard.indexOf("ipc('frontend_note'"), wizard.indexOf("ipc('frontend_note'") + 700)
ok('现场里不写 Key 本身', wizard.includes('hasKey: !!apiKey.trim()') && !/apiKey:/.test(noteBlock))
ok('壳有 frontend_note 命令', shellDiag.includes('pub fn frontend_note(') && shellMain.includes('diagnostics::frontend_note'))
ok('诊断文本带上失败记录', shellDiag.includes('前端操作失败记录'))

if (failed) {
  console.error('\n' + failed + '/' + total + ' 条断言失败')
  process.exit(1)
}
console.log('OK  ' + total + ' 个断言通过：添加厂商 400 的三条根因 + 可读错误 + 现场留痕')
