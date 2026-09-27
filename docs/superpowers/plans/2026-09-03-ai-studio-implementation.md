# Coomi DeepSeek 修复与 AI 工作室 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 DeepSeek 账号 Provider 与模型选择，校正顶部模型选择器居中，并实现可持久化、可执行的多智能体 AI 工作室。

**Architecture:** DeepSeek 账号配置走专用 API，绕开 OpenAI `/models` 验证。AI 工作室由 Rust 服务层保存领域对象并执行混合调度，Web API/WebSocket 暴露状态，Vue 页面负责配置、群聊、工单看板；Android 控制台只增加工作室入口。

**Tech Stack:** Rust 2024、Axum、Serde、Tokio、Vue 3、Pinia、TypeScript、Android Java/XML、Android ARM64 APK。

**Spec:** `docs/superpowers/specs/2026-09-03-ai-studio-design.md`

## Global Constraints

- 最终包名必须为 `com.cubee.newapp4`。
- 最终版本必须为 `1.4.4o3`，versionCode 44。
- 保留增强 CSS、DeepTrace、文件附件卡片和现有 DeepSeek 登录能力。
- 工作室成员共享一个项目目录，但工具权限逐成员强制执行。
- 默认采用主持人自动调度，同时允许用户通过 `@成员` 直接介入。
- Provider token 不进入消息、日志或浏览器持久化。
- 不新增前端依赖。

---

### Task 1: DeepSeek 专用 Provider 保存与模型切换

**Files:**
- Modify: `apps/coomi-rs/ui/src/web.rs`
- Modify: `apps/coomi-rs/services/src/config.rs`
- Modify: `apps/web/src/views/DeepSeekLoginView.vue`
- Modify: `apps/web/src/stores/config.ts`
- Test: `apps/coomi-rs/services/src/config.rs`

**Interfaces:**
- Produces: `POST /api/deepseek/provider`，请求 `{ model: "deepseek-chat" | "deepseek-reasoner" }`，响应 `{ provider, active, model }`。
- Produces: `POST /api/deepseek/model`，请求 `{ model }`，响应 `{ model }`。
- Consumes: 已持久化的 `config/deepseek.json.token`。

- [ ] **Step 1: 写失败测试**

在 `config.rs` 增加测试，构造 `deepseek-login` Provider，并断言账号协议配置可解析且固定模型被声明：

```rust
#[test]
fn deepseek_account_provider_has_fixed_models() {
    let settings = deepseek_account_settings("token", "deepseek-chat").unwrap();
    assert_eq!(settings.base_url, "https://chat.deepseek.com");
    assert_eq!(settings.models(), vec!["deepseek-chat", "deepseek-reasoner"]);
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cargo test -p coomi-services deepseek_account_provider_has_fixed_models`
Expected: FAIL，`deepseek_account_settings` 不存在。

- [ ] **Step 3: 实现固定 Provider 构造与专用 API**

实现 `deepseek_account_settings(token, model)`，固定 `base_url=https://chat.deepseek.com`、协议 `openai_compatible`、模型列表与 128k 上下文。专用 API 直接写 ProviderDocument 并激活，不调用 `discover-models` 或通用 credential verification。

- [ ] **Step 4: 修改登录页模型选择和保存流程**

登录页在登录按钮前提供 Chat/Reasoner 选择；登录成功后调用 `/api/deepseek/provider`，已登录状态可调用 `/api/deepseek/model` 切换。删除 `config.upsertProvider()` 对账号 Provider 的调用。

- [ ] **Step 5: 验证**

Run: `cargo test -p coomi-services deepseek_account_provider_has_fixed_models`
Run: `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`
Expected: PASS。

### Task 2: 顶部模型栏与弹层居中

**Files:**
- Modify: `apps/web/src/components/TopBar.vue`
- Test: `apps/web/tests/chatTimeline.test.ts`

**Interfaces:**
- Consumes: `config.currentModel` 与现有 `session.selectModel()`。
- Produces: viewport 居中的模型触发器和模型对话框。

- [ ] **Step 1: 增加静态布局测试**

测试读取 `TopBar.vue`，断言 `.center` 使用绝对水平居中，`.model-menu` 使用 viewport 双轴居中：

