// 掉帧测量脚本：六个场景，全部跑在真实渲染进程上（CDP Tracing + 页内 rAF 采样 + 真实输入注入）。
//
// 用法：
//   1) 让应用带上远程调试端口启动（和 verify-ui.mjs 同一套前置）：
//        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
//        Start-Process 'G:/CoomiP/coomi-desktop.exe'
//      **把应用窗口留在前台**：窗口被挡住/最小化时 rAF 会被节流，帧时间整段失真。
//   2) node apps/desktop/devtools/perf-page-switch.mjs [选项]
//
// 场景（--only=switch,scroll,stream,hover,dialog,drag 只跑其中几个）：
//   ① switch  切页            热切换 N 次（四个页面各遛一遍再计数）
//   ② scroll  长会话滚动      当前会话从头扫到尾、来回若干趟
//   ③ stream  流式生成中滚动  生成中的同一段滚动（见 --stream）
//   ④ hover   悬停导航条扫视  真实指针扫过 Rail 与设置页分组导航（走 CDP 输入，:hover 真的生效）
//   ⑤ dialog  打开弹窗        Ctrl+K 开命令面板、Esc 关，N 轮
//   ⑥ drag    拖拽侧栏调宽    按住分隔条来回拖（每轮净位移为 0，不改动宽度偏好）
//
// 每个场景输出同一组指标（全部来自真实事件，没有估算）：
//   · 帧时间 P50/P95/P99 与 >16.7ms 帧占比：页内 rAF 采样。相邻两帧的间隔翻倍＝掉了一帧，
//     它和 trace 的开销无关，所以是最干净的一路；
//   · RunTask > 50ms 的条数 + 总阻塞 Σ(dur-50ms)：主线程卡顿的直接证据；
//   · Layout + UpdateLayoutTree(样式重算) 合计、Paint、GPUTask：布局 / 绘制 / 合成三段成本。
//     GPU 很闲而 RunTask 很堵 ＝ 瓶颈在主线程；
//   · LayoutShift 计数（页内 PerformanceObserver(layout-shift)，hadRecentInput 的抖动不计）；
//   · 首帧延迟：驱动那一拍 → 场景里第一帧真的画出来（中位数 / P95 / 最差）。
//
// 选项：
//   --cdp=http://127.0.0.1:9222   CDP 基址
//   --switches=10                 ① 切页的热切换次数
//   --runs=6                      其余场景的轮数
//   --gap=650                     相邻两次动作之间的间隔 ms
//   --only=switch,scroll,...      只跑列出的场景（默认全部）
//   --stream=send|wait|skip       ③ 当前没有在生成时怎么办：
//                                 send（默认）＝按 --prompt 自己发一条起一轮；wait＝等你在应用里
//                                 手动发（最多 --streamWait）；skip＝跳过这一场。
//   --streamWait=20000            wait 模式的最长等待 ms
//   --prompt=继续                  send 模式发的提示词（会真的写进当前会话，介意就换 wait/skip）
//   --keepStreaming               send 起的那一轮不自动停（默认场景结束就点「停止生成」）
//   --hoverDwell=90               ④ 每个导航项上停留 ms（调到 400+ 可以让浮层真的弹出来）
//   --dragSteps=16                ⑥ 一次拖拽的采样步数
//   --url=localhost:4173          只认 URL 命中这个子串的页签（默认：跳过 edge:// / 扩展页签）
//   --json                        只打印 JSON（喂给别的脚本用）
//
// 判读口径：优化前后各跑一次，比的应当是「帧时间 P95/P99」「RunTask > 50ms 的条数」与「总阻塞」。
// 首帧延迟用来验「点击反馈 ≤50ms」那一类改动：它量的是驱动那一拍到第一帧的距离。
const BASE = (process.argv.find((a) => a.startsWith('--cdp=')) || '--cdp=http://127.0.0.1:9222').slice(6);
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const num = (name, dflt) => {
  const v = Number(arg(name, ''));
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const SWITCHES = num('switches', 10);
const RUNS = num('runs', 6);
const GAP = num('gap', 650);
const STREAM_WAIT = num('streamWait', 20000);
const HOVER_DWELL = num('hoverDwell', 90);
const DRAG_STEPS = num('dragSteps', 16);
const URL_ARG = arg('url', '');
const ONLY = arg('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const STREAM_MODE = arg('stream', 'send');
const PROMPT = arg('prompt', '继续');
const KEEP_STREAMING = process.argv.includes('--keepStreaming');
const JSON_ONLY = process.argv.includes('--json');
/** 主线程「卡一下」的判定线：一次 RunTask 超过它就算一次掉帧。 */
const LONG_TASK_US = 50_000;
/** 一帧的预算（60Hz）：超过它的帧算掉帧。 */
const FRAME_BUDGET_MS = 16.7;
const TRACE_CATS = 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline';

// ── 连接 ─────────────────────────────────────────────────────────────
let list = [];
for (let i = 0; i < 25; i++) {
  try { list = await (await fetch(BASE + '/json/list')).json(); if (list.some((t) => t.type === 'page')) break; } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 600));
}
/** 应用页：排除浏览器自己的页签（edge:// 设置/同步弹窗、扩展背景页）——
    调试端口一开，Edge 常先挂一个 edge://sync-confirmation-dialog 在那，谁先到不一定。 */
