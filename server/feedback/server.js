// Coomi 报错反馈接收服务 + 管理查看端（Node.js，无第三方依赖）
// 由 nginx 反代：https://updates.septemc.com/coomi/feedback/ -> http://127.0.0.1:9017/
//
// v2（2026-09-08）：
//   - 反馈数据 schema 分流：v2（带 schema: "coomi-feedback/2"）按月归档
//     data/<yyyy-mm>/<feedback_id>/payload.json + attachments/；v1 旧格式保持
//     data/error_<时间戳>_<随机>.json 平铺不变，存量数据不迁移。
//   - feedback_id 幂等去重（客户端 Outbox 重发不产生重复记录）。
//   - 新增 DAU 日活统计：POST /api/stats/dau 记录到 dau/<yyyy-mm>.jsonl，
//     GET /api/stats 返回今日/昨日/近7日/近30日日活、趋势与版本分布（仅聚合数）。
//   - 管理 API：/admin/api/list 支持 v2+v1 合并、channel/version 筛选；
//     /admin/api/stats 提供含渠道分布的完整统计。
//
// 管理端：https://updates.septemc.com/coomi/feedback/admin （登录后查看统计与反馈日志）
//   密码来源优先级：环境变量 ADMIN_PASSWORD > admin_config.json 的 password > 默认（不建议）

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const UX_DIR = path.join(__dirname, 'ux_profiles');
const ATTACHMENT_DIR = path.join(__dirname, 'attachments');
const DAU_DIR = path.join(__dirname, 'dau');
const PORT = 9017;
const MAX_BYTES = 256 * 1024; // v2 payload 含对话摘要与工具轨迹，上限 256KB
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_TOTAL_BYTES + MAX_BYTES + 65536;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60000;
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 管理会话 12 小时
const ADMIN_LOGIN_RATE_LIMIT = 8; // 登录尝试限流
const ADMIN_LOGIN_WINDOW_MS = 10 * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ATTACHMENT_DIR)) fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
if (!fs.existsSync(UX_DIR)) fs.mkdirSync(UX_DIR, { recursive: true });
const uxRate = new Map(); // ip -> 最近一小时上传时间戳
if (!fs.existsSync(DAU_DIR)) fs.mkdirSync(DAU_DIR, { recursive: true });

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('missing multipart boundary');
  const boundary = Buffer.from('--' + (match[1] || match[2]).trim());
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor >= 0) {
    const start = cursor + boundary.length;
    if (buffer.subarray(start, start + 2).toString() === '--') break;
    const headerStart = start + 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd < 0) break;
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    const headers = buffer.subarray(headerStart, headerEnd).toString('utf8');
    const disposition = /name="([^"]+)"(?:; filename="([^"]*)")?/i.exec(headers);
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers);
    if (disposition) {
      parts.push({
        name: disposition[1],
        filename: disposition[2] || '',
        type: type ? type[1].trim().toLowerCase() : '',
        data: buffer.subarray(headerEnd + 4, Math.max(headerEnd + 4, next - 2)),
      });
    }
    cursor = next;
  }
  return parts;
}

function imageExtension(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  return '';
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── 管理密码 ──
function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'admin_config.json'), 'utf8'));
    if (cfg && typeof cfg.password === 'string' && cfg.password.length >= 6) return cfg.password;
  } catch {}
  return 'coomi-admin-change-me';
}

