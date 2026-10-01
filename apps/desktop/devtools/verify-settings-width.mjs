// 设置页：多窗口宽度布局校验 + 溢出巡检（CDP）。
//
// 用法：
//   1) 让应用带上远程调试端口启动（同 verify-ui.mjs）：
//        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
//        Start-Process 'C:/Program Files/Coomi/coomi-desktop.exe'
//   2) node apps/desktop/devtools/verify-settings-width.mjs [选项]
//
// 选项：
//   --cdp=http://127.0.0.1:9222   CDP 基址
//   --widths=860,1180,1440        要校验的窗口宽度（默认这三档）
//   --height=900                  视口高度
//   --url=http://...              先导航到该地址（纯浏览器/探针页面时用）
//   --wizard                      额外点开一个厂商的「编辑」弹窗，校验模型表
//   --sweep=report|fail|off       溢出巡检模式（默认 report：只产出清单，不影响退出码）
//   --groups=all|current          巡检范围：全部设置分组（默认）或只看当前分组
//   --json                        只打印 JSON 结果
//
// 断言（每个宽度各跑一遍）：
//   A 页面根节点不横向溢出：documentElement.scrollWidth <= innerWidth + 2
//   B 「模型与 Provider」面板 scrollWidth <= clientWidth + 2
//   C 面板内没有被祖先裁剪、却越出面板左右边界的元素（绝对定位写死宽度导致的重叠会在这里现形）
//   D --wizard：弹窗不越出视口；模型表是 7 列固定表格；表容器可横向滚动（窄屏滚动而非压扁列）
//
// 溢出巡检（每个分组、每个宽度各跑一遍，产出清单）：
//   E 元素内容横向溢出自身可视宽度（scrollWidth > clientWidth + 2）且不能横向滚动兜底
//   F 元素越出设置内容区右边界（中间层已裁剪的不重复报）
//   G 文案被 truncate / line-clamp / ellipsis 截断，却没有任何 title 兜底
// 退出码：有任一断言失败为 1；--sweep=fail 时巡检清单同样计入失败。
const BASE = (process.argv.find((a) => a.startsWith('--cdp=')) || '--cdp=http://127.0.0.1:9222').slice(6);
const WIDTHS = ((process.argv.find((a) => a.startsWith('--widths=')) || '--widths=860,1180,1440').slice(9)).split(',').map(Number).filter((n) => n > 0);
const HEIGHT = Number((process.argv.find((a) => a.startsWith('--height=')) || '--height=900').slice(9)) || 900;
const URL_ARG = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);
const WIZARD = process.argv.includes('--wizard');
const JSON_ONLY = process.argv.includes('--json');
const SWEEP = ((process.argv.find((a) => a.startsWith('--sweep=')) || '--sweep=report').slice(8)).trim();
const SWEEP_ON = SWEEP !== 'off';
const SWEEP_FATAL = SWEEP === 'fail';
const GROUPS_ARG = ((process.argv.find((a) => a.startsWith('--groups=')) || '--groups=all').slice(9)).trim();
/** 设置页左侧分组：巡检要把每一组都翻一遍，不然「外观」修好了、其它组还漏着。 */
const GROUPS = ['通用', '外观', '模型与厂商', '工作区', 'AI 能力', '数字生命体', '引擎与诊断', '关于'];
const SWEEP_GROUPS = GROUPS_ARG === 'current' ? [null] : GROUPS;

