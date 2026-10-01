#!/usr/bin/env node
/**
 * 右侧侧栏（RightDock）文字溢出 / 越界 / 截断巡检（无头浏览器 + CDP）。
 *
 * 与 verify-settings-width.mjs 的区别：那个脚本要求「应用已经带 --remote-debugging-port 跑着」，
 * 这里自己把 UI 构建到 %TEMP%（不碰仓库 dist），起一个静态服务并用无头 Chrome 打开，
 * 因此不需要桌面包、不需要引擎，可以直接当门禁用。
 *
 * 用法：
 *   node apps/desktop/devtools/verify-dock.js [选项]
 *
 * 选项：
 *   --widths=860,1180,1440   要巡检的视口宽度（默认这三档）
 *   --height=900             视口高度（--heights=900,620 可以一次跑多档：矮窗口专测「卡片被压扁」）
 *   --state=rich,empty,error,partial  内容形态：rich 超长真实数据 / empty 空态 /
 *                            error 全部端点失败 / partial 会话可用但产物与日志端点失败（错误态）
 *   --tabs=all               页签：all 或产物,文件,统计,上下文,任务
 *   --preview=on|off         是否额外巡检「就地预览」态（默认 on）
 *   --panel=auto|max         侧栏宽度：auto 用默认宽度，max 用拖动上限
 *   --sweep=fail|report      fail（默认）把巡检清单计入退出码；report 只看清单
 *   --json                   只打印 JSON
 *   --no-build               复用上次的临时构建（调试脚本本身时用）
 *   --keep                   保留临时目录（构建产物 + Chrome profile）
 *   --chrome=<exe>           指定浏览器；默认按 Edge → Chrome 顺序探测
 *   --debug                  命中项里附带元素宽度 / 子元素宽度，便于定位
 *   --shot=<目录>            把每个组合的面板截成 PNG 存到该目录
 *
 * 每个（内容形态 × 视口宽度 × 页签）组合各跑一遍，产出三类清单：
 *   A 内容横向溢出：scrollWidth > clientWidth + 2 且该轴不能横向滚动（overflow-x 为 auto/scroll 的记为「有意滚动」）
 *   B 越出面板边界：子元素右 / 下边界越出面板，且中间没有裁剪祖先（中间层自己会被 A 抓到，不重复报）
 *   C 被截断却没 title：truncate / line-clamp / ellipsis 且实际截断，祖先链上没有 title 兜底
 *   D 竖切（「长方形显示不全」）：元素在 Y 轴裁剪（overflow-y 非 visible）而内容更高且不能滚动
 * 退出码：巡检清单非空（--sweep=fail）或脚本级硬失败（面板没展开 / 找不到页签 / 页面加载超时）为 1。
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const HERE = __dirname
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : fallback
}
const flag = (name) => process.argv.includes('--' + name)

const UI_ROOT = path.resolve(arg('ui', path.join(HERE, '..', '..', 'desktop-ui-react')))
const WIDTHS = arg('widths', '860,1180,1440').split(',').map((n) => Number(n.trim())).filter((n) => n > 0)
const HEIGHTS = arg('heights', arg('height', '900')).split(',').map((n) => Number(n.trim())).filter((n) => n > 0)
const HEIGHT = HEIGHTS[0] || 900
const STATES = arg('state', 'rich,empty,error,partial').split(',').map((s) => s.trim()).filter(Boolean)
const TABS_ARG = arg('tabs', 'all')
const PANEL = arg('panel', 'auto') === 'max' ? 560 : 340
const SWEEP = arg('sweep', 'fail')
/** 预览态也一起巡检（PreviewPanel 的就地预览）；没有可预览条目的内容形态会跳过而不是失败。 */
const PREVIEWS = arg('preview', 'on') !== 'off'
const JSON_ONLY = flag('json')
const OUT_FILE = arg('out', '')
const NO_BUILD = flag('no-build')
const KEEP = flag('keep')
/** 调试：把每个命中的元素宽度 / 子元素宽度一起打出来（查「为什么还溢出」用）。 */
const DEBUG = flag('debug')
/** 截图目录：给了就把每个组合的面板截一张 PNG，方便人眼复核（默认不截）。 */
const SHOT_DIR = arg('shot', '')

/** 页签：label 必须和 dockShared.tsx 的 DOCK_TABS 一致，脚本靠 aria-label 点它。 */
const TABS = [
  { key: 'artifacts', label: '产物' },
  { key: 'files', label: '文件' },
  { key: 'stats', label: '统计' },
  { key: 'context', label: '上下文' },
  { key: 'tasks', label: '任务' },
]
const wantedTabs = TABS_ARG === 'all' ? TABS : TABS.filter((t) => TABS_ARG.split(',').map((s) => s.trim()).includes(t.key))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 1) 构建到 %TEMP% ────────────────────────────────────────────── */

const WORK = path.join(os.tmpdir(), 'coomi-dock-verify')
const DIST = path.join(WORK, 'dist')
const PROFILE = path.join(WORK, 'chrome-profile')

async function buildUi() {
  const require_ = createRequire(path.join(UI_ROOT, 'package.json'))
  const vite = await import(pathToFileURL(require_.resolve('vite')).href)
  const react = (await import(pathToFileURL(require_.resolve('@vitejs/plugin-react')).href)).default
  const tailwind = (await import(pathToFileURL(require_.resolve('@tailwindcss/vite')).href)).default
  const started = Date.now()
  await vite.build({
    root: UI_ROOT,
    configFile: false,
    logLevel: 'warn',
    plugins: [react(), tailwind()],
    resolve: { alias: { '@': path.join(UI_ROOT, 'src') } },
    // 产物只落在 %TEMP%：仓库里的 dist 是壳真正打包用的，绝不能被巡检覆盖。
    build: { outDir: DIST, emptyOutDir: true, target: 'chrome120' },
  })
  return Date.now() - started
}