// ── 管理会话（内存 Map：token -> 过期时间戳）──
const adminSessions = new Map();
function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
  return token;
}
function checkToken(token) {
  if (!token) return false;
  const expiry = adminSessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { adminSessions.delete(token); return false; }
  return true;
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── 登录限流（内存：ip -> 尝试时间戳数组）──
const loginAttempts = new Map();
function allowLogin(ip) {
  const now = Date.now();
  const list = (loginAttempts.get(ip) || []).filter((t) => now - t < ADMIN_LOGIN_WINDOW_MS);
  if (list.length >= ADMIN_LOGIN_RATE_LIMIT) { loginAttempts.set(ip, list); return false; }
  list.push(now);
  loginAttempts.set(ip, list);
  return true;
}

// ── DAU 记录与统计 ──
function dauDate(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}
function dauMonth(d) { return dauDate(d).slice(0, 7); }

function recordDau(version, ip, versionCode) {
  try {
    const now = new Date();
    const line = JSON.stringify({
      t: now.toISOString(),
      date: dauDate(now),
      ip,
      version: String(version || 'unknown').slice(0, 40),
      version_code: Number(versionCode) || 0,
    });
    fs.appendFileSync(path.join(DAU_DIR, dauMonth(now) + '.jsonl'), line + '\n');
  } catch {}
}

function ipHash(ip) {
  return crypto.createHash('md5').update(String(ip)).digest('hex').slice(0, 16);
}

// 读取 dau 目录全部记录（按日聚合：date -> {ips:Set, versions:Map}）。
function loadDauIndex() {
  const days = new Map(); // date -> { ips:Set, versions:Map }
  let files = [];
  try { files = fs.readdirSync(DAU_DIR).filter((f) => f.endsWith('.jsonl')); } catch {}
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(DAU_DIR, file), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const date = String(rec.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      let day = days.get(date);
      if (!day) { day = { ips: new Set(), versions: new Map() }; days.set(date, day); }
      day.ips.add(ipHash(rec.ip));
      const version = String(rec.version || 'unknown');
      day.versions.set(version, (day.versions.get(version) || 0) + 1);
    }
  }
  return days;
}

// 最近 N 天日期数组（含今天，升序）。
function lastNDates(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(dauDate(d));
  }
  return out;
}

// 聚合统计：today/yesterday/7d/30d 独立 IP 日活、30 日趋势、版本分布、累计。
function dauStats() {
  const days = loadDauIndex();
  const dates = lastNDates(30);
  const today = dates[dates.length - 1];
  const yesterday = dates[dates.length - 2] || today;

  const uniqueIn = (list) => {
    const set = new Set();
    for (const date of list) {
      const day = days.get(date);
      if (day) for (const ip of day.ips) set.add(ip);
    }
    return set.size;
  };

  const trend = dates.map((date) => ({ date, count: days.get(date)?.ips.size || 0 }));
  const last30 = trend.map((t) => t.count).filter((c) => c > 0);
  const peak = Math.max(0, ...last30);
  const avg30 = last30.length ? Math.round((trend.reduce((s, t) => s + t.count, 0) / 30) * 10) / 10 : 0;

  // 版本分布：近 30 天各版本的独立启动 IP 数 + 启动次数。
  const versions = new Map(); // version -> { users:Set, starts:number }
  for (const date of dates) {
    const day = days.get(date);
    if (!day) continue;
    for (const [version, starts] of day.versions) {
      let entry = versions.get(version);
      if (!entry) { entry = { users: new Set(), starts: 0 }; versions.set(version, entry); }
      entry.starts += starts;
    }
    // users 需按版本独立 IP：单独扫一遍原始记录代价低，直接从 index 取。
  }
  // 精确的按版本独立 IP 需要逐条记录，重新扫一次（记录量小）。
  const versionIpSets = new Map();
  let files = [];
  try { files = fs.readdirSync(DAU_DIR).filter((f) => f.endsWith('.jsonl')); } catch {}
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(DAU_DIR, file), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!dates.includes(String(rec.date || '').slice(0, 10))) continue;
      const version = String(rec.version || 'unknown');
      let set = versionIpSets.get(version);
      if (!set) { set = new Set(); versionIpSets.set(version, set); }
      set.add(ipHash(rec.ip));
    }
  }
  const versionList = [...versionIpSets.entries()]
    .map(([version, set]) => ({ version, users: set.size }))
    .sort((a, b) => b.users - a.users);

  // 累计独立 IP·日（全部历史）。
  let totalIpDays = 0;
  for (const day of days.values()) totalIpDays += day.ips.size;

  return {
    dauToday: days.get(today)?.ips.size || 0,
    dauYesterday: days.get(yesterday)?.ips.size || 0,
    dau7d: uniqueIn(dates.slice(-7)),
    dau30d: uniqueIn(dates),
    dau30dAverage: avg30,
    dau30dPeak: peak,
    dau30d: trend,
    dauTotalIpDays: totalIpDays,
    versions: versionList,
    generatedAt: new Date().toISOString(),
  };
}

