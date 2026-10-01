/** 引擎落库采样器（只读）：每 5 秒记一次当前会话在引擎里的消息条数。
 *  和 cdp-watch.log 的前端条数对照，就能判定「谁吞了这条消息」：
 *    · 前端少、引擎多 → 前端渲染/state 丢了（界面问题）
 *    · 前端有、引擎始终没有 → 发送侧没送到引擎（连接/发送竞态）
 */
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
const LOG = './engine-len.log';
const DIR = process.env.APPDATA + '\\Coomi\\sessions';
const rec = (o) => { try { appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n'); } catch {} };
let last = '';
for (let i = 0; i < 800; i += 1) {
  try {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== '.index.json');
    let best = null;
    for (const f of files) {
      const p = DIR + '\\' + f;
      const m = statSync(p).mtimeMs;
      if (!best || m > best.m) best = { f, m, p };
    }
    if (best) {
      const j = JSON.parse(readFileSync(best.p, 'utf8'));
      const len = (j.messages || []).length;
      const lastText = String(((j.messages || [])[(j.messages || []).length - 1] || {}).content?.text || '').slice(0, 20);
      const line = best.f.slice(0, 8) + ':' + len;
      if (line !== last) { rec({ ev: 'engine-len', sid: best.f.slice(0, 8), len, lastText }); last = line; }
      else if (i % 24 === 0) rec({ ev: 'engine-beat', sid: best.f.slice(0, 8), len });
    }
  } catch (e) { rec({ ev: 'engine-read-error', msg: String(e && e.message || e).slice(0, 120) }); }
  await new Promise((r) => setTimeout(r, 5000));
}
rec({ ev: 'exit' });