const isApp = (t) => t.type === 'page'
  && !/^(edge|chrome|devtools|about|data):/i.test(t.url)
  && (!URL_ARG || t.url.includes(URL_ARG));
const page = list.find(isApp) ?? list.find((t) => t.type === 'page');
if (!page) {
  console.log('NO PAGE（检查 --remote-debugging-port 是否生效：应用要用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 带端口启动）');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params) => new Promise((res) => {
  const my = ++seq;
  const h = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === my) { ws.removeEventListener('message', h); res(m); }
  };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id: my, method, params }));
});
await send('Runtime.enable');
await send('Page.enable');
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) {
    const d = r.result.exceptionDetails;
    return { __exc: (d.exception && (d.exception.description || d.exception.value)) || d.text };
  }
  return r.result && r.result.result ? r.result.result.value : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 应用真的在跑吗：导航项是切页的唯一入口，找不到就别浪费六次 trace。
const navCount = await ev("document.querySelectorAll('[data-nav-key]').length");
if (!navCount) {
  console.log('页面里没有 [data-nav-key] 导航项（应用没在跑 / 连到了别的页签）');
  ws.close();
  process.exit(1);
}

// ── 页内探针 ─────────────────────────────────────────────────────────
// 三段采样住在这里，全场景共用：
//   · 帧采样：rAF 回调之间的间隔（掉帧＝间隔翻倍）；
//   · 首帧延迟：arm() 之后第一个输入事件（pointerdown/keydown/mousemove）到下一帧的距离 ——
//     真实输入的时戳只有页面自己知道，所以在页面里记，不跨进程对时钟；
//   · LayoutShift：PerformanceObserver('layout-shift')，hadRecentInput 的不算。
const HARNESS = [
  '(function () {',
  // 带版本号：同一页面上重复跑脚本时，旧版本的探针会被换掉，而不是"already"沿用下来。
  '  if (window.__coomiPerf && window.__coomiPerf.v === 2) return "already";',
  '  var st = { raf: 0, running: 0, last: 0, frames: [], armed: 0, t0: 0, lat: [], shifts: 0, score: 0 };',
  '  var onArm = function () { if (!st.armed) return; st.armed = 0; st.t0 = performance.now(); };',
  '  ["pointerdown", "keydown", "mousemove"].forEach(function (t) { window.addEventListener(t, onArm, true); });',
  '  var loop = function (ts) {',
  '    var now = performance.now();',
  '    if (st.last) {',
  '      st.frames.push(ts - st.last);',
  '      // 首帧延迟用 now 而不是 ts：ts 是这一帧的**起点**，输入事件常常是在它之后几毫秒',
  '      // 才处理完的（同一帧里 input → rAF），拿 ts 相减会得到负数——那是量错了，不是反馈快。',
  '      if (st.t0) { st.lat.push(now - st.t0); st.t0 = 0; }',
  '    }',
  '    st.last = ts;',
  '    st.raf = requestAnimationFrame(loop);',
  '  };',
  '  try {',
  '    var po = new PerformanceObserver(function (list) {',
  '      var es = list.getEntries();',
  '      for (var i = 0; i < es.length; i += 1) { if (!es[i].hadRecentInput) { st.shifts += 1; st.score += es[i].value; } }',
  '    });',
  '    po.observe({ type: "layout-shift", buffered: false });',
  '  } catch (e) { /* 老内核没有 layout-shift：计数保持 0 */ }',
  '  window.__coomiPerf = {',
  '    v: 2,',
  '    begin: function () { st.frames = []; st.lat = []; st.shifts = 0; st.score = 0; st.last = 0; st.armed = 0; st.t0 = 0; st.running = 1; if (!st.raf) st.raf = requestAnimationFrame(loop); return true; },',
  '    arm: function () { st.armed = 1; return true; },',
  '    end: function () {',
  '      if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }',
  '      var out = { running: st.running, frames: st.frames, lat: st.lat, shifts: st.shifts, score: st.score };',
  '      st.running = 0;',
  '      return out;',
  '    },',
  '    wait: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },',
  '    frame: function () {',
  '      return new Promise(function (res) {',
  '        var done = false;',
  '        var t = setTimeout(function () { if (!done) { done = true; res(null); } }, 2000);',
  '        requestAnimationFrame(function (ts) { if (!done) { done = true; clearTimeout(t); res(ts); } });',
  '      });',
  '    },',
  '    frames: function (n) { var p = Promise.resolve(); for (var i = 0; i < n; i += 1) p = p.then(function () { return window.__coomiPerf.frame(); }); return p; },',
  '    env: function () {',
  '      return {',
  '        url: location.href, w: innerWidth, h: innerHeight, dpr: devicePixelRatio,',
  '        hidden: document.hidden, focused: document.hasFocus(),',
  '        navItems: document.querySelectorAll("[data-nav-key]").length,',
  '        messages: document.querySelectorAll("[data-msg-index]").length,',
  '        handles: document.querySelectorAll("[data-resize-handle], #coomi-list-sep, #coomi-dock-sep, [data-testid=coomi-list-sep], [data-testid=coomi-dock-sep]").length,',
  '      };',
  '    },',
  '  };',
  '  return "ok";',
  '})()',
].join('\n');
const harnessState = await ev(HARNESS);
if (harnessState !== 'ok' && harnessState !== 'already') {
  console.log('页内探针注入失败：' + JSON.stringify(harnessState));
  ws.close();
  process.exit(1);
}
const beginSample = () => ev('window.__coomiPerf.begin()');
const armProbe = () => ev('window.__coomiPerf.arm()');
const endSample = async () => {
  const r = await ev('window.__coomiPerf.end()');
  return r && typeof r === 'object' && Array.isArray(r.frames) ? r : { running: 0, frames: [], lat: [], shifts: 0, score: 0 };
};