/* ── 2) 静态服务 ─────────────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
}

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    const file = path.join(DIST, rel)
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

/* ── 3) 页面里的假引擎：真实 UI 需要的所有只读端点都返回可控数据 ────
   巡检的是布局，不是引擎：这里把 fetch 拦住给假数据，好把「超长路径 / 超长模型名 /
   大数字 / 多模型 / 长日志」这些最容易撑破侧栏的内容稳定复现出来。 */

const LONG = {
  cwd: 'G:\\DSH\\coomi-full-project\\apps\\desktop-ui-react\\src\\components\\shell\\deeply-nested-workspace-folder-with-a-very-long-name\\inner',
  home: 'C:\\Users\\Monai-Bob\\AppData\\Roaming\\com.coomi.desktop.plus\\runtime\\sessions\\20260101T120000Z-abcdef0123456789',
  model: 'anthropic/claude-sonnet-4-5-20260101-preview-extended-thinking-1m-context-beta.3',
  log: 'G:\\DSH\\coomi-full-project\\apps\\desktop-ui-react\\src\\components\\shell\\DockUsageTab.tsx',
  error: '引擎返回 HTTP 500：failed to aggregate usage ledger entries from C:\\Users\\Monai-Bob\\AppData\\Roaming\\com.coomi.desktop.plus\\usage\\ledger.jsonl (unexpected end of JSON input at line 48213)',
}

const file = (name, size, kind, modified) => ({ path: LONG.cwd + '\\' + name, name, size, modified, kind })

