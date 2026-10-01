import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
const f = 'G:/DSH/coomi-full-project/apps/coomi-rs/engine/src/agent.rs';
const src = readFileSync(f, 'utf8');
const lines = src.split('\n');
const findLine = (pred) => lines.findIndex(pred);
const start = findLine((l) => l.includes('核心工具常驻；长尾工具仅在提示词/上下文关键词命中时暴露'));
const fnIdx = findLine((l) => l.includes('fn select_tool_specs('));
if (start < 0 || fnIdx < 0) { console.log('ANCHOR_MISS start=' + start + ' fn=' + fnIdx); process.exit(1); }
let end = -1;
for (let i = fnIdx; i < lines.length; i += 1) { if (lines[i] === '}') { end = i; break; } }
console.log('start=' + start + ' fn=' + fnIdx + ' end=' + end);
console.log('start 行: ' + JSON.stringify(lines[start]));
console.log('end   行: ' + JSON.stringify(lines[end]));
console.log('end 后一行: ' + JSON.stringify(lines[end + 1]));
const repl = [
'/// 稳定的工具清单：**全集 + 确定性顺序**（按名字排序）。',
'///',
'/// 为什么不再按当前提问裁剪（旧 select_tool_specs 已删除）：工具数组排在请求最前面',
'/// （OpenAI 的 tools / Anthropic 顶层 tools），一删一加就等于把整段前缀缓存作废 ——',
'/// 实测同一会话里命中率 0% 与 98% 交替，正是相邻两轮提问关键词不同造成的。',
'/// 而且「工具时有时无」本身就在削模型能力：关键词没命中时，模型压根不知道有这个工具。',
'///',
'/// 多出来的工具描述 token 属于**可缓存的稳定前缀**：稳态下每轮都命中，只为首轮与',
'/// 写缓存那一轮付费；换来的是「工具永远齐全 + 前缀永不抖动」。',
'fn stable_tool_specs(all: &[crate::ToolSpec]) -> Vec<crate::ToolSpec> {',
'    let mut specs = all.to_vec();',
'    // MCP 工具的到达顺序取决于运行时连接顺序，必须排序才能跨轮一致。',
'    specs.sort_by(|a, b| a.name.cmp(&b.name));',
'    specs',
'}',
];
const out = [...lines.slice(0, start), ...repl, ...lines.slice(end + 1)];
writeFileSync(f, out.join('\n'), 'utf8');
try { unlinkSync('G:/DSH/coomi-full-project/apps/coomi-rs/engine/src/_stable_tool_specs.txt'); } catch {}
console.log('删除行数=' + (end - start + 1) + ' 新增=' + repl.length + ' 新总行数=' + out.length);