```ts
assert.match(source, /\.center\s*\{[^}]*left:\s*50%/s)
assert.match(source, /\.model-menu\s*\{[^}]*top:\s*50%[^}]*left:\s*50%/s)
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/chatTimeline.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现居中布局**

`.center` 改为绝对定位 `left:50%; transform:translateX(-50%)`，限制最大宽度；`.model-menu` 改为 `top:50%; left:50%; transform:translate(-50%,-50%)`，高度受安全区和 viewport 限制，scrim 使用半透明背景。

- [ ] **Step 4: 验证**

Run: `node --test tests/chatTimeline.test.ts`
Run: `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`
Expected: PASS。

### Task 3: AI 工作室领域模型与持久化

**Files:**
- Create: `apps/coomi-rs/services/src/studio/model.rs`
- Create: `apps/coomi-rs/services/src/studio/store.rs`
- Create: `apps/coomi-rs/services/src/studio/mod.rs`
- Modify: `apps/coomi-rs/services/src/lib.rs`
- Test: `apps/coomi-rs/services/src/studio/store.rs`

**Interfaces:**
- Produces: `StudioStore::new(root)`, `list`, `load`, `save`, `delete`, `append_message`, `upsert_work_item`。
- Produces: `Studio`, `StudioMember`, `StudioMessage`, `WorkItem`, `MemberStatus`, `WorkItemStatus`, `ToolPermission`。

- [ ] **Step 1: 写持久化失败测试**

使用临时目录创建工作室、成员、消息、工单，重新打开 Store 后断言数据完整；断言非法工作目录、重复成员 id、缺失主持人被拒绝。

- [ ] **Step 2: 运行测试并确认失败**

Run: `cargo test -p coomi-services studio_store`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现领域类型**

Serde 类型使用 snake_case 状态；成员包含 `provider_id/model/role_prompt/system_prompt/tool_permissions/status`；消息不包含 token；工作室限制 2–12 个成员。

- [ ] **Step 4: 实现原子持久化**

每个工作室保存为 `<home>/studios/<id>/studio.json`、`messages.jsonl`、`work-items.json`；JSON 先写临时文件再 rename；消息只追加。

- [ ] **Step 5: 验证**

Run: `cargo test -p coomi-services studio_store`
Expected: PASS。

### Task 4: AI 工作室调度器

**Files:**
- Create: `apps/coomi-rs/services/src/studio/orchestrator.rs`
- Modify: `apps/coomi-rs/services/src/studio/mod.rs`
- Test: `apps/coomi-rs/services/src/studio/orchestrator.rs`

**Interfaces:**
- Produces: `StudioOrchestrator::run(studio_id, input, sink, cancel)`。
- Consumes: `ProviderRegistry`, `HttpModelProvider`, `StudioStore`,成员工具权限。
- Produces events: `member_status`, `message`, `work_item`, `run_finished`, `run_failed`。

- [ ] **Step 1: 写路由与限流失败测试**

覆盖 `@成员` 直达、无 @ 交主持人、未知成员错误、最大转交深度 3、最大每轮调度 24、返工最多 1 次。

- [ ] **Step 2: 运行并确认失败**

Run: `cargo test -p coomi-services studio_orchestrator`
Expected: FAIL。

- [ ] **Step 3: 实现输入路由和结构化主持协议**

主持人响应 JSON：

```json
{"summary":"任务概述","assignments":[{"title":"任务","description":"内容","assignee_id":"member-id","depends_on":[]}]}
```

解析失败时降级为主持人单独回答，不丢失用户消息。

- [ ] **Step 4: 实现成员执行、工单流转和验收**

成员上下文包含工作室目标、职责、共享目录、依赖结果和允许工具。执行状态依次为思考、执行、等待/完成/失败；主持人验收输出 `approved` 或一次返工反馈。

- [ ] **Step 5: 验证**

Run: `cargo test -p coomi-services studio_orchestrator`
Expected: PASS。

### Task 5: 工作室 REST 与 WebSocket API

**Files:**
- Create: `apps/coomi-rs/ui/src/studio_web.rs`
- Modify: `apps/coomi-rs/ui/src/main.rs`
- Modify: `apps/coomi-rs/ui/src/web.rs`
- Test: `apps/coomi-rs/ui/src/studio_web.rs`

**Interfaces:**
- Produces REST: `/api/studios`, `/api/studios/{id}`, `/api/studios/{id}/members`, `/api/studios/{id}/work-items`, `/api/studios/{id}/messages`。
- Produces WS: `/ws/studio/{id}`，命令 `send_message`, `stop`, `retry_work_item`。

- [ ] **Step 1: 写 API 失败测试**

用 Axum router 测试 CRUD、错误状态码、token 不出现在响应、非法路径拒绝、WS 未知命令返回错误事件。

- [ ] **Step 2: 运行并确认失败**

Run: `cargo test -p coomi-ui studio_web`
Expected: FAIL。

- [ ] **Step 3: 实现 REST handlers**

管理接口仅处理领域对象，不直接操作模型。删除运行中工作室返回 409；停止后可删除。

- [ ] **Step 4: 实现 WS 生命周期**

每个工作室同时仅一个 active run；广播持久化消息、成员状态和工单变化；断开浏览器不取消运行，显式 stop 才取消。

- [ ] **Step 5: 验证**

Run: `cargo test -p coomi-ui studio_web`
Expected: PASS。

### Task 6: AI 工作室前端

**Files:**
- Create: `apps/web/src/stores/studio.ts`
- Create: `apps/web/src/views/StudioListView.vue`
- Create: `apps/web/src/views/StudioEditorView.vue`
- Create: `apps/web/src/views/StudioChatView.vue`
- Create: `apps/web/src/components/StudioMemberStrip.vue`
- Create: `apps/web/src/components/StudioWorkBoard.vue`
- Modify: `apps/web/src/router/index.ts`
- Test: `apps/web/tests/studio.test.ts`

**Interfaces:**
- Consumes: Task 5 REST/WS API。
- Produces routes: `/studio`, `/studio/new`, `/studio/:id/edit`, `/studio/:id/chat`。

- [ ] **Step 1: 写 store 失败测试**

覆盖事件归并、成员状态更新、工单状态更新、@候选过滤、断线重连不重复消息。

- [ ] **Step 2: 运行并确认失败**

Run: `node --test tests/studio.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 Pinia store**