function richData() {
  const days = []
  const records = []
  const models = [LONG.model, 'openai/gpt-5.2-codex-high-throughput-preview-2026-01-01', 'deepseek/deepseek-v3.2-reasoner-long-context-experimental', 'local/ollama-qwen3-coder-480b-a35b-instruct-q8_0']
  for (let i = 29; i >= 0; i--) {
    const at = Date.now() - i * 86_400_000
    for (let k = 0; k < 2; k++) {
      records.push({
        timestamp_ms: at + k * 3_600_000,
        input_tokens: 123_456 + i * 1_337,
        output_tokens: 23_456 + i * 311,
        cached_input_tokens: 98_765 + i * 997,
        total_tokens: 146_912 + i * 1_648,
        elapsed_ms: 18_432 + i * 17,
        session_id: 'sess-20260101-abcdef0123456789abcdef0123456789-' + (k ? 'beta' : 'alpha'),
        model: models[(i + k) % models.length],
      })
    }
  }
  records.push({ timestamp_ms: Date.now(), input_tokens: 1, output_tokens: 1, total_tokens: 2 }) // 旧记录：没有 model / session_id
  return {
    health: {
      status: 'ok',
      version: '1.6.6-build.20260101T123456Z+f7c1a2b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9',
      cwd: LONG.cwd,
      home: LONG.home,
      runtime: 'tauri-webview2/windows-x86_64/desktop-shell-with-a-long-runtime-label',
      engine: { initialized: true, llm: LONG.model, tools: 1234 },
    },
    sessions: {
      sessions: [{
        id: 'sess-20260101-abcdef0123456789abcdef0123456789',
        title: '把右侧侧栏里的超长路径、超长模型名与大数字全部收拾干净（附带一个很长很长的标题用来挤压布局）',
        preview: '长文本挤压测试',
        cwd: LONG.cwd,
        updatedAt: Date.now(),
        createdAt: Date.now() - 86_400_000,
        running: true,
        provider_id: 'provider-openai-compatible-with-an-extremely-long-identifier',
        model: LONG.model,
      }],
    },
    sessionDetail: {
      provider_id: 'provider-openai-compatible-with-an-extremely-long-identifier',
      model: LONG.model,
      messages: [
        { id: 'm1', role: 'user', content: '请把 ' + LONG.cwd + ' 下的日志按天聚合，输出文件名要带上完整路径与时间戳：daily-token-usage-report-2026-01-01-final-v3-with-a-very-long-suffix.md' },
        {
          id: 'm2',
          role: 'assistant',
          content: '好的，我先写文件再汇总。',
          tool_calls: [
            { id: 'c1', name: 'write_file', arguments: { path: LONG.cwd + '\\reports\\daily-token-usage-report-2026-01-01-final-v3-with-a-very-long-suffix.md' } },
            { id: 'c2', name: 'edit_file', arguments: { file_path: 'G:\\DSH\\coomi-full-project\\apps\\desktop-ui-react\\src\\components\\shell\\DockUsageTab.tsx' } },
          ],
        },
        { id: 'm3', role: 'tool', content: '{"ok":true}', compaction_summary: true },
      ],
    },
    artifacts: {
      root: LONG.cwd,
      capped: true,
      artifacts: [
        file('daily-token-usage-report-2026-01-01-final-v3-with-a-very-long-suffix.md', 1_234_567, 'text', Math.floor(Date.now() / 1000)),
        file('screenshot-of-the-right-dock-panel-at-860px-wide-with-overflowing-text.png', 2_345_678, 'image', Math.floor(Date.now() / 1000) - 120),
        file('DockUsageTab.tsx', 98_765, 'code', Math.floor(Date.now() / 1000) - 640),
        file('very-long-artifact-file-name-without-any-spaces-at-all-so-it-cannot-wrap-nicely-0123456789.bin', 45_678_901, 'other', Math.floor(Date.now() / 1000) - 90_000),
      ],
    },
    context: {
      used_tokens: 1_234_567,
      context_window: 2_000_000,
      effective_context_window: 1_900_000,
      auto_compact_token_limit: 1_710_000,
      remaining_tokens: 765_433,
      used_percent: 61.7,
      remaining_percent: 38.3,
      auto_compact_scope_tokens: 1_234_567,
      compaction_count: 42,
      session_id: 'sess-20260101-abcdef0123456789abcdef0123456789',
      provider_id: 'provider-openai-compatible-with-an-extremely-long-identifier',
      model: LONG.model,
    },
    usage: {
      input_tokens: 12_345_678,
      cached_input_tokens: 9_876_543,
      output_tokens: 2_345_678,
      total_tokens: 14_691_356,
      requests: 1_234,
      records,
    },
    tasks: {
      running_count: 1,
      concurrency_limit: 3,
      tasks: [
        {
          task_id: 'task-20260101-abcdef0123456789abcdef0123456789',
          session_id: 'sess-20260101-abcdef0123456789abcdef0123456789',
          session_title: '把右侧侧栏里的超长路径、超长模型名与大数字全部收拾干净（附带一个很长很长的标题）',
          status: 'running',
          running: true,
          started_at: Math.floor(Date.now() / 1000) - 4210,
          current_tool: 'write_file(G:\\DSH\\coomi-full-project\\apps\\desktop-ui-react\\src\\components\\shell\\DockUsageTab.tsx)',
          task_kind: 'chat-turn',
          priority: 'high',
          retries: 3,
          model: LONG.model,
        },
        {
          task_id: 'task-2',
          session_id: 'sess-2',
          session_title: '短标题',
          status: 'failed',
          running: false,
          started_at: Math.floor(Date.now() / 1000) - 86_400,
          error: LONG.error,
          model: LONG.model,
        },
      ],
    },
    taskDetails: {
      task: { task_id: 'task-20260101-abcdef0123456789abcdef0123456789', status: 'running' },
      events: [
        { ts: Math.floor(Date.now() / 1000), kind: 'tool_call', tool: 'write_file', args: { path: LONG.cwd + '\\reports\\daily-token-usage-report-2026-01-01-final-v3-with-a-very-long-suffix.md' } },
        { ts: Math.floor(Date.now() / 1000) - 3, kind: 'tool_result', ok: true, output: 'wrote 1234567 bytes to ' + LONG.cwd },
      ],
      logs: { events: LONG.home + '\\logs\\events.jsonl', output: LONG.cwd + '\\logs\\task-output-with-a-very-long-name.log' },
    },
    taskLog: {
      task_id: 'task-20260101-abcdef0123456789abcdef0123456789',
      path: LONG.cwd + '\\logs\\task-output-with-a-very-long-name.log',
      truncated: true,
      lines: [
        '2026-01-01T12:00:00Z INFO  task started session=sess-20260101-abcdef0123456789abcdef0123456789 model=' + LONG.model,
        '2026-01-01T12:00:01Z DEBUG resolving workspace path ' + LONG.cwd,
        '2026-01-01T12:00:02Z ERROR failed to write ' + LONG.cwd + '\\reports\\daily-token-usage-report-2026-01-01-final-v3-with-a-very-long-suffix.md: permission denied (os error 5)',
      ],
    },
    runtimeLogs: {
      path: LONG.home + '\\logs\\engine.log',
      truncated: true,
      lines: [
        '2026-01-01T11:59:58Z INFO  engine listening on 127.0.0.1:7801 token=verify-token cwd=' + LONG.cwd,
        '2026-01-01T11:59:59Z WARN  context window 2000000 exceeds provider limit; using effective window 1900000 for model ' + LONG.model,
        '2026-01-01T12:00:00Z INFO  usage ledger aggregated from ' + LONG.home + '\\usage\\ledger.jsonl (48214 records)',
      ],
    },
    fsEntries: [
      { name: 'deeply-nested-workspace-folder-with-a-very-long-name', is_dir: true, size: 0, modified: Math.floor(Date.now() / 1000) },
      { name: 'another-extremely-long-directory-name-that-cannot-be-wrapped-anywhere', is_dir: true, size: 0, modified: Math.floor(Date.now() / 1000) },
      { name: 'daily-token-usage-report-2026-01-01-final-v3-with-a-very-long-suffix.md', is_dir: false, size: 1_234_567, modified: Math.floor(Date.now() / 1000) },
      { name: 'DockUsageTab.tsx', is_dir: false, size: 98_765, modified: Math.floor(Date.now() / 1000) },
      { name: 'a-single-file-name-without-spaces-that-is-longer-than-the-panel-width-0123456789.bin', is_dir: false, size: 45_678_901, modified: Math.floor(Date.now() / 1000) },
    ],
    preferences: {
      reasoningEffort: '极高强度思考（超长标签用于挤压测试，绝对不能在面板里被裁掉一半）',
      permissionMode: '完全放行（危险）—— 需要二次确认的超长标签',
      maxToolRounds: 999,
    },
    running: { sessions: [{ id: 'sess-20260101-abcdef0123456789abcdef0123456789' }, { id: 'sess-2' }] },
    // 就地预览的正文：一行超长无空格串 + 一行长日志，专门压预览区的横向
    rawText: [
      'export const DOCK_VERIFY = "' + 'A'.repeat(240) + '"',
      '2026-01-01T12:00:00Z INFO  ' + LONG.cwd + '\\daily-token-usage-report-2026-01-01-final-v3-with-a-very-long-suffix.md 已写入 ' + '9'.repeat(40) + ' 字节',
      'line without any spaces at all ' + 'x'.repeat(180),
    ].join('\n'),
  }
}

