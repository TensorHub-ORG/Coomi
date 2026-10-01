---
feature: engine-enhancement
status: delivered
updated: 2026-09-12
branch: main
commits: local
---

# Engine Enhancement

## Report

**What was built** — 引擎四向增强：Provider Responses 400 自动降级去 tools 重试；psi-v2 里程碑文案与做梦日志；协同依赖失败/硬打断/锁/超时已有底座并文档化；连接层 outbox+心跳+停摆复活。范围控制为可编译、可冒烟的增量，不做 SQLite/群聊 G1–G6。

**Verification** — `cargo check -p coomi-services/-p coomi-ui` Finished；sidecar 冒烟 bootstrap/after_turn/get_state 输出含 milestone/turn_count；`vue-tsc` + 9/9 测试通过。

**Journey log** — 用户勾选全部四向；无 git 故跳过 worktree；deep-research/3d-creation 不适用引擎。

## [S1] Problem
协同/连接/Provider/认知仍有停摆、兼容与体验缺口。

## [S2] Design
### Provider
- Responses 400（json_parse_error/invalid_request/tool）→ 去 tools 重试一次
- tools 字段不强制 strict

### 数字生命体
- dream.log 每 16 轮摘要
- milestone 里程碑文案
- CognitiveState 增加 milestone 字段

### 协同/连接（确认底座）
- depends_on 失败传播、interrupt、claim 锁、WS outbox/心跳/停摆复活

## [S3] Out of Scope
SQLite 全量迁移、群聊 G1–G6、崩溃熔断 Android 原生层

## Tasks
- [x] T1: Provider 400 降级重试 — acceptance: 400 含 json_parse_error 时无 tools 重试 (covers: S2)
- [x] T2: 协同依赖失败/硬打断确认 — acceptance: cargo check 通过 (covers: S2)
- [x] T3: psi-v2 做梦日志 + 里程碑 — acceptance: sidecar 冒烟含 milestone (covers: S2)
- [x] T4: 前后端 type-check/test — acceptance: vue-tsc + 9/9 (covers: S2)