// ── 真实输入注入（CDP）：:hover / Ctrl+K / 拖拽只有走这里才真的生效 ──
const mouse = (type, x, y, buttons = 0, clickCount = 0) => send('Input.dispatchMouseEvent',
  type === 'mousePressed' || type === 'mouseReleased'
    ? { type, x, y, button: 'left', buttons, clickCount: clickCount || 1 }
    : { type, x, y, buttons });
const keyStroke = async (key, code, vk, modifiers) => {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await send('Input.dispatchKeyEvent', Object.assign({}, base, { type: 'rawKeyDown' }));
  await send('Input.dispatchKeyEvent', Object.assign({}, base, { type: 'keyUp' }));
};
const clickNav = async (key) => {
  await ev('(function () { var b = document.querySelector(\'[data-nav-key="' + key + '"]\'); if (b) b.click(); return !!b; })()');
  await sleep(700);
};

// ── trace：一段场景一次 trace，事件按场景切开（不跨进程对时钟） ────────
async function trace(run) {
  const events = [];
  const collect = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Tracing.dataCollected' && Array.isArray(m.params.value)) events.push(...m.params.value);
  };
  ws.addEventListener('message', collect);
  await send('Tracing.start', { categories: TRACE_CATS, transferMode: 'ReportEvents' });
  const done = new Promise((res) => {
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Tracing.tracingComplete') { ws.removeEventListener('message', h); res(); }
    };
    ws.addEventListener('message', h);
  });
  let out = null;
  try {
    out = await run();
  } finally {
    await send('Tracing.end');
    await done;
    ws.removeEventListener('message', collect);
  }
  return { out, events };
}

// ── 统计 ─────────────────────────────────────────────────────────────
const ms = (us) => Math.round(us / 100) / 10;
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