function emptyData() {
  const rich = richData()
  return {
    health: { status: 'ok', version: '1.6.6', cwd: rich.health.cwd, home: '', runtime: '', engine: { initialized: false, llm: null, tools: 0 } },
    sessions: { sessions: [{ id: 'sess-empty-0123456789', title: '空会话', cwd: rich.health.cwd }] },
    sessionDetail: { messages: [] },
    artifacts: { root: '', capped: false, artifacts: [] },
    context: { used_tokens: 0, context_window: 0, effective_context_window: 0, auto_compact_token_limit: 0, remaining_tokens: 0, used_percent: 0, remaining_percent: 0, auto_compact_scope_tokens: 0, compaction_count: 0, session_id: 'sess-empty-0123456789' },
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0, requests: 0, records: [] },
    tasks: { running_count: 0, concurrency_limit: 3, tasks: [] },
    taskDetails: { task: {}, events: [], logs: {} },
    taskLog: { task_id: '', path: '', truncated: false, lines: [] },
    runtimeLogs: { path: '', truncated: false, lines: [] },
    fsEntries: [],
    preferences: {},
    running: { sessions: [] },
    rawText: '',
  }
}

/** 页面里跑的假引擎：拦截 fetch + 伪造 Tauri IPC，让真实 UI 能在无头浏览器里独立启动。 */
function mockSource(state, data, panelWidth) {
  return '(function () {\n' +
    '  var STATE = ' + JSON.stringify(state) + ';\n' +
    '  var DATA = ' + JSON.stringify(data) + ';\n' +
    '  var LONG_ERROR = ' + JSON.stringify(LONG.error) + ';\n' +
    '  var PORT = 7801;\n' +
    '  try {\n' +
    '    localStorage.setItem("coomi.theme", "light");\n' +
    '    localStorage.setItem("coomi.dock.w", ' + JSON.stringify(String(panelWidth)) + ');\n' +
    '    document.documentElement.dataset.theme = "light";\n' +
    '  } catch (e) {}\n' +
    '  function json(body, status) {\n' +
    '    return new Response(JSON.stringify(body), { status: status || 200, headers: { "Content-Type": "application/json" } });\n' +
    '  }\n' +
    '  function route(pathname, search) {\n' +
    '    // 就地预览读原文：给一段带超长无空格串的文本，专门压 pre 的横向。\n' +
    '    if (pathname === "/api/fs/raw") {\n' +
    '      return new Response(DATA.rawText || "", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });\n' +
    '    }\n' +
    '    // partial：会话本身可用，但产物 / 上下文 / 用量 / 任务 / 日志端点各自失败，\n' +
    '    // 专门用来巡检各页签的错误态（错误文案通常带完整路径，最容易撑破卡片）。\n' +
    '    if (STATE === "partial") {\n' +
    '      if (pathname === "/api/runtime/logs") return json({ error: "no log file yet" }, 404);\n' +
    '      if (pathname === "/api/runtime/health") return json(DATA.health);\n' +
    '      if (pathname === "/api/sessions/running") return json(DATA.running);\n' +
    '      if (pathname === "/api/sessions") return json(DATA.sessions);\n' +
    '      if (/^\\/api\\/sessions\\/[^/]+\\/artifacts$/.test(pathname)) return json({ error: LONG_ERROR }, 500);\n' +
    '      if (/^\\/api\\/sessions\\/[^/]+\\/context$/.test(pathname)) return json({ error: "conversation not found" }, 404);\n' +
    '      if (/^\\/api\\/sessions\\/[^/]+$/.test(pathname)) return json(DATA.sessionDetail);\n' +
    '      return json({ error: LONG_ERROR }, 500);\n' +
    '    }\n' +
    '    if (STATE === "error") {\n' +
    '      if (pathname === "/api/runtime/logs") return json({ error: "no log file yet" }, 404);\n' +
    '      return json({ error: LONG_ERROR }, 500);\n' +
    '    }\n' +
    '    if (pathname === "/api/runtime/health") return json(DATA.health);\n' +
    '    if (pathname === "/api/sessions/running") return json(DATA.running);\n' +
    '    if (pathname === "/api/sessions") return json(DATA.sessions);\n' +
    '    if (/^\\/api\\/sessions\\/[^/]+\\/artifacts$/.test(pathname)) return json(DATA.artifacts);\n' +
    '    if (/^\\/api\\/sessions\\/[^/]+\\/context$/.test(pathname)) return json(DATA.context);\n' +
    '    if (/^\\/api\\/sessions\\/[^/]+$/.test(pathname)) return json(DATA.sessionDetail);\n' +
    '    if (pathname === "/api/usage") return json(DATA.usage);\n' +
    '    if (pathname === "/api/tasks") return json(DATA.tasks);\n' +
    '    if (pathname.indexOf("/api/task-details/") === 0) return json(DATA.taskDetails);\n' +
    '    if (/^\\/api\\/tasks\\/[^/]+\\/log$/.test(pathname)) return json(DATA.taskLog);\n' +
    '    if (pathname === "/api/runtime/logs") return json(DATA.runtimeLogs);\n' +
    '    if (pathname === "/api/fs/list") {\n' +
    '      var dir = "";\n' +
    '      try { dir = new URLSearchParams(search).get("path") || ""; } catch (e) {}\n' +
    '      var sep = dir.indexOf("\\\\") >= 0 ? "\\\\" : "/";\n' +
    '      var base = dir.replace(/[\\\\/]+$/, "");\n' +
    '      var entries = DATA.fsEntries.map(function (e) {\n' +
    '        var copy = {};\n' +
    '        for (var k in e) copy[k] = e[k];\n' +
    '        copy.path = base ? base + sep + e.name : e.name;\n' +
    '        return copy;\n' +
    '      });\n' +
    '      return json({ path: dir, entries: entries });\n' +
    '    }\n' +
    '    if (pathname === "/api/agent/preferences") return json(DATA.preferences);\n' +
    '    if (pathname === "/api/fs/stat") return json({ is_dir: false, size: 0, modified: 0 });\n' +
    '    return json({});\n' +
    '  }\n' +
    '  var realFetch = window.fetch ? window.fetch.bind(window) : null;\n' +
    '  window.fetch = function (input, init) {\n' +
    '    var url = typeof input === "string" ? input : (input && input.url) || "";\n' +
    '    if (url.indexOf("http://127.0.0.1:" + PORT + "/api/") === 0) {\n' +
    '      var u = new URL(url);\n' +
    '      try { return Promise.resolve(route(u.pathname, u.search)); } catch (e) { return Promise.reject(e); }\n' +
    '    }\n' +
    '    return realFetch ? realFetch(input, init) : Promise.reject(new Error("no fetch"));\n' +
    '  };\n' +
    '  window.__TAURI__ = {\n' +
    '    core: { invoke: function (cmd) {\n' +
    '      if (cmd === "engine_info") return Promise.resolve({ port: PORT, token: "verify-token" });\n' +
    '      if (cmd === "engine_log_path") return Promise.resolve(' + JSON.stringify(LONG.home + '\\logs\\engine.log') + ');\n' +
    '      return Promise.resolve(null);\n' +
    '    } },\n' +
    '  };\n' +
    '})()\n'
}

