#!/usr/bin/env node
/**
 * rc30 的源码级护栏（不需要浏览器 / 引擎）：把这一批「真机事故 → 根因 → 修法」
 * 钉在断言里，防止以后有人顺手改回去。
 *
 * 覆盖：
 *   · #5  生成中被收尾：error 帧不许动 streaming/runState；心跳与 session_state 必须过
 *         engineReallyIdle；engineSaysRunning 对「列表里没有这个会话」要返回 true；
 *   · #2  运行环境展开区必须能自己滚（max-h + overflow-y-auto）；
 *   · #1  DPI：窗口尺寸按显示器工作区折算（primary_monitor + max_inner_size）；
 *   · #7  流式纯文本渲染前折叠首部空行；
 *   · #3  切页保活最近 4 个视图 + library 的 ensure* TTL；
 *   · #4  吸底滚动合并到 rAF（每帧最多写一次 scrollTop）；
 *   · #10 目录安装走任务（引擎登记 + 前端轮询）、任务标题有中文名；
 *   · #11 会话列表后台轮询（多会话并行可见）；
 *   · 插件页面：路由 key、asset 宿主、壳侧路径校验、引擎接口。
 *
 * 运行：node tests/check-rc30-guards.mjs
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
const session = read('../src/stores/session.ts')
const markdown = read('../src/components/chat/Markdown.tsx')
const runtimeBar = read('../src/components/skills/RuntimeBar.tsx')
const stick = read('../src/components/chat/useStickToBottom.ts')
const app = read('../src/App.tsx')
const library = read('../src/stores/library.ts')
const settings = read('../src/views/SettingsView.tsx')
const shell = read('../../desktop/src/main.rs')
const engine = read('../../coomi-rs/ui/src/web/mod.rs')

/* ── #5：收尾路径必须过引擎权威判据 ── */
ok('#5 engineReallyIdle 存在且是唯一判据', session.includes('const engineReallyIdle = (id: string): boolean =>'))
ok('#5 心跳分支用 engineReallyIdle', /connection_heartbeat[\s\S]{0,900}engineReallyIdle\(sid\)/.test(session))
ok('#5 session_state 分支用 engineReallyIdle', /session_state[\s\S]{0,900}engineReallyIdle\(sid\)/.test(session))
ok('#5 未知会话按「还在跑」处理', /if \(!row\) return true/.test(session))
ok('#5 命令级 error 帧不再收尾这一轮', /const fatal = payload\.code === 'no_provider'/.test(session) && !/commitCritical\(\{ messages: nextMessages, streaming: false, runState: 'idle' \}\)\n          return/.test(session.split('const fatal')[0].slice(-400)))
ok('#5 收尾带原因（可诊断）', session.includes('function noteSettle(') && session.includes('settleLog: () => settleLog.slice()'))
ok('#5 send 之后刷新会话列表', (session.match(/void get\(\)\.loadSessions\(\)/g) ?? []).length >= 2)

/* ── #2 / #1 ── */
ok('#2 运行环境展开区可滚', /max-h-\[min\(48vh,420px\)\] overflow-y-auto/.test(runtimeBar))
ok('#2 状态条不被 flex 压扁', runtimeBar.includes("mt-3 shrink-0 rounded-lg border border-line bg-surface"))
ok('#1 窗口尺寸按工作区折算', shell.includes('primary_monitor()') && shell.includes('.max_inner_size(work_w, work_h)'))
ok('#1 字号缩放带动控件高度', read('../src/components/ui/Button.tsx').includes('var(--ui-font-scale)'))

/* ── #7 ── */
ok('#7 纯文本渲染折叠首部空行', markdown.includes('const body = shown.replace('))

/* ── #3 / #4 ── */
ok('#3 切页保活 4 个视图', app.includes('const LIVE_VIEWS_KEEP = 4') && app.includes('next.slice(-LIVE_VIEWS_KEEP)'))
ok('#3 技能中心挂载走 TTL', library.includes('ensureCatalog') && library.includes('VIEW_DATA_MAX_AGE_MS'))
ok('#4 吸底滚动每帧最多一次', stick.includes('scrollFrame.current = window.requestAnimationFrame(run)'))

/* ── #10 / #11 ── */
ok('#10 引擎把目录安装登记成任务', engine.includes('fn spawn_catalog_install<') && engine.includes('"catalog_install"'))
ok('#10 任务标题有中文名', engine.includes('"agent" => "对话"') && engine.includes('"catalog_install" => "工具安装"'))
ok('#10 排队轮次复用同一条任务记录', /fn begin_managed_task[\s\S]{0,900}task\.begin_turn\(id\)/.test(engine))
ok('#10 前端等待安装任务', read('../src/components/skills/installClient.ts').includes('export async function waitInstallTask'))
ok('#11 会话列表后台轮询', session.includes('function startSessionsPoll(): void'))

/* ── 插件页面（v2.1） ── */
ok('插件页 key 形如 plugin:…', read('../src/stores/pluginViews.ts').includes("'plugin:' + pluginId + ':' + id"))
ok('插件页宿主用沙箱 iframe', read('../src/components/plugins/PluginViewHost.tsx').includes("sandbox='allow-scripts allow-forms allow-popups'"))
ok('插件页只放行只读 /api/', read('../src/components/plugins/PluginViewHost.tsx').includes("if (!path.startsWith('/api/')) return false"))
ok('侧边栏渲染插件页', read('../src/components/shell/Rail.tsx').includes('pluginViews.map((v) => item(v.key, v.title'))
ok('壳侧拒绝越界 entry', shell.includes("entry.contains(\"..\")") && shell.includes('write_plugin_views'))
ok('引擎提供插件页接口', read('../../coomi-rs/ui/src/web/api/plugins.rs').includes('plugin_views_api'))

/* ── 一键更新（C3） ── */
ok('壳实现下载/校验/安装', shell.includes('fn fetch_to_file(') && shell.includes('fn sha256_file(') && shell.includes('fn install_update_sync('))
ok('下载地址套镜像前缀', shell.includes('fn github_mirror_prefix(') && shell.includes('fn download_candidates('))
ok('前端有一键更新入口', settings.includes('一键更新') && settings.includes("ipc<UpdateActionReport>('download_update'"))

if (failed) {
  console.error('\n' + failed + '/' + total + ' 条断言失败')
  process.exit(1)
}
console.log('OK  ' + total + ' 个断言通过：rc30 护栏（收尾判据 / 展开滚动 / 切页保活 / 安装任务 / 插件页面 / 一键更新）')