// ── 反馈记录（v1 平铺 + v2 按月归档）的读取 ──
function v2RecordDir(date) {
  return path.join(DATA_DIR, date); // date = yyyy-mm
}
function safeFeedbackId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

// 列出全部记录（v2 优先按 received_at 倒序，与 v1 合并）。
function listFeedbackSummaries(filter, limit) {
  const summaries = [];
  // v2：<yyyy-mm>/<feedback_id>/payload.json
  let months = [];
  try {
    months = fs.readdirSync(DATA_DIR)
      .filter((f) => /^\d{4}-\d{2}$/.test(f) && fs.statSync(path.join(DATA_DIR, f)).isDirectory());
  } catch {}
  for (const month of months) {
    let ids = [];
    try { ids = fs.readdirSync(v2RecordDir(month)).filter(safeFeedbackId); } catch {}
    for (const id of ids) {
      try {
        const raw = fs.readFileSync(path.join(v2RecordDir(month), id, 'payload.json'), 'utf8');
        const j = JSON.parse(raw);
        const error = j.error || {};
        const diag = j.device || {};
        const app = j.app || {};
        const message = String(j.message || error.message || error.title || '');
        const haystack = (message + ' ' + (error.detail || '') + ' ' + (j.channel || '') + ' '
          + (app.version_name || '') + ' ' + (diag.device_model || '') + ' ' + (j.ip || '')).toLowerCase();
        if (filter.q && !haystack.includes(filter.q)) continue;
        if (filter.channel && j.channel !== filter.channel) continue;
        if (filter.version && app.version_name !== filter.version) continue;
        let attachments = [];
        try {
          attachments = fs.readdirSync(path.join(v2RecordDir(month), id, 'attachments') || [])
            .filter((f) => /\.(jpg|png)$/.test(f))
            .map((name) => ({ name }));
        } catch {}
        summaries.push({
          id: 'v2/' + month + '/' + id,
          v2: true,
          time: j.received_at || j.time || '',
          channel: j.channel || '',
          message: message.slice(0, 200),
          version: app.version_name || '',
          device: diag.device_model || '',
          ip: j.ip || '',
          attachments,
        });
      } catch {}
    }
  }
  // v1：error_<stamp>_<rand>.json 平铺
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('error_') && f.endsWith('.json'));
  } catch {}
  for (const f of files.sort().reverse().slice(0, 1500)) {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
      const j = JSON.parse(raw);
      const msg = typeof j.message === 'string' ? j.message : '';
      const diag = typeof j.diagnostics === 'string' ? safeParseDiag(j.diagnostics) : (j.diagnostics || {});
      const haystack = (f + ' ' + msg + ' ' + (j.provider || '') + ' ' + (j.model || '') + ' '
        + (diag.device_model || '') + ' ' + (diag.version_name || '') + ' ' + (j.ip || '')).toLowerCase();
      if (filter.q && !haystack.includes(filter.q)) continue;
      if (filter.channel) continue; // v1 无 channel 字段，筛选 v2 通道时排除
      if (filter.version && diag.version_name !== filter.version) continue;
      summaries.push({
        id: f,
        v2: false,
        time: j.received_at || j.time || '',
        channel: 'legacy',
        message: msg.slice(0, 200),
        version: diag.version_name || '',
        device: diag.device_model || '',
        provider: j.provider || '',
        model: j.model || '',
        ip: j.ip || '',
        attachments: Array.isArray(j.attachments) ? j.attachments : [],
      });
    } catch {}
  }
  summaries.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return summaries.slice(0, limit);
}