/** 近位法分位数（不打插值）：p=0.95、n=20 时取第 19 个，宁可报坏一点。 */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(events, sample, firstFrames) {
  const runs = [];
  let layoutUs = 0;
  let styleUs = 0;
  let paintUs = 0;
  let gpuUs = 0;
  let gpuCount = 0;
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
    switch (e.name) {
      case 'RunTask': runs.push(e.dur); break;
      // 样式重算：老版本叫 RecalculateStyles，新版本叫 UpdateLayoutTree，两个名字都收。
      case 'Layout': layoutUs += e.dur; break;
      case 'UpdateLayoutTree':
      case 'RecalculateStyles': styleUs += e.dur; break;
      case 'Paint': paintUs += e.dur; break;
      case 'GPUTask': gpuUs += e.dur; gpuCount += 1; break;
      default: break;
    }
  }
  const longRuns = runs.filter((d) => d > LONG_TASK_US);
  const blockingUs = longRuns.reduce((a, d) => a + (d - LONG_TASK_US), 0);
  const frames = [...(sample.frames || [])].sort((a, b) => a - b);
  // 刷新周期取帧间隔的**中位数**：60Hz 是 16.7、120Hz 是 8.3、无 vsync 的无头环境另算，
  // 都从这一次采样里自洽地读出来，不写死。掉帧 = 间隔超过 1.5 个周期（少画了一帧）。
  const period = percentile(frames, 0.5);
  const over = frames.filter((d) => d > FRAME_BUDGET_MS).length;
  const dropped = period ? frames.filter((d) => d > period * 1.5).length : 0;
  const ff = (firstFrames || []).filter((v) => typeof v === 'number' && v >= 0);
  const ffSorted = [...ff].sort((a, b) => a - b);
  return {
    traceEvents: events.length,
    frames: {
      samples: frames.length,
      periodMs: r1(period),
      p50: r1(percentile(frames, 0.5)),
      p95: r1(percentile(frames, 0.95)),
      p99: r1(percentile(frames, 0.99)),
      // 严格 >16.7ms：这是任务书里的口径，60Hz 下会把 16.8 这类显示抖动也算进去，所以另给一列 dropped。
      over16_7: over,
      overRatio: frames.length ? Math.round((over / frames.length) * 1000) / 10 : 0,
      dropped,
      droppedRatio: frames.length ? Math.round((dropped / frames.length) * 1000) / 10 : 0,
      worst: r1(frames.length ? frames[frames.length - 1] : null),
    },
    runTask: {
      count: runs.length,
      over50ms: longRuns.length,
      blockingMs: ms(blockingUs),
      worstMs: runs.length ? ms(Math.max(...runs)) : 0,
      totalMs: ms(runs.reduce((a, d) => a + d, 0)),
    },
    layout: { layoutMs: ms(layoutUs), styleMs: ms(styleUs), totalMs: ms(layoutUs + styleUs) },
    paintMs: ms(paintUs),
    gpu: { tasks: gpuCount, totalMs: ms(gpuUs), note: gpuCount ? undefined : '这次没有 GPUTask 事件（软件合成 / GPU 进程没参与），合成侧成本这一项为空' },
    layoutShift: { count: sample.shifts || 0, score: Math.round((sample.score || 0) * 10000) / 10000 },
    firstFrame: {
      samples: ff.length,
      medianMs: r1(percentile(ffSorted, 0.5)),
      p95Ms: r1(percentile(ffSorted, 0.95)),
      worstMs: r1(ffSorted.length ? ffSorted[ffSorted.length - 1] : null),
    },
  };
}

// ── ① 切页 ───────────────────────────────────────────────────────────
/** 顺序：先把四个页面各遛一遍（这一步是冷启动，不计入结果），再开始计数。 */
const ORDER = ['skills', 'artifacts', 'settings', 'chat'];
const switchPlan = [];
for (let i = 0; i < SWITCHES; i++) switchPlan.push(ORDER[i % ORDER.length]);
const switchDriver = `(async () => {
  const P = window.__coomiPerf;
  const click = async (key) => {
    const btn = document.querySelector('[data-nav-key="' + key + '"]');
    if (!btn) return { key, error: 'no-nav-button' };
    // 双 rAF：先让「上一次过渡 + 挂载」彻底落定，这一拍才是干净的热切换起点。
    await P.frames(2);
    const t0 = performance.now();
    btn.click();
    // rAF 的时间戳 = 这一帧的开始时刻：点击 → 第一帧 = 首帧延迟（不含之后的长任务）。
    const ts = await P.frame();
    return { key, firstFrameMs: ts === null ? null : ts - t0 };
  };
  for (const key of ${JSON.stringify(ORDER)}) { await click(key); await P.wait(260); }
  P.begin();
  const out = [];
  for (const key of ${JSON.stringify(switchPlan)}) { out.push(await click(key)); await P.wait(${GAP}); }
  return out;
})()`;