// ── 连接 ─────────────────────────────────────────────────────────────
let list = [];
for (let i = 0; i < 25; i++) {
  try { list = await (await fetch(BASE + '/json/list')).json(); if (list.some((t) => t.type === 'page')) break; } catch (e) { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 600));
}
const page = list.find((t) => t.type === 'page');
if (!page) { console.log('NO PAGE（检查 --remote-debugging-port 是否生效）'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params) => new Promise((res) => {
  const my = ++seq;
  const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener('message', h); res(m); } };
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

// 页面探测（在页面里执行）：返回数字与问题清单。
const PROBE_LINES = [
  '(function () {',
  '  var out = { problems: [], numbers: {} };',
  '  var W = window.innerWidth;',
  '  var doc = document.documentElement;',
  '  out.numbers.viewport = W;',
  '  out.numbers.docScrollWidth = doc.scrollWidth;',
  '  if (doc.scrollWidth > W + 2) out.problems.push("页面横向溢出：documentElement.scrollWidth=" + doc.scrollWidth + " > innerWidth=" + W);',
  '  var panel = document.querySelector("[data-testid=providers-panel]");',
  '  if (!panel) {',
  '    var secs = [].slice.call(document.querySelectorAll("section"));',
  '    for (var i = 0; i < secs.length; i++) {',
  '      var h = secs[i].querySelector("h2");',
  '      if (h && (h.textContent || "").indexOf("模型与 Provider") >= 0) { panel = secs[i]; break; }',
  '    }',
  '  }',
  '  if (!panel) { out.problems.push("找不到「模型与 Provider」面板：请先切到 设置 → 模型与厂商"); return out; }',
  '  out.numbers.panelClientWidth = panel.clientWidth;',
  '  out.numbers.panelScrollWidth = panel.scrollWidth;',
  '  out.numbers.panelVisible = panel.clientWidth > 0;',
  '  if (panel.clientWidth === 0) out.problems.push("厂商面板没有可见（还停在外观分组？）：clientWidth=0");',
  '  if (panel.scrollWidth > panel.clientWidth + 2) out.problems.push("厂商面板横向溢出：scrollWidth=" + panel.scrollWidth + " > clientWidth=" + panel.clientWidth);',
  '  var box = panel.getBoundingClientRect();',
  '  out.numbers.panelRect = { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };',
  '  function clipped(el) {',
  '    var p = el.parentElement;',
  '    while (p && p !== panel.parentElement) {',
  '      var s = getComputedStyle(p);',
  '      if (s.overflowX !== "visible" || s.overflowY !== "visible") return true;',
  '      p = p.parentElement;',
  '    }',
  '    return false;',
  '  }',
  '  var bad = [];',
  '  var all = panel.querySelectorAll("*");',
  '  for (var j = 0; j < all.length; j++) {',
  '    var el = all[j];',
  '    var st = getComputedStyle(el);',
  '    if (st.display === "none" || st.visibility === "hidden" || st.position === "fixed") continue;',
  '    var r = el.getBoundingClientRect();',
  '    if (r.width < 1 && r.height < 1) continue;',
  '    if (clipped(el)) continue;',
  '    var over = Math.max(r.right - box.right, box.left - r.left);',
  '    if (over > 1) bad.push({ over: Math.round(over * 10) / 10, tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 70), text: String(el.textContent || "").trim().slice(0, 20) });',
  '  }',
  '  bad.sort(function (a, b) { return b.over - a.over; });',
  '  if (bad.length) out.problems.push("有 " + bad.length + " 个元素越出面板边界，最大 " + bad[0].over + "px：" + JSON.stringify(bad.slice(0, 3)));',
  '  function colsOf(sel) { var g = panel.querySelector(sel); if (!g) return 0; var t = getComputedStyle(g).gridTemplateColumns; if (!t || t === "none") return 1; return t.split(" ").length; }',
  '  out.numbers.topColumns = colsOf("[data-testid=providers-top]");',
  '  out.numbers.cardColumns = colsOf("[data-testid=providers-grid]");',
  '  var cards = panel.querySelectorAll("[data-testid=provider-card]");',
  '  var widths = [];',
  '  for (var c = 0; c < cards.length; c++) widths.push(Math.round(cards[c].getBoundingClientRect().width));',
  '  out.numbers.cardWidths = widths;',
  '  for (var d = 0; d < widths.length; d++) { if (widths[d] < 280) out.problems.push("厂商卡片被压扁：宽 " + widths[d] + "px < 280px（第 " + (d + 1) + " 张）"); }',
  '  var tops = panel.querySelectorAll("[data-testid=providers-top] > *");',
  '  out.numbers.topCount = tops.length;',
  '  if (tops.length !== 3) out.problems.push("顶部三张卡不是 3 个：" + tops.length);',
  '  for (var t2 = 0; t2 < tops.length; t2++) { var tw = Math.round(tops[t2].getBoundingClientRect().width); if (tw < 180) out.problems.push("顶部卡片被压扁：宽 " + tw + "px < 180px"); }',
  '  return out;',
  '})()',
].join('\n');

const TABLE_PROBE_LINES = [
  '(function () {',
  '  var out = { problems: [], numbers: {} };',
  '  var dlg = document.querySelector("[role=dialog]");',
  '  if (!dlg) { out.problems.push("没有打开任何弹窗"); return out; }',
  '  var r = dlg.getBoundingClientRect();',
  '  out.numbers.dialog = { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };',
  '  if (r.right > window.innerWidth + 2 || r.left < -2) out.problems.push("弹窗越出视口：" + JSON.stringify(out.numbers.dialog) + " / innerWidth=" + window.innerWidth);',
  '  var wrap = dlg.querySelector("[data-testid=model-table-scroll]");',
  '  var table = dlg.querySelector("[data-testid=model-table]");',
  '  if (!wrap || !table) { out.problems.push("弹窗里没有模型表（data-testid=model-table）"); return out; }',
  '  var wr = wrap.getBoundingClientRect();',
  '  out.numbers.tableClientWidth = wrap.clientWidth;',
  '  out.numbers.tableScrollWidth = wrap.scrollWidth;',
  '  out.numbers.tableWidth = Math.round(table.getBoundingClientRect().width);',
  '  if (wr.right > r.right + 1 || wr.left < r.left - 1) out.problems.push("模型表容器越出弹窗边界");',
  '  var cols = table.querySelectorAll("colgroup > col").length;',
  '  out.numbers.columns = cols;',
  '  if (cols !== 7) out.problems.push("模型表不是 7 列（colgroup col 数 = " + cols + "）");',
  '  var overflowing = table.getBoundingClientRect().width > wrap.clientWidth + 2;',
  '  var st = getComputedStyle(wrap);',
  '  out.numbers.scrollable = st.overflowX === "auto" || st.overflowX === "scroll";',
  '  if (overflowing && !out.numbers.scrollable) out.problems.push("模型表比容器宽，但容器不能横向滚动（列会被压扁）");',
  '  var rows = table.querySelectorAll("tbody tr");',
  '  out.numbers.rows = rows.length;',
  '  var ths = table.querySelectorAll("thead th");',
  '  var widths = [];',
  '  for (var i = 0; i < ths.length; i++) widths.push(Math.round(ths[i].getBoundingClientRect().width));',
  '  out.numbers.headerWidths = widths;',
  '  // 弹窗宽度手柄：设置页弹窗默认 min(1040, 100vw-48) 且可拖宽，手柄必须在弹窗右缘上',
  '  var handle = dlg.querySelector("[data-resize-handle=right]");',
  '  out.numbers.resizeHandle = !!handle;',
  '  if (handle) {',
  '    var hr = handle.getBoundingClientRect();',
  '    out.numbers.handleWidth = Math.round(hr.width);',
  '    if (hr.width < 6) out.problems.push("弹窗宽度手柄命中区过窄：" + Math.round(hr.width) + "px < 6px");',
  '    if (Math.abs(hr.right - r.right) > 3) out.problems.push("弹窗宽度手柄没贴在弹窗右缘：手柄 right=" + Math.round(hr.right) + " 弹窗 right=" + Math.round(r.right));',
  '  }',
  '  return out;',
  '})()',
].join('\n');

// 溢出巡检（在页面里执行）：遍历设置内容区，产出「溢出 / 越界 / 截断无 title」三类清单。
const SWEEP_LINES = [
  '(function () {',
  '  var out = { problems: [], numbers: {}, items: [] };',
  '  var body = document.querySelector("[data-testid=settings-body]");',
  '  if (!body) { out.problems.push("找不到设置内容区（[data-testid=settings-body]）：请先切到 设置 页"); return out; }',
  '  var box = body.getBoundingClientRect();',
  '  out.numbers.container = { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };',
  '  out.numbers.scrollWidth = body.scrollWidth;',
  '  out.numbers.clientWidth = body.clientWidth;',
  '  if (body.scrollWidth > body.clientWidth + 2) out.problems.push("设置内容区横向滚动：scrollWidth=" + body.scrollWidth + " > clientWidth=" + body.clientWidth);',
  '  function between(el) {',
  '    var p = el.parentElement;',
  '    while (p && p !== body) {',
  '      var s = getComputedStyle(p);',
  '      if (s.overflowX !== "visible" || s.overflowY !== "visible") return true;',
  '      p = p.parentElement;',
  '    }',
  '    return false;',
  '  }',
  '  function clippedText(el, st) {',
  '    var cls = String(el.className || "");',
  '    var truncate = cls.indexOf("truncate") >= 0 || cls.indexOf("line-clamp-") >= 0 || st.textOverflow === "ellipsis" || st.webkitLineClamp !== "none";',
  '    if (!truncate) return false;',
  '    return el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2;',
  '  }',
  // 当前可见分组：分组是「全部渲染 + hidden 切换」，巡检必须确认自己扫的是哪一组。
  '  var secs = body.querySelectorAll("section");',
  '  for (var s = 0; s < secs.length; s++) {',
  '    if (getComputedStyle(secs[s]).display !== "none") {',
  '      var h2 = secs[s].querySelector("h2");',
  '      out.numbers.active = h2 ? (h2.textContent || "").trim() : "（无标题）";',
  '      break;',
  '    }',
  '  }',
  '  var all = body.querySelectorAll("*");',
  '  var counts = { overflowX: 0, outOfBounds: 0, noTitle: 0 };',
  '  var scanned = 0;',
  '  for (var i = 0; i < all.length; i++) {',
  '    var el = all[i];',
  '    var st = getComputedStyle(el);',
  '    if (st.display === "none" || st.visibility === "hidden" || st.position === "fixed") continue;',
  '    var r = el.getBoundingClientRect();',
  '    if (r.width < 1 && r.height < 1) continue;',
  '    scanned++;',
  '    var tag = el.tagName.toLowerCase();',
  '    var label = tag + " ." + String(el.className || "").replace(/\s+/g, " ").slice(0, 70);',
  '    var text = String(el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);',
  '    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {',
  '      var scrollable = st.overflowX === "auto" || st.overflowX === "scroll";',
  '      if (!scrollable) {',
  '        counts.overflowX++;',
  '        if (out.items.length < 24) out.items.push({ kind: "overflowX", over: el.scrollWidth - el.clientWidth, label: label, text: text });',
  '      }',
  '    }',
  '    if (!between(el)) {',
  '      var over = Math.round((r.right - box.right) * 10) / 10;',
  '      if (over > 1) {',
  '        counts.outOfBounds++;',
  '        if (out.items.length < 24) out.items.push({ kind: "outOfBounds", over: over, label: label, text: text });',
  '      }',
  '    }',
  '    if (clippedText(el, st) && !el.closest("[title]")) {',
  '      counts.noTitle++;',
  '      if (out.items.length < 24) out.items.push({ kind: "noTitle", over: 0, label: label, text: text });',
  '    }',
  '  }',
  '  out.numbers.counts = counts;',
  '  out.numbers.scanned = scanned;',
  '  out.numbers.total = all.length;',
  '  out.items.sort(function (a, b) { return b.over - a.over; });',
  '  return out;',
  '})()',
].join('\n');

// ── 准备页面：切到 设置 → 模型与厂商 ────────────────────────────────
const CLICK_GROUP = '(function () { var bs = [].slice.call(document.querySelectorAll("button")); for (var i = 0; i < bs.length; i++) { if (bs[i].textContent.trim() === "模型与厂商") { bs[i].click(); return "clicked"; } } return "not-found"; })()';
/** 按可见文字「或」aria-label 点按钮：左侧导航条是纯图标按钮，只有 aria-label。 */
const clickByLabel = (label) => '(function () { var want = ' + JSON.stringify(label) + '; var bs = [].slice.call(document.querySelectorAll("button,a")); for (var i = 0; i < bs.length; i++) { var t = (bs[i].textContent || "").trim(); var a = bs[i].getAttribute("aria-label") || ""; if (t === want || a === want) { bs[i].click(); return "clicked"; } } return "not-found"; })()';
const CLICK_SETTINGS = clickByLabel('设置');
const CLICK_EDIT = '(function () { var p = document.querySelector("[data-testid=providers-panel]"); var scope = p || document; var bs = [].slice.call(scope.querySelectorAll("button")); for (var i = 0; i < bs.length; i++) { if (bs[i].textContent.trim() === "编辑") { bs[i].click(); return "clicked"; } } return "not-found"; })()';
/** 按文字点左侧分组按钮（分组名里有空格，必须整串比对）。 */
const clickGroup = clickByLabel;

if (URL_ARG) { await send('Page.navigate', { url: URL_ARG }); await sleep(2500); }

const results = [];
let failed = 0;
let sweepsFailed = 0;
for (const w of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const ready = await ev('(function () { var p = document.querySelector("[data-testid=providers-panel]"); return !!(p && p.clientWidth > 0); })()');
  if (ready !== true) {
    await ev(CLICK_SETTINGS);
    await sleep(500);
    await ev(CLICK_GROUP);
    await sleep(700);
  }
  const pageInfo = await ev(PROBE_LINES);
  const entry = { width: w, panel: pageInfo && pageInfo.numbers ? pageInfo.numbers : null, problems: pageInfo && pageInfo.problems ? pageInfo.problems.slice() : ['探测脚本异常：' + JSON.stringify(pageInfo)] };
  if (WIZARD) {
    const clicked = await ev(CLICK_EDIT);
    if (clicked !== 'clicked') entry.problems.push('打不开「编辑」弹窗（没找到编辑按钮）');
    await sleep(700);
    const table = await ev(TABLE_PROBE_LINES);
    entry.table = table && table.numbers ? table.numbers : null;
    if (table && table.problems) entry.problems = entry.problems.concat(table.problems);
    await ev('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await sleep(500);
  }
  if (SWEEP_ON) {
    // 每个宽度把设置页每个分组翻一遍：某一组没问题是运气，八个组都没问题才是修好了。
    const groups = [];
    let findings = 0;
    for (const label of SWEEP_GROUPS) {
      if (label) {
        await ev(clickGroup(label));
        await sleep(320);
      }
      const sweep = await ev(SWEEP_LINES);
      const info = {
        group: label ?? '（当前分组）',
        numbers: sweep && sweep.numbers ? sweep.numbers : null,
        problems: sweep && sweep.problems ? sweep.problems : ['巡检脚本异常：' + JSON.stringify(sweep)],
        items: sweep && sweep.items ? sweep.items : [],
      };
      const total = info.items.length + info.problems.length;
      findings += total;
      groups.push(info);
    }
    // 巡检完回到「模型与厂商」，免得下一档宽度以为面板还开着。
    await ev(CLICK_GROUP);
    await sleep(400);
    entry.sweep = groups;
    entry.sweepFindings = findings;
    if (findings && SWEEP_FATAL) sweepsFailed++;
  }
  if (entry.problems.length) failed++;
  results.push(entry);
}
await send('Emulation.clearDeviceMetricsOverride').catch(() => {});

const KIND_LABEL = { overflowX: '内容横向溢出', outOfBounds: '越出右边界', noTitle: '被截断但无 title' };
if (JSON_ONLY) {
  console.log(JSON.stringify({ results, failed, sweepsFailed, sweepMode: SWEEP }, null, 1));
} else {
  for (const r of results) {
    console.log('── 宽度 ' + r.width + 'px ' + (r.problems.length ? 'FAIL' : 'PASS'));
    if (r.panel) console.log('   面板 clientWidth=' + r.panel.panelClientWidth + ' scrollWidth=' + r.panel.panelScrollWidth + ' rect=' + JSON.stringify(r.panel.panelRect) + ' 文档 scrollWidth=' + r.panel.docScrollWidth);
    if (r.panel) console.log('   顶部卡列数=' + r.panel.topColumns + ' 厂商卡列数=' + r.panel.cardColumns + ' 厂商卡宽度=' + JSON.stringify(r.panel.cardWidths));
    if (r.table && r.table.dialog) console.log('   弹窗 width=' + r.table.dialog.width + ' 表 container=' + r.table.tableClientWidth + ' scroll=' + r.table.tableScrollWidth + ' 表宽=' + r.table.tableWidth + ' 列=' + r.table.columns + ' 表头列宽=' + JSON.stringify(r.table.headerWidths) + ' 行=' + r.table.rows + ' 宽度手柄=' + (r.table.resizeHandle ? '有(' + r.table.handleWidth + 'px)' : '无'));
    for (const p of r.problems) console.log('   ✗ ' + p);
    if (r.sweep) {
      console.log('   ↳ 溢出巡检（' + r.sweep.length + ' 个分组，' + r.sweepFindings + ' 处）：');
      for (const g of r.sweep) {
        const counts = g.numbers && g.numbers.counts ? g.numbers.counts : null;
        const head = '     · ' + g.group + (g.numbers && g.numbers.active ? '（可见分组：' + g.numbers.active + '）' : '') + (counts ? ' 扫描 ' + g.numbers.scanned + ' 个可见元素：溢出 ' + counts.overflowX + ' / 越界 ' + counts.outOfBounds + ' / 截断无 title ' + counts.noTitle : '');
        if (!g.items.length && !g.problems.length) { console.log(head + ' ✓'); continue; }
        console.log(head);
        for (const p of g.problems) console.log('       ✗ ' + p);
        for (const it of g.items) console.log('       ✗ [' + (KIND_LABEL[it.kind] || it.kind) + '] +' + it.over + 'px ' + it.label + '  «' + it.text + '»');
      }
    }
  }
  console.log(failed ? '结果：' + failed + '/' + results.length + ' 档宽度存在问题' : '结果：' + results.length + ' 档宽度全部通过');
  if (SWEEP_ON) {
    const totalFindings = results.reduce((sum, r) => sum + (r.sweepFindings || 0), 0);
    console.log(totalFindings
      ? '溢出巡检：共 ' + totalFindings + ' 处待修（清单见上）' + (SWEEP_FATAL ? '，已计入失败' : '，当前模式 --sweep=' + SWEEP + ' 不影响退出码')
      : '溢出巡检：' + results.length + ' 档宽度下未发现溢出 / 越界 / 截断无 title');
  }
}
ws.close();
process.exit(failed || sweepsFailed ? 1 : 0);