function safeParseDiag(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

const server = http.createServer((req, res) => {
  const respond = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
    res.end(JSON.stringify(obj));
  };
  const sendText = (code, text, type) => {
    res.writeHead(code, { 'Content-Type': type || 'text/html; charset=utf-8' });
    res.end(text);
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const ip = (req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || 'unknown').trim();

  // ── 管理页面 ──
  if (p === '/admin' && req.method === 'GET') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
      sendText(200, html);
    } catch {
      sendText(500, '<h3>admin.html missing</h3>');
    }
    return;
  }

  // ── 登录 ──
  if (p === '/api/admin/login' && req.method === 'POST') {
    if (!allowLogin(ip)) { respond(429, { ok: false, error: 'too many attempts, try later' }); return; }
    let raw = '';
    req.on('data', (c) => { if (raw.length < 4096) raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { respond(400, { ok: false, error: 'bad json' }); return; }
      if (!body || typeof body.password !== 'string' || body.password.length === 0) {
        respond(400, { ok: false, error: 'password required' }); return;
      }
      if (safeEqual(body.password, adminPassword())) {
        respond(200, { ok: true, token: issueToken() });
      } else {
        respond(401, { ok: false, error: 'wrong password' });
      }
    });
    return;
  }

  // ── DAU 日活心跳（公开，仅记录聚合所需最小字段）──
  if (p === '/api/stats/dau' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { if (raw.length < 4096) raw += c; });
    req.on('end', () => {
      let body = {};
      try { if (raw.trim()) body = JSON.parse(raw); } catch { body = {}; }
      recordDau(
        req.headers['x-coomi-version'] || body.version || '',
        ip,
        body.version_code || 0,
      );
      respond(200, { ok: true });
    });
    return;
  }

  // ── 公开聚合统计（不含 IP、不含反馈内容）──
  if (p === '/api/stats' && req.method === 'GET') {
    respond(200, { ok: true, ...dauStats() });
    return;
  }

  // ── 用户体验改进计划：脱敏画像接收（公开 + 限流）──
  if (p === '/api/ux-profile' && req.method === 'POST') {
    const nowMs = Date.now();
    const hits = (uxRate.get(ip) || []).filter((t) => nowMs - t < 3600_000);
    if (hits.length >= 8) { respond(429, { ok: false, error: 'too many requests' }); return; }
    hits.push(nowMs);
    uxRate.set(ip, hits);
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 96 * 1024) { respond(413, { ok: false, error: 'payload too large' }); req.destroy(); }
    });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { respond(400, { ok: false, error: 'bad json' }); return; }
      if (!body || body.schema !== 'coomi-ux-profile/1'
        || !/^[A-Za-z0-9-]{8,64}$/.test(String(body.client_id || ''))
        || !body.profile || typeof body.profile !== 'object') {
        respond(400, { ok: false, error: 'invalid payload' }); return;
      }
      try {
        const month = new Date().toISOString().slice(0, 7);
        const dir = path.join(UX_DIR, month);
        fs.mkdirSync(dir, { recursive: true });
        body.received_at = new Date().toISOString();
        body.ip = ip;
        fs.writeFileSync(path.join(dir, body.client_id + '.json'), JSON.stringify(body, null, 2), { mode: 0o640 });
        respond(200, { ok: true });
      } catch {
        respond(500, { ok: false, error: 'write failed' });
      }
    });
    return;
  }

  // ── 管理 API（需 token）──
  if (p.startsWith('/admin/api/')) {
    if (req.method !== 'GET') { respond(405, { ok: false, error: 'method not allowed' }); return; }
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (url.searchParams.get('token') || '');
    if (!checkToken(token)) { respond(401, { ok: false, error: 'unauthorized' }); return; }

    if (p === '/admin/api/list') {
      const filter = {
        q: (url.searchParams.get('q') || '').toLowerCase(),
        channel: url.searchParams.get('channel') || '',
        version: url.searchParams.get('version') || '',
      };
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 500);
      const items = listFeedbackSummaries(filter, limit);
      respond(200, { ok: true, total: items.length, items });
      return;
    }

    if (p === '/admin/api/attachment') {
      const rid = url.searchParams.get('id') || '';
      const name = url.searchParams.get('name') || '';
      const v2 = rid.startsWith('v2/');
      if (v2) {
        const parts = rid.split('/'); // v2/<month>/<id>
        if (parts.length !== 3 || !/^\d{4}-\d{2}$/.test(parts[1]) || !safeFeedbackId(parts[2])
          || !/^[A-Za-z0-9_-]+\.(jpg|png)$/.test(name)) {
          respond(400, { ok: false, error: 'bad attachment path' }); return;
        }
        const file = path.join(v2RecordDir(parts[1]), parts[2], 'attachments', name);
        if (!file.startsWith(path.join(v2RecordDir(parts[1]), parts[2]) + path.sep)) {
          respond(400, { ok: false, error: 'bad attachment path' }); return;
        }
        try {
          const bytes = fs.readFileSync(file);
          res.writeHead(200, { 'Content-Type': name.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
          res.end(bytes);
        } catch { respond(404, { ok: false, error: 'not found' }); }
        return;
      }
      if (!/^[A-Za-z0-9_-]+$/.test(rid) || !/^[A-Za-z0-9_-]+\.(jpg|png)$/.test(name)) {
        respond(400, { ok: false, error: 'bad attachment path' }); return;
      }
      const file = path.join(ATTACHMENT_DIR, rid, name);
      if (!file.startsWith(path.join(ATTACHMENT_DIR, rid) + path.sep)) {
        respond(400, { ok: false, error: 'bad attachment path' }); return;
      }
      try {
        const bytes = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': name.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
        res.end(bytes);
      } catch { respond(404, { ok: false, error: 'not found' }); }
      return;
    }

    if (p === '/admin/api/detail') {
      const id = url.searchParams.get('id') || '';
      if (id.startsWith('v2/')) {
        const parts = id.split('/');
        if (parts.length !== 3 || !/^\d{4}-\d{2}$/.test(parts[1]) || !safeFeedbackId(parts[2])) {
          respond(400, { ok: false, error: 'bad id' }); return;
        }
        const file = path.join(v2RecordDir(parts[1]), parts[2], 'payload.json');
        if (!file.startsWith(v2RecordDir(parts[1]) + path.sep)) {
          respond(400, { ok: false, error: 'bad id' }); return;
        }
        try {
          const raw = fs.readFileSync(file, 'utf8');
          respond(200, { ok: true, data: JSON.parse(raw) });
        } catch { respond(404, { ok: false, error: 'not found' }); }
        return;
      }
      if (!id || !/^error_[A-Za-z0-9_.-]+\.json$/.test(id)) { respond(400, { ok: false, error: 'bad id' }); return; }
      const file = path.join(DATA_DIR, id);
      if (!file.startsWith(DATA_DIR + path.sep)) { respond(400, { ok: false, error: 'bad id' }); return; }
      try {
        const raw = fs.readFileSync(file, 'utf8');
        respond(200, { ok: true, data: JSON.parse(raw) });
      } catch {
        respond(404, { ok: false, error: 'not found' });
      }
      return;
    }

    if (p === '/admin/api/ux-list') {
      const items = [];
      let months = [];
      try { months = fs.readdirSync(UX_DIR).filter((f) => /^\d{4}-\d{2}$/.test(f)).sort().reverse(); } catch {}
      for (const month of months) {
        let files = [];
        try { files = fs.readdirSync(path.join(UX_DIR, month)).filter((f) => f.endsWith('.json')); } catch {}
        for (const file of files) {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(UX_DIR, month, file), 'utf8'));
            const profile = j.profile || {};
            const scenes = (profile.scene_preferences || []).slice(0, 3)
              .map((scene) => scene.category).join(' / ');
            items.push({
              client_id: file.replace(/\.json$/, ''),
              month,
              generated_at: profile.generated_at || '',
              received_at: j.received_at || '',
              scenes,
              sample_quality: profile.sample_quality || '',
              messages: (profile.period && profile.period.user_messages_scanned) || 0,
              sensitive: (profile.sensitive_summary || []).reduce((sum, s) => sum + (s.count || 0), 0),
            });
          } catch {}
        }
      }
      items.sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)));
      respond(200, { ok: true, total: items.length, items: items.slice(0, 300) });
      return;
    }

    if (p === '/admin/api/ux-detail') {
      const id = url.searchParams.get('id') || '';
      if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) { respond(400, { ok: false, error: 'bad id' }); return; }
      let months = [];
      try { months = fs.readdirSync(UX_DIR).filter((f) => /^\d{4}-\d{2}$/.test(f)).sort().reverse(); } catch {}
      for (const month of months) {
        const file = path.join(UX_DIR, month, id + '.json');
        if (file.startsWith(path.join(UX_DIR, month) + path.sep) && fs.existsSync(file)) {
          try { respond(200, { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }); }
          catch { respond(500, { ok: false, error: 'read failed' }); }
          return;
        }
      }
      respond(404, { ok: false, error: 'not found' });
      return;
    }

    if (p === '/admin/api/stats') {
      const stats = dauStats();
      // 渠道分布（近 30 天 v2 反馈计数）。
      const channels = new Map();
      let months = [];
      try {
        months = fs.readdirSync(DATA_DIR).filter((f) => /^\d{4}-\d{2}$/.test(f));
      } catch {}
      for (const month of months) {
        let ids = [];
        try { ids = fs.readdirSync(v2RecordDir(month)).filter(safeFeedbackId); } catch {}
        for (const id of ids) {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(v2RecordDir(month), id, 'payload.json'), 'utf8'));
            const channel = String(j.channel || 'unknown');
            channels.set(channel, (channels.get(channel) || 0) + 1);
          } catch {}
        }
      }
      stats.channels = [...channels.entries()].map(([channel, count]) => ({ channel, count })).sort((a, b) => b.count - a.count);
      stats.feedbackTotal = (() => {
        let n = 0;
        try { n += fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('error_') && f.endsWith('.json')).length; } catch {}
        for (const month of months) {
          try { n += fs.readdirSync(v2RecordDir(month)).filter(safeFeedbackId).length; } catch {}
        }
        return n;
      })();
      respond(200, { ok: true, ...stats });
      return;
    }

    respond(404, { ok: false, error: 'not found' });
    return;
  }

  // ── 上报接收 ──
  if (req.method !== 'POST') {
    respond(405, { ok: false, error: 'method not allowed' });
    return;
  }

  const chunks = [];
  let received = 0;
  let tooBig = false;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_REQUEST_BYTES) {
      tooBig = true;
      respond(413, { ok: false, error: 'payload too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooBig) return;
    const body = Buffer.concat(chunks);
    const contentType = String(req.headers['content-type'] || '');
    let payload;
    let images = [];
    try {
      if (contentType.toLowerCase().startsWith('multipart/form-data')) {
        const parts = parseMultipart(body, contentType);
        const payloadPart = parts.find((part) => part.name === 'payload');
        if (!payloadPart || payloadPart.data.length > MAX_BYTES) throw new Error('invalid payload part');
        payload = JSON.parse(payloadPart.data.toString('utf8'));
        images = parts.filter((part) => part.name === 'images');
        if (images.length > 3) throw new Error('too many images');
        let imageTotal = 0;
        for (const image of images) {
          imageTotal += image.data.length;
          image.extension = imageExtension(image.data);
          if (!image.extension || image.data.length > MAX_IMAGE_BYTES || imageTotal > MAX_TOTAL_BYTES) {
            throw new Error('invalid image');
          }
        }
      } else {
        if (body.length > MAX_BYTES) throw new Error('payload too large');
        payload = JSON.parse(body.toString('utf8'));
      }
    } catch {
      respond(400, { ok: false, error: 'bad payload' });
      return;
    }
    if (!payload || typeof payload !== 'object') {
      respond(400, { ok: false, error: 'missing payload' });
      return;
    }
    const isV2 = payload.schema === 'coomi-feedback/2';
    if (!isV2 && !payload.message) {
      respond(400, { ok: false, error: 'missing message' });
      return;
    }

    // 简单限流：同 IP 60 秒内最多 RATE_LIMIT 次
    const rateFile = path.join(DATA_DIR, 'rate_' + crypto.createHash('md5').update(ip).digest('hex') + '.tmp');
    const now = Date.now();
    let hits = [];
    try {
      hits = JSON.parse(fs.readFileSync(rateFile, 'utf8'));
    } catch {}
    if (!Array.isArray(hits)) hits = [];
    hits = hits.filter((t) => now - t < RATE_WINDOW_MS);
    if (hits.length >= RATE_LIMIT) {
      respond(429, { ok: false, error: 'too many requests' });
      return;
    }
    hits.push(now);
    try { fs.writeFileSync(rateFile, JSON.stringify(hits)); } catch {}

    const ts = new Date();
    payload.received_at = ts.toISOString();
    payload.ip = ip;

    try {
      if (isV2) {
        // v2：按月归档 data/<yyyy-mm>/<feedback_id>/，feedback_id 幂等去重。
        const id = payload.feedback_id;
        if (!safeFeedbackId(id)) { respond(400, { ok: false, error: 'invalid feedback_id' }); return; }
        const month = dauMonth(ts);
        const recordDir = path.join(v2RecordDir(month), id);
        if (fs.existsSync(path.join(recordDir, 'payload.json'))) {
          respond(200, { ok: true, id, dedup: true });
          return;
        }
        fs.mkdirSync(recordDir, { recursive: true, mode: 0o750 });
        if (images.length) {
          const attDir = path.join(recordDir, 'attachments');
          fs.mkdirSync(attDir, { recursive: true, mode: 0o750 });
          payload.attachments = images.map((image, index) => {
            const name = String(index + 1) + '_' + crypto.randomBytes(4).toString('hex') + '.' + image.extension;
            fs.writeFileSync(path.join(attDir, name), image.data, { mode: 0o640 });
            return { name, type: image.extension === 'png' ? 'image/png' : 'image/jpeg', size: image.data.length };
          });
        }
        fs.writeFileSync(path.join(recordDir, 'payload.json'), JSON.stringify(payload, null, 2), { mode: 0o640 });
        respond(200, { ok: true, id });
        return;
      }

      // v1：平铺 data/error_<stamp>_<rand>.json（原逻辑不变）。
      const stamp =
        ts.getFullYear().toString() +
        String(ts.getMonth() + 1).padStart(2, '0') +
        String(ts.getDate()).padStart(2, '0') +
        '_' +
        String(ts.getHours()).padStart(2, '0') +
        String(ts.getMinutes()).padStart(2, '0') +
        String(ts.getSeconds()).padStart(2, '0');
      const id = stamp + '_' + crypto.randomBytes(4).toString('hex');
      const file = path.join(DATA_DIR, 'error_' + id + '.json');
      try {
        if (images.length) {
          const dir = path.join(ATTACHMENT_DIR, id);
          fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
          payload.attachments = images.map((image, index) => {
            const name = String(index + 1) + '_' + crypto.randomBytes(4).toString('hex') + '.' + image.extension;
            fs.writeFileSync(path.join(dir, name), image.data, { mode: 0o640 });
            return { name, type: image.extension === 'png' ? 'image/png' : 'image/jpeg', size: image.data.length };
          });
        }
        fs.writeFileSync(file, JSON.stringify(payload, null, 2));
      } catch (e) {
        respond(500, { ok: false, error: 'write failed' });
        return;
      }
      respond(200, { ok: true, id });
    } catch (e) {
      respond(500, { ok: false, error: 'write failed' });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('coomi feedback server (v2) listening on 127.0.0.1:' + PORT);
});