// ── ②③ 滚动（长会话 / 流式生成中）────────────────────────────────────
// 滚动容器：从一条真实消息往上找第一个能滚的祖先 —— 对话页用的是虚拟列表，
// 直接写死选择器会在换实现时静默失准。
const scrollDriver = (passes) => `(async () => {
  const P = window.__coomiPerf;
  let sc = document.querySelector('[data-msg-index]');
  while (sc && sc !== document.body && sc.scrollHeight - sc.clientHeight <= 8) sc = sc.parentElement;
  if (!sc || sc === document.body) return { error: 'no-scroller' };
  const H = sc.clientHeight;
  const max = Math.max(0, sc.scrollHeight - H);
  if (max < H) return { error: 'session-too-short', viewport: H, scrollable: max };
  const stops = [];
  for (let y = 0; y <= max; y += H * 0.9) stops.push(Math.round(y));
  const lat = [];
  P.begin();
  for (let i = 0; i < ${passes}; i += 1) {
    const path = i % 2 === 0 ? stops : stops.slice().reverse();
    for (const y of path) {
      const t0 = performance.now();
      sc.scrollTop = y;
      const ts = await P.frame();
      if (ts !== null) lat.push(ts - t0);
      await P.wait(24);
    }
  }
  // 回到最底下：对话页的常态就是停在最新一条，别把用户和中途的场景留在半山腰。
  sc.scrollTop = max;
  return { viewport: H, scrollable: max, stops: stops.length, firstFrameMs: lat };
})()`;

const isStreamingExpr = '!!document.querySelector(\'button[aria-label="停止生成"]\')';
const composerExpr = [
  '(function () {',
  '  var ta = null;',
  '  var all = document.querySelectorAll("textarea");',
  '  for (var i = 0; i < all.length; i += 1) { if (/Enter 发送|正在生成/.test(all[i].placeholder || "")) { ta = all[i]; break; } }',
  '  if (!ta) ta = document.querySelector("textarea");',
  '  if (!ta || ta.disabled) return false;',
  '  ta.focus();',
  '  return ta === document.activeElement;',
  '})()',
].join('\n');
/** 让应用进入「正在生成」：能不发就不发（--stream=send 才发）。 */
async function ensureStreaming() {
  if (await ev(isStreamingExpr)) return { ok: true, how: 'already' };
  if (STREAM_MODE === 'skip') return { ok: false, why: '当前没有在生成（--stream=skip）' };
  if (STREAM_MODE === 'wait') {
    const until = Date.now() + STREAM_WAIT;
    while (Date.now() < until) {
      await sleep(500);
      if (await ev(isStreamingExpr)) return { ok: true, how: 'wait' };
    }
    return { ok: false, why: '等了 ' + STREAM_WAIT + 'ms 也没等到你在应用里发消息（--stream=wait）' };
  }
  const focused = await ev(composerExpr);
  if (!focused) return { ok: false, why: '找不到可用的输入框（引擎/页面没就绪）' };
  await send('Input.insertText', { text: PROMPT });
  await sleep(60);
  await keyStroke('Enter', 'Enter', 13, 0);
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    await sleep(250);
    if (await ev(isStreamingExpr)) return { ok: true, how: 'send', started: true };
  }
  return { ok: false, why: '发出去之后没进入生成态（引擎未连接 / 没选模型？）' };
}
const stopStreaming = () => ev('(function () { var b = document.querySelector(\'button[aria-label="停止生成"]\'); if (b) { b.click(); return true; } return false; })()');

// ── ④ 悬停导航条扫视 ─────────────────────────────────────────────────
const hoverItemsExpr = [
  '(function () {',
  '  var out = [];',
  '  var els = document.querySelectorAll("[data-nav-key]");',
  '  for (var i = 0; i < els.length; i += 1) {',
  '    var r = els[i].getBoundingClientRect();',
  '    if (r.width < 4 || r.height < 4) continue;',
  '    out.push({ key: els[i].dataset.navKey, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) });',
  '  }',
  '  return out;',
  '})()',
].join('\n');

// ── ⑤ 打开弹窗 ───────────────────────────────────────────────────────
const paletteOpenExpr = '!!document.querySelector(\'[role="dialog"]\') || !!document.querySelector(\'[data-palette]\')';