/* ── 4) 页面探测：三类清单 + 有意滚动标注 ────────────────────────── */

const PROBE = [
  '(function () {',
  '  var DEBUG = ' + (DEBUG ? 'true' : 'false') + ';',
  '  var out = { problems: [], items: [], intentional: [], numbers: {} };',
  '  var panel = document.querySelector("[data-dock-panel]");',
  '  if (!panel) { out.problems.push("找不到右侧栏面板 [data-dock-panel]（面板没挂载？）"); return out; }',
  '  var box = panel.getBoundingClientRect();',
  '  out.numbers.viewport = window.innerWidth;',
  '  out.numbers.panel = { width: Math.round(box.width), clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth, right: Math.round(box.right) };',
  '  if (box.width < 1) { out.problems.push("面板宽度为 0：右侧栏没有展开"); return out; }',
  '  var tab = panel.querySelector("[data-dock-tab]");',
  '  out.numbers.tab = tab ? tab.getAttribute("data-dock-tab") : "（无）";',
  '  if (!tab) { out.problems.push("面板里没有页签内容根节点 [data-dock-tab]"); return out; }',
  '  var tabBox = tab.getBoundingClientRect();',
  '  out.numbers.tabBox = { clientWidth: tab.clientWidth, scrollWidth: tab.scrollWidth, clientHeight: tab.clientHeight, scrollHeight: tab.scrollHeight };',
  '  if (panel.scrollWidth > panel.clientWidth + 2) out.problems.push("面板自身横向溢出：scrollWidth=" + panel.scrollWidth + " > clientWidth=" + panel.clientWidth);',
  '  function scrollable(el, axis) { var s = getComputedStyle(el); var v = axis === "x" ? s.overflowX : s.overflowY; return v === "auto" || v === "scroll"; }',
  '  function clips(el, axis) { var s = getComputedStyle(el); var v = axis === "x" ? s.overflowX : s.overflowY; return v !== "visible"; }',
  '  function clippedBy(el, axis) {',
  '    var p = el.parentElement;',
  '    while (p && p !== panel) { if (clips(p, axis)) return true; p = p.parentElement; }',
  '    return false;',
  '  }',
  '  function hasTitle(el) { return !!(el.closest && el.closest("[title]")); }',
  '  function label(el) {',
  '    var cls = String(el.className || "").replace(/\\s+/g, " ").trim().slice(0, 64);',
  '    return el.tagName.toLowerCase() + (cls ? " ." + cls : "");',
  '  }',
  '  function text(el) { return String(el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 34); }',
  '  var counts = { overflowX: 0, outOfBoundsRight: 0, outOfBoundsBottom: 0, clippedY: 0, noTitle: 0, intentional: 0, notes: {} };',
  '  function note(kind, el, over) {',
  '    counts.intentional++;',
  '    counts.notes[kind] = (counts.notes[kind] || 0) + 1;',
  '    if (out.intentional.length < 10) out.intentional.push({ kind: kind, over: over, label: label(el), text: text(el) });',
  '  }',
  '  function pushItem(kind, el, over) {',
  '    if (out.items.length >= 30) return;',
  '    var item = { kind: kind, over: over, label: label(el), text: text(el) };',
  '    if (DEBUG) {',
  '      var kids = [];',
  '      for (var k = 0; k < el.children.length && k < 4; k++) {',
  '        var c = el.children[k];',
  '        kids.push(c.tagName.toLowerCase() + " clientW=" + c.clientWidth + " scrollW=" + c.scrollWidth + " rectW=" + Math.round(c.getBoundingClientRect().width) + " cls=" + String(c.className || "").slice(0, 40));',
  '      }',
  '      var st2 = getComputedStyle(el);',
  '      item.detail = { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, rectWidth: Math.round(r.width), display: st2.display, minWidth: st2.minWidth, flex: st2.flex, wordBreak: st2.wordBreak, overflowWrap: st2.overflowWrap, whiteSpace: st2.whiteSpace, padding: st2.paddingLeft + "/" + st2.paddingRight, parentCls: String(el.parentElement && el.parentElement.className || "").slice(0, 60), parentClientW: el.parentElement ? el.parentElement.clientWidth : -1, kids: kids };',
  '    }',
  '    out.items.push(item);',
  '  }',
  '  var scanned = 0;',
  '  var all = panel.querySelectorAll("*");',
  '  for (var i = 0; i < all.length; i++) {',
  '    var el = all[i];',
  '    var st = getComputedStyle(el);',
  '    if (st.display === "none" || st.visibility === "hidden" || st.position === "fixed") continue;',
  '    var r = el.getBoundingClientRect();',
  '    if (r.width < 1 && r.height < 1) continue;',
  '    scanned++;',
  '    var overX = el.clientWidth > 0 ? el.scrollWidth - el.clientWidth : 0;',
  '    var overY = el.clientHeight > 0 ? el.scrollHeight - el.clientHeight : 0;',
  '    var canScrollX = scrollable(el, "x");',
  '    var canScrollY = scrollable(el, "y");',
  '    var cls = String(el.className || "");',
  '    // 单行省略号（truncate）与多行 clamp 是设计内的截断方式：只要给了 title 就不算问题，',
  '    // 没给 title 由下面的 noTitle 报；真正的「文字超出框」是容器自己撑破了。',
  '    var ellipsis = cls.indexOf("truncate") >= 0 || st.textOverflow === "ellipsis";',
  '    var clamp = cls.indexOf("line-clamp-") >= 0 || (st.webkitLineClamp && st.webkitLineClamp !== "none");',
  '    if (overX > 2) {',
  '      if (canScrollX) note("scrollX", el, overX);',
  '      else if (ellipsis && clips(el, "x")) note("ellipsisX", el, overX);',
  '      else { counts.overflowX++; pushItem("overflowX", el, overX); }',
  '    }',
  '    if (overY > 2) {',
  '      if (canScrollY) note("scrollY", el, overY);',
  '      else if (clamp && clips(el, "y")) note("clampY", el, overY);',
  '      else if (clips(el, "y")) { counts.clippedY++; pushItem("clippedY", el, overY); }',
  '    }',
  '    if (!clippedBy(el, "x")) {',
  '      var overR = Math.round((r.right - box.right) * 10) / 10;',
  '      if (overR > 1) {',
  '        counts.outOfBoundsRight++;',
  '        if (out.items.length < 30) out.items.push({ kind: "outOfBoundsRight", over: overR, label: label(el), text: text(el) });',
  '      }',
  '    }',
  '    if (!clippedBy(el, "y")) {',
  '      var overB = Math.round((r.bottom - box.bottom) * 10) / 10;',
  '      if (overB > 1) {',
  '        counts.outOfBoundsBottom++;',
  '        if (out.items.length < 30) out.items.push({ kind: "outOfBoundsBottom", over: overB, label: label(el), text: text(el) });',
  '      }',
  '    }',
  '    if ((ellipsis || clamp) && (overX > 2 || overY > 2) && !hasTitle(el)) {',
  '      counts.noTitle++;',
  '      pushItem("noTitle", el, Math.max(overX, overY));',
  '    }',
  '  }',
  '  out.numbers.counts = counts;',
  '  out.numbers.scanned = scanned;',
  '  out.numbers.total = all.length;',
  '  out.items.sort(function (a, b) { return b.over - a.over; });',
  '  return out;',
  '})()',
].join('\n')

