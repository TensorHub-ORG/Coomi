---
feature: ux-and-collab-polish
status: delivered
updated: 2026-09-12
branch: main
commits: local
---

# UX and Collab Polish

## Report

**What was built** — 修正返回默认回对话而非控制台；文件另存走 attachment 下载兜底；SVG 可 img 内联；协同创建强制 ≥2 角色，工作台可「编辑角色/再建」；工作台更多面板增加上下文用量圆环；Catalog 恢复并重加自定义 MCP；Life 恢复 psi-v2 字段展示。图标保持金色原版四瓣。

**Verification** — vue-tsc + 9/9 测试；cargo check -p coomi-ui Finished。

## [S1] Problem
另存/外部打开不可用；返回误入控制台；协同缺编辑角色与用量；SVG 不展示。

## [S2] Design
- goBack 无历史默认 `/`（对话）
- /api/fs/download attachment；FileInline/FileManager 兜底
- 协同 roles ≥2；loadFromTask 回创建页；用量圆环

## [S3] Out of Scope
SQLite、群聊 G1–G6 完整编排

## Tasks
- [x] T1: 返回改对话 — acceptance: goBack 默认 / (covers: S2)
- [x] T2: 另存+下载 API — acceptance: fs/download 存在且 FileInline 使用 (covers: S2)
- [x] T3: 协同 ≥2 + 编辑角色 — acceptance: draft errors 含 2 角色；工作台可回创建页 (covers: S2)
- [x] T4: 用量圆环 — acceptance: more 面板显示 contextRatio (covers: S2)