// ── ⑥ 拖拽侧栏调宽 ───────────────────────────────────────────────────
// 优先自带 data-resize-handle 的手柄；面板组的分隔条由库渲染，按 id / data-testid 找。
const handlesExpr = [
  '(function () {',
  '  var sels = ["[data-resize-handle]", "#coomi-list-sep", "[data-testid=coomi-list-sep]", "#coomi-dock-sep", "[data-testid=coomi-dock-sep]"];',
  '  var out = [];',
  '  for (var s = 0; s < sels.length; s += 1) {',
  '    var els = document.querySelectorAll(sels[s]);',
  '    for (var i = 0; i < els.length; i += 1) {',
  '      var r = els[i].getBoundingClientRect();',
  '      if (r.height < 60 || r.left < 0 || r.left > innerWidth) continue;',
  '      out.push({ which: sels[s], x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) });',
  '    }',
  '  }',
  '  return out;',
  '})()',
].join('\n');

// ── 场景表 ───────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    id: 'switch',
    label: '① 切页',
    run: async () => {
      await beginSample();
      const { out, events } = await trace(() => ev(switchDriver));
      const sample = await endSample();
      const rows = Array.isArray(out) ? out : [];
      const ff = rows.filter((r) => r && typeof r.firstFrameMs === 'number').map((r) => r.firstFrameMs);
      const failures = rows.filter((r) => !r || r.error);
      return { metrics: summarize(events, sample, ff), notes: failures.length ? ['失败的切换：' + JSON.stringify(failures)] : [] };
    },
  },
  {
    id: 'scroll',
    label: '② 长会话滚动',
    run: async () => {
      const { out, events } = await trace(() => ev(scrollDriver(RUNS)));
      const sample = await endSample();
      if (!out || out.error) return { error: out ? out.error : 'driver-failed', detail: out };
      const ff = Array.isArray(out.firstFrameMs) ? out.firstFrameMs : [];
      const notes = ['会话可滚高度 ' + out.scrollable + 'px / 视口 ' + out.viewport + 'px，' + out.stops + ' 个停靠点 × ' + RUNS + ' 趟'];
      if (out.scrollable < out.viewport * 2) notes.push('会话偏短（可滚高度不足两屏），这一场说服力有限');
      return { metrics: summarize(events, sample, ff), notes };
    },
  },
  {
    id: 'stream',
    label: '③ 流式生成中滚动',
    run: async () => {
      const up = await ensureStreaming();
      if (!up.ok) return { error: 'not-streaming', detail: up.why };
      const started = !!up.started;
      const passes = Math.max(1, Math.round(RUNS / 2));
      const { out, events } = await trace(() => ev(scrollDriver(passes)));
      const sample = await endSample();
      if (started && !KEEP_STREAMING) await stopStreaming();
      if (!out || out.error) return { error: out ? out.error : 'driver-failed', detail: out };
      const ff = Array.isArray(out.firstFrameMs) ? out.firstFrameMs : [];
      return {
        metrics: summarize(events, sample, ff),
        notes: ['生成来源：' + up.how + (started ? '（脚本发的「' + PROMPT + '」，跑完已点停止）' : ''), '滚动 ' + passes + ' 趟，' + out.stops + ' 个停靠点'],
      };
    },
  },
  {
    id: 'hover',
    label: '④ 悬停导航条扫视',
    run: async () => {
      // 设置页同时挂着 Rail 与分组导航，两套导航条一次扫完。
      await clickNav('settings');
      const items = await ev(hoverItemsExpr);
      if (!Array.isArray(items) || items.length < 2) return { error: 'no-nav-items', detail: items };
      await beginSample();
      const { events } = await trace(async () => {
        for (let i = 0; i < RUNS; i += 1) {
          for (const it of items) {
            await armProbe();
            await mouse('mouseMoved', Math.max(1, it.x - Math.round(it.w / 3)), it.y);
            await sleep(HOVER_DWELL);
            await mouse('mouseMoved', it.x + Math.round(it.w / 3), it.y);
            await sleep(HOVER_DWELL);
          }
          await sleep(GAP);
        }
        return true;
      });
      const sample = await endSample();
      await clickNav('chat');
      return {
        metrics: summarize(events, sample, sample.lat),
        notes: ['扫过 ' + items.length + ' 个导航项（含设置页分组导航），每项停留 ' + HOVER_DWELL + 'ms × ' + RUNS + ' 趟'],
      };
    },
  },
  {
    id: 'dialog',
    label: '⑤ 打开弹窗',
    run: async () => {
      await ev('(function () { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()');
      await beginSample();
      let opened = 0;
      let stuck = 0;
      const { events } = await trace(async () => {
        for (let i = 0; i < RUNS; i += 1) {
          // Ctrl+K 是**开关**：上一轮要是没关干净（Esc 被面板里的输入框吃掉），
          // 这一下只会把它关掉，于是被误判成「打不开」。先补一次 Esc 再开。
          if (await ev(paletteOpenExpr)) {
            await keyStroke('Escape', 'Escape', 27, 0);
            await sleep(260);
          }
          if (await ev(paletteOpenExpr)) { stuck += 1; break; }
          // 只给「开」那一拍挂探针：首帧延迟要的是「按下去 → 第一帧」。
          await armProbe();
          await keyStroke('k', 'KeyK', 75, 2);
          // 面板是 React 状态 + 传送门渲染出来的：等它落位再判「开没开」，
          // 否则量到的是「还没渲染」而不是「打不开」。
          await sleep(120);
          if (await ev(paletteOpenExpr)) opened += 1;
          await sleep(Math.max(360, GAP));
          await keyStroke('Escape', 'Escape', 27, 0);
          await sleep(Math.max(320, GAP));
        }
        return opened;
      });
      const sample = await endSample();
      if (!opened) return { error: 'dialog-not-opened', detail: 'Ctrl+K 没有打开命令面板（窗口没在前台？）' };
      return {
        metrics: summarize(events, sample, sample.lat),
        notes: ['Ctrl+K 打开命令面板 ' + opened + '/' + RUNS + ' 次成功，Esc 关闭'
          + (stuck ? '（有 ' + stuck + ' 次 Esc 没关掉，提前收尾——面板大概率自己吃掉了 Esc）' : '')],
      };
    },
  },
  {
    id: 'drag',
    label: '⑥ 拖拽侧栏调宽',
    run: async () => {
      await clickNav('chat');
      const handles = await ev(handlesExpr);
      if (!Array.isArray(handles) || !handles.length) return { error: 'no-resize-handle', detail: '会话列表收起 / 右栏收起时没有分隔条：先展开要量的一侧再跑' };
      const h = handles[0];
      await beginSample();
      const { events } = await trace(async () => {
        for (let i = 0; i < RUNS; i += 1) {
          const sign = i % 2 === 0 ? 1 : -1;
          await armProbe();
          // 先把指针挪到手柄上再按：渲染进程要先有 hover 目标，pointerdown 才落在它身上。
          await mouse('mouseMoved', h.x, h.y, 0);
          await sleep(24);
          await mouse('mousePressed', h.x, h.y, 1, 1);
          for (let s = 1; s <= DRAG_STEPS; s += 1) {
            await mouse('mouseMoved', h.x + sign * s * 6, h.y, 1);
            await sleep(16);
          }
          // 原路拖回去：每轮净位移为 0，跑完宽度与用户的偏好都不变。
          for (let s = DRAG_STEPS; s >= 0; s -= 1) {
            await mouse('mouseMoved', h.x + sign * s * 6, h.y, 1);
            await sleep(16);
          }
          await mouse('mouseReleased', h.x, h.y, 0, 1);
          await sleep(GAP);
        }
        return true;
      });
      const sample = await endSample();
      return {
        metrics: summarize(events, sample, sample.lat),
        notes: ['手柄 ' + h.which + '（x=' + h.x + '），每轮 ' + DRAG_STEPS + ' 步往外 + 原路拖回（净位移 0）'],
      };
    },
  },
];