/* ── 5) CDP ──────────────────────────────────────────────────────── */

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let seq = 0
    const pending = new Map()
    ws.addEventListener('open', () => resolve(api))
    ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败：' + (e.message || ''))))
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const slot = msg.id ? pending.get(msg.id) : null
      if (!slot) return
      pending.delete(msg.id)
      if (msg.error) slot.rej(new Error(msg.error.message || 'CDP 调用失败'))
      else slot.res(msg.result)
    })
    const api = {
      send: (method, params) => new Promise((res, rej) => {
        const id = ++seq
        pending.set(id, { res, rej })
        ws.send(JSON.stringify({ id, method, params }))
      }),
      close: () => ws.close(),
    }
  })
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    const d = r.exceptionDetails
    return { __exception: (d.exception && (d.exception.description || d.exception.value)) || d.text }
  }
  return r.result ? r.result.value : null
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression)
    if (value === true) return true
    await sleep(120)
  }
  throw new Error('等待超时（' + label + '，' + timeoutMs + 'ms）')
}

function findBrowser() {
  const explicit = arg('chrome', '') || process.env.CHROME_PATH || ''
  const candidates = [
    explicit,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  throw new Error('找不到可用的 Chromium 内核浏览器，请用 --chrome=<exe> 指定')
}

async function cdpPort() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

/* ── 6) 主流程 ───────────────────────────────────────────────────── */

const KIND_LABEL = {
  overflowX: '内容横向溢出',
  outOfBoundsRight: '越出面板右边界',
  outOfBoundsBottom: '越出面板下边界',
  clippedY: '竖切（写死高度/裁剪）',
  noTitle: '被截断但无 title',
}

async function main() {
  if (!fs.existsSync(path.join(UI_ROOT, 'package.json'))) throw new Error('找不到 UI 工程：' + UI_ROOT)
  fs.mkdirSync(WORK, { recursive: true })

  let buildMs = 0
  if (!NO_BUILD) {
    process.stdout.write('构建 UI 到 ' + DIST + ' …\n')
    buildMs = await buildUi()
  }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('没有可用的构建产物，请去掉 --no-build 重新构建')

  const { server, port: appPort } = await serveDist()
  const appUrl = 'http://127.0.0.1:' + appPort + '/index.html'
  const browser = findBrowser()
  const debugPort = await cdpPort()
  fs.mkdirSync(PROFILE, { recursive: true })
  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate,BackForwardCache',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + PROFILE,
    '--window-size=' + WIDTHS[0] + ',' + HEIGHT,
    'about:blank',
  ], { stdio: 'ignore' })

  let cdp = null
  const results = []
  let hardFail = 0
  try {
    let target = null
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()
        target = list.find((t) => t.type === 'page')
      } catch { /* 浏览器还没起来 */ }
      if (!target) await sleep(300)
    }
    if (!target) throw new Error('无头浏览器没有在预期时间内暴露 CDP 页面')
    cdp = await connect(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    let scriptId = null
    let currentState = ''
    let currentHeight = 0
    /** 换内容形态 / 换窗口高度都要重新加载：mock 是随文档注入的，布局也要从首帧就按新高度算。 */
    const reload = async (state) => {
      if (scriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId })
      const data = state === 'empty' ? emptyData() : richData()
      const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mockSource(state, data, PANEL) })
      scriptId = injected.identifier
      currentState = state
      await cdp.send('Page.navigate', { url: appUrl + '?state=' + state })
      await waitFor(cdp, 'document.readyState === "complete" && !!document.querySelector("[data-dock-bar]")', 20000, '应用启动')
      await sleep(400)
    }
    const clickTabScript = (label) => '(function () {' +
      ' var want = ' + JSON.stringify(label) + ';' +
      ' var panel = document.querySelector("[data-dock-panel]");' +
      ' var open = !!(panel && panel.clientWidth > 0);' +
      ' var bs = [].slice.call(document.querySelectorAll("[data-dock-bar] button"));' +
      ' for (var i = 0; i < bs.length; i++) {' +
      '   if ((bs[i].getAttribute("aria-label") || "") !== want) continue;' +
      '   if (open && bs[i].getAttribute("aria-pressed") === "true") return "already";' +
      '   bs[i].click(); return "clicked";' +
      ' }' +
      ' return "not-found";' +
      '})()'
    /**
     * 点开某个页签（已开且已选中就不动它，免得又点成收起）。
     * 就地预览还开着时先切走再切回：PreviewPanel 只在 tab 变化时关预览，
     * 否则「已选中」会被当成「不用点」，页签内容永远停在预览态上。
     */
    const openTab = async (label) => {
      const inPreview = await evaluate(cdp, '!!document.querySelector("[data-dock-panel] [data-dock-tab=preview]")')
      if (inPreview === true) {
        await evaluate(cdp, clickTabScript(label === '产物' ? '任务' : '产物'))
        await sleep(300)
      }
      return evaluate(cdp, clickTabScript(label))
    }
    /** 等页签内容挂上、异步数据落地（高度连续两次一致）后再量尺寸。 */
    const settle = async (key) => {
      await waitFor(cdp, '(function () {' +
        ' var p = document.querySelector("[data-dock-panel]");' +
        ' var t = p && p.querySelector("[data-dock-tab]");' +
        ' return !!(p && p.clientWidth > 0 && t && t.getAttribute("data-dock-tab") === ' + JSON.stringify(key) + ');' +
        '})()', 8000, '页签 ' + key + ' 展开')
      let last = -1
      for (let i = 0; i < 12; i++) {
        const h = await evaluate(cdp, '(function () { var t = document.querySelector("[data-dock-panel] [data-dock-tab]"); return t ? t.scrollHeight : -1; })()')
        if (h === last && h >= 0) break
        last = h
        await sleep(200)
      }
    }
    const capture = async (entry) => {
      if (!SHOT_DIR) return
      const rect = await evaluate(cdp, '(function () { var p = document.querySelector("[data-dock-panel]"); if (!p) return null; var r = p.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()')
      if (!rect || rect.width < 1) return
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } })
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      fs.writeFileSync(path.join(SHOT_DIR, 'dock-' + entry.state + '-' + entry.width + 'x' + entry.height + '-' + entry.tab + '.png'), Buffer.from(shot.data, 'base64'))
    }
    const measure = async (entry) => {
      await capture(entry).catch(() => {})
      const probe = await evaluate(cdp, PROBE)
      if (!probe || probe.__exception) {
        entry.problems.push('探测脚本异常：' + JSON.stringify(probe))
        hardFail++
        return
      }
      entry.problems = entry.problems.concat(probe.problems || [])
      entry.items = probe.items || []
      entry.intentional = probe.intentional || []
      entry.numbers = probe.numbers || null
      entry.findings = entry.items.length
      if (entry.problems.length) hardFail++
    }

    for (const height of HEIGHTS) {
      for (const width of WIDTHS) {
        for (const state of STATES) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
          if (state !== currentState || height !== currentHeight) {
            await reload(state)
            currentHeight = height
          }
          for (const tab of wantedTabs) {
            const entry = { state, width, height, tab: tab.key, problems: [], items: [], numbers: null, intentional: [] }
            const clicked = await openTab(tab.label)
            if (clicked === 'not-found') {
              entry.problems.push('找不到页签按钮「' + tab.label + '」（aria-label 变了？）')
              hardFail++
              results.push(entry)
              continue
            }
            await settle(tab.key).catch((e) => entry.problems.push(e.message))
            await measure(entry)
            results.push(entry)
          }
          if (PREVIEWS) {
            const entry = { state, width, height, tab: 'preview', problems: [], items: [], numbers: null, intentional: [] }
            await openTab('产物')
            await sleep(250)
            // 挑一个「文本/代码」条目点开就地预览：.tsx 走等宽 pre 分支，最容易撑破横向
            const opened = await evaluate(cdp, '(function () {' +
              ' var t = document.querySelector("[data-dock-panel] [data-dock-tab=artifacts]");' +
              ' if (!t) return "no-tab";' +
              ' var bs = [].slice.call(t.querySelectorAll("button"));' +
              ' for (var i = 0; i < bs.length; i++) {' +
              '   if ((bs[i].getAttribute("title") || "").indexOf(".tsx") < 0) continue;' +
              '   bs[i].click(); return "clicked";' +
              ' }' +
              ' return "no-row";' +
              '})()')
            if (opened !== 'clicked') {
              entry.skipped = opened === 'no-tab' ? '产物页签没有内容根节点' : '当前内容形态没有可预览的文本条目'
              results.push(entry)
            } else {
              await settle('preview').catch((e) => entry.problems.push(e.message))
              await measure(entry)
              results.push(entry)
            }
          }
        }
      }
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  } finally {
    if (cdp) cdp.close()
    child.kill()
    server.close()
    if (!KEEP && !NO_BUILD) { try { fs.rmSync(DIST, { recursive: true, force: true }) } catch { /* 忽略 */ } }
    if (!KEEP) { try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch { /* 忽略 */ } }
  }

  const totalFindings = results.reduce((sum, r) => sum + (r.items ? r.items.length : 0), 0)
  const totalIntentional = results.reduce((sum, r) => sum + (r.intentional ? r.intentional.length : 0), 0)
  const totalProblems = results.reduce((sum, r) => sum + r.problems.length, 0)
  const byKind = {}
  for (const r of results) for (const it of r.items || []) byKind[it.kind] = (byKind[it.kind] || 0) + 1
  const noteKinds = {}
  for (const r of results) {
    const notes = r.numbers && r.numbers.counts && r.numbers.counts.notes ? r.numbers.counts.notes : {}
    for (const k of Object.keys(notes)) noteKinds[k] = (noteKinds[k] || 0) + notes[k]
  }

  const report = { uiRoot: UI_ROOT, buildMs, widths: WIDTHS, states: STATES, panelWidth: PANEL, totalFindings, totalProblems, byKind, noteKinds, results }
  if (OUT_FILE) fs.writeFileSync(path.resolve(OUT_FILE), JSON.stringify(report, null, 1), 'utf8')
  if (JSON_ONLY) {
    console.log(JSON.stringify(report, null, 1))
  } else {
    console.log('右侧侧栏巡检：' + WIDTHS.join(' / ') + 'px × ' + STATES.join(' / ') + ' × ' + wantedTabs.length + ' 个页签' +
      (NO_BUILD ? '（复用临时构建）' : '（构建 ' + buildMs + 'ms，产物在 %TEMP%，仓库 dist 未动）'))
    for (const height of HEIGHTS) {
      for (const width of WIDTHS) {
        for (const state of STATES) {
          const group = results.filter((r) => r.width === width && r.state === state && r.height === height)
          if (!group.length) continue
          const findings = group.reduce((sum, r) => sum + (r.items ? r.items.length : 0), 0)
          const panelWidth = group[0].numbers && group[0].numbers.panel ? group[0].numbers.panel.width : 0
          console.log('── ' + state + ' · ' + width + '×' + height + 'px · 面板 ' + panelWidth + 'px ' + (findings ? 'FAIL' : 'PASS') + '（' + findings + ' 处）')
          for (const r of group) {
            const counts = r.numbers && r.numbers.counts ? r.numbers.counts : null
            const tabBox = r.numbers && r.numbers.tabBox ? r.numbers.tabBox : null
            console.log('   · ' + r.tab.padEnd(9) +
              (counts ? ' 扫描 ' + r.numbers.scanned + ' 个可见元素：溢出 ' + counts.overflowX + ' / 越界右 ' + counts.outOfBoundsRight + ' / 越界下 ' + counts.outOfBoundsBottom + ' / 竖切 ' + counts.clippedY + ' / 截断无 title ' + counts.noTitle : '') +
              (tabBox ? '（内容 ' + tabBox.clientHeight + '/' + tabBox.scrollHeight + 'px）' : '') +
              (r.skipped ? '（跳过：' + r.skipped + '）' : '') +
              (r.items.length || r.problems.length || r.skipped ? '' : ' ✓'))
            for (const p of r.problems) console.log('       ✗ ' + p)
            for (const it of r.items) console.log('       ✗ [' + (KIND_LABEL[it.kind] || it.kind) + '] +' + it.over + 'px ' + it.label + '  «' + it.text + '»')
            for (const it of r.intentional) console.log('       · 有意滚动[' + it.kind + '] +' + it.over + 'px ' + it.label)
          }
        }
      }
    }
    console.log('视口组合：' + WIDTHS.length + ' 档宽度 × ' + HEIGHTS.length + ' 档高度 × ' + STATES.length + ' 种内容形态 × ' + (wantedTabs.length + (PREVIEWS ? 1 : 0)) + ' 个视图')
    console.log('清单合计：' + totalFindings + ' 处' + (totalFindings ? '（' + Object.keys(byKind).map((k) => (KIND_LABEL[k] || k) + ' ' + byKind[k]).join('，') + '）' : '') +
      '；脚本级问题 ' + totalProblems + ' 条；有意滚动 / 有意省略号 ' + totalIntentional + ' 处（' + Object.keys(noteKinds).map((k) => k + ' ' + noteKinds[k]).join('，') + '）')
    console.log(totalFindings ? '结果：仍有 ' + totalFindings + ' 处待修' : '结果：' + WIDTHS.length + ' 档宽度 × ' + STATES.length + ' 种内容形态下 0 处溢出 / 越界 / 截断无 title')
  }
  process.exit(totalFindings && SWEEP === 'fail' ? 1 : hardFail ? 1 : 0)
}

main().catch((e) => {
  console.error('巡检脚本失败：' + (e && e.stack ? e.stack : e))
  process.exit(2)
})