Store 管理列表、当前工作室、消息、工单、WS 和运行状态；token 只由现有 authed bridge 添加。

- [ ] **Step 4: 实现列表与编辑页**

列表显示状态与最近活动；编辑页配置共享目录、主持人和成员完整字段，Provider/模型复用 `config.providers`，工具权限使用明确开关。

- [ ] **Step 5: 实现群聊与看板**

群聊顶部成员状态条、中部消息和工单卡、底部 @与输入；看板按五种状态分组；移动端不横向溢出。

- [ ] **Step 6: 验证**

Run: `node --test tests/studio.test.ts`
Run: `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`
Expected: PASS。

### Task 7: Android 控制台入口

**Files:**
- Modify: `apps/coomi-app/app/src/main/res/layout/activity_coomi_dashboard.xml`
- Modify: `apps/coomi-app/app/src/main/res/values/strings_coomi.xml`
- Modify: `apps/coomi-app/app/src/main/java/app/coomi/CoomiDashboardActivity.java`

**Interfaces:**
- Produces: `btn_ai_studio`，打开 `#/studio`。

- [ ] **Step 1: 增加静态失败检查**

Run: `grep -q 'btn_ai_studio' apps/coomi-app/app/src/main/res/layout/activity_coomi_dashboard.xml`
Expected: FAIL。

- [ ] **Step 2: 添加入口布局**

在进入对话卡片和引擎区之间添加同风格行，标题“AI 工作室”，说明“配置多个智能体，协同讨论、派单和执行任务”。

- [ ] **Step 3: 绑定点击事件**

Activity 初始化 `mAiStudioButton` 并调用 `openCoomiRoute("#/studio")`。

- [ ] **Step 4: 验证资源引用**

Run: `grep -R 'btn_ai_studio\|coomi_dash_ai_studio' apps/coomi-app/app/src/main`
Expected: XML、Java、strings 三处均命中。

### Task 8: 版本、完整构建与 APK 交付

**Files:**
- Modify: `apps/coomi-app/app/build.gradle`
- Build artifact: `/workspace/coomi/work/Coomi-1.4.4o3-deepseek-studio-signed.apk`

**Interfaces:**
- Consumes: Tasks 1–7。
- Produces: 可安装 ARM64 APK。

- [ ] **Step 1: 设置版本**

设置 `versionName "1.4.4o3"`、`versionCode 44`。

- [ ] **Step 2: 完整验证**

Run: Rust 定向测试、`cargo check`、全部前端 tests、`vue-tsc --noEmit`、Vite production build。
Expected: 全部 PASS。

- [ ] **Step 3: 编译 ARM64 引擎与 Android Java/DEX**

使用持久工具链 `/workspace/coomi/toolchain` 编译引擎；编译 Android 修改或基于确认过的 smali 重组 classes.dex。

- [ ] **Step 4: 注入增强前端与引擎**

保留 `coomi-patch.js`、`deeptrace.js`、`ChatView-optimized.css`，替换 `assets/web.zip` 和 `lib/arm64-v8a/libcoomi.so`。

- [ ] **Step 5: 签名与验证**

使用 `cubee-newapp4-2.keystore` 签名；验证 ZIP、包名、版本、引擎哈希、前端工作室资源、v2/v3 签名。

- [ ] **Step 6: 暂存等待导出**

成品留在 `/workspace/coomi/work/Coomi-1.4.4o3-deepseek-studio-signed.apk`，用户说“导出”后再调用 Android 文件导出。