// ── 跑 ───────────────────────────────────────────────────────────────
const env = await ev('window.__coomiPerf.env()');
const picked = ONLY.length ? SCENARIOS.filter((s) => ONLY.includes(s.id)) : SCENARIOS;
if (!picked.length) {
  console.log('--only 没匹配到任何场景：可选 ' + SCENARIOS.map((s) => s.id).join(','));
  ws.close();
  process.exit(1);
}
// 先热一遍：首屏懒加载 chunk、字体、虚拟列表都落位之后再开始记数。
await sleep(400);

const results = [];
for (const s of picked) {
  let r;
  try {
    r = await s.run();
  } catch (e) {
    r = { error: 'threw', detail: String(e && e.message ? e.message : e) };
  }
  results.push(Object.assign({ id: s.id, label: s.label }, r));
}
ws.close();

const payload = {
  env: { url: env && env.url, viewport: env ? env.w + '×' + env.h : null, dpr: env && env.dpr, focused: env && env.focused, hidden: env && env.hidden },
  runs: { switches: SWITCHES, runs: RUNS, gapMs: GAP, streamMode: STREAM_MODE, hoverDwell: HOVER_DWELL, dragSteps: DRAG_STEPS },
  scenarios: results,
};

if (JSON_ONLY) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const blank = (s, n) => String(s === null || s === undefined ? '-' : s).padEnd(n);
console.log('── 掉帧基线（' + results.length + ' 个场景）──');
console.log('页面      : ' + (payload.env.url || '?') + '   视口 ' + (payload.env.viewport || '?') + ' @' + payload.env.dpr + 'x');
console.log('参数      : 切页 ' + SWITCHES + ' 次 / 其余 ' + RUNS + ' 轮 / 间隔 ' + GAP + 'ms / 流式 ' + STREAM_MODE);
if (payload.env.hidden) {
  console.log('注意      : 页面处于隐藏态（document.hidden=true）——rAF 会被节流，帧时间整段失真，把窗口放到前台重跑。');
}
console.log('');
for (const r of results) {
  console.log('── ' + r.label + ' ' + '─'.repeat(Math.max(0, 34 - r.label.length)));
  if (r.error) {
    console.log('跳过      : ' + r.error + (r.detail ? ' —— ' + (typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)) : ''));
    console.log('');
    continue;
  }
  const m = r.metrics;
  console.log('帧时间    : P50 ' + m.frames.p50 + 'ms / P95 ' + m.frames.p95 + 'ms / P99 ' + m.frames.p99 + 'ms，最差 ' + m.frames.worst + 'ms（刷新周期 ~' + m.frames.periodMs + 'ms）');
  console.log('掉帧      : ' + m.frames.dropped + '/' + m.frames.samples + '（' + m.frames.droppedRatio + '%）＝间隔超过 1.5 个周期；严格 >16.7ms 的 ' + m.frames.over16_7 + '/' + m.frames.samples + '（' + m.frames.overRatio + '%，含显示抖动）');
  console.log('主线程    : RunTask ' + m.runTask.count + ' 条，其中 >50ms ' + m.runTask.over50ms + ' 条；总阻塞 ' + m.runTask.blockingMs + 'ms（最差一条 ' + m.runTask.worstMs + 'ms）');
  console.log('Layout+样式: ' + m.layout.totalMs + 'ms（Layout ' + m.layout.layoutMs + ' / 样式 ' + m.layout.styleMs + '）   Paint ' + m.paintMs + 'ms   GPUTask ' + m.gpu.totalMs + 'ms（' + m.gpu.tasks + ' 个）');
  console.log('LayoutShift: ' + m.layoutShift.count + ' 次（score ' + m.layoutShift.score + '）');
  console.log('首帧延迟  : 中位数 ' + m.firstFrame.medianMs + 'ms / P95 ' + m.firstFrame.p95Ms + 'ms / 最差 ' + m.firstFrame.worstMs + 'ms（' + m.firstFrame.samples + ' 次采样）');
  if (m.gpu.note) console.log('说明      : ' + m.gpu.note);
  for (const n of r.notes || []) console.log('说明      : ' + n);
  console.log('判读      : ' + (m.gpu.totalMs < m.runTask.totalMs / 4
    ? 'GPU 很闲、主线程很忙 —— 瓶颈在主线程。'
    : 'GPU 占比不低，再看一眼是不是合成/绘制这一侧的成本。'));
  console.log('');
}
console.log('汇总（同口径对比用）');
console.log('  ' + blank('场景', 10) + blank('帧P50', 8) + blank('帧P95', 8) + blank('帧P99', 8) + blank('掉帧', 9) + blank('>16.7ms', 9) + blank('RT>50ms', 9) + blank('阻塞ms', 9) + blank('Layout+样式', 12) + blank('Paint', 8) + blank('GPU', 8) + blank('Shift', 7) + '首帧中位');
for (const r of results) {
  if (r.error) { console.log('  ' + blank(r.id, 10) + 'SKIP: ' + r.error); continue; }
  const m = r.metrics;
  console.log('  ' + blank(r.id, 10) + blank(m.frames.p50, 8) + blank(m.frames.p95, 8) + blank(m.frames.p99, 8)
    + blank(m.frames.dropped + '/' + m.frames.samples, 9) + blank(m.frames.over16_7 + '/' + m.frames.samples, 9) + blank(m.runTask.over50ms, 9) + blank(m.runTask.blockingMs, 9)
    + blank(m.layout.totalMs, 12) + blank(m.paintMs, 8) + blank(m.gpu.totalMs, 8) + blank(m.layoutShift.count, 7) + m.firstFrame.medianMs);
}
process.exit(0);
