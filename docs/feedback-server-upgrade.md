# Coomi 反馈服务端升级设计（feedback api v2）

> 状态：**设计稿，本轮未部署**。客户端已按「增量兼容」先行：新旧客户端都会继续
> POST 到 `https://updates.septemc.com/coomi/feedback/api`，本设计在服务端实施后生效。
> 实施时服务器连接信息见内部 SSH 配置（8.148.146.68，root）。

## 1. 现状

- `POST /coomi/feedback/api`：现有接收脚本，把整个 JSON 落盘；multipart 时含
  `payload`（JSON）+ `images` 附件。运行正常。
- `POST /coomi/feedback/api/stats/dau`：DAU 心跳（头 `X-Coomi-Version`）。
- `GET /coomi/android/latest.json`、`/coomi/android_test/latest.json`：更新检查。

## 2. 客户端数据契约（v2，已实现）

新增 `schema: "coomi-feedback/2"` 字段；**旧客户端（v1）payload 不含 schema 字段**。
v2 payload 结构：

```json
{
  "schema": "coomi-feedback/2",
  "feedback_id": "uuid（幂等去重键）",
  "time": "iso8601",
  "channel": "crash | startup_failure | runtime_error | tool_failure | performance | manual",
  "app":   { "version_name", "version_code", "package_name" },
  "device": { "device_model", "manufacturer", "os", "android_version", "sdk_int" },
  "environment": { "engine_version", "storage_free_bytes", "runtime_v2_rootfs_ready", "bootstrap_ready" },
  "session": { "session_id", "provider", "model", "permission_mode" },
  "error": { "title", "message", "detail", "stack" },
  "context": {
    "conversation_excerpt": [ { "role": "user|assistant", "text": "…" } ],
    "tool_trace": [ { "sequence", "tool", "argument_shape", "status", "category", "error_summary", "elapsedMs" } ],
    "engine_log_tail": "coomi.log 末尾 ~64KB"
  },
  "analysis": "模型溯源分析（Markdown 字符串）或 null",
  "lessons": [ "（预留）随反馈上传的经验条目" ],
  "type": "suggestion|issue（仅 manual）", "message": "…", "contact": "…（仅 manual）",
  "reasoning_statistics": { …（仅 manual） }, "source": "android_diagnostics_page"
}
```

脱敏策略（客户端已完成，服务端只需信任 + 兜底）：只打码
`password/token/secret/authorization/api_key` 字段值、`sk-`/`Bearer` 形态、邮箱、手机号；
路径、命令、URL、对话、工具参数保留原文（这是为了可溯源，不要在服务端再做激进脱敏）。

## 3. 存储布局

```
/coomi/feedback/store/
  ├─ 2026-09/                       # 按月分目录
  │   └─ <feedback_id>/
  │       ├─ payload.json           # 原始 payload（含 schema 字段）
  │       ├─ index.json             # 服务端生成：时间/渠道/版本/摘要/状态
  │       └─ attachments/           # multipart 附件（截图等）
  └─ _dedup/<feedback_id>           # 幂等去重标记
```

- **v1 兼容**：无 `schema` 字段的 payload 写入 `2026-09/legacy/<timestamp>-<hash>/`，
  原有处理逻辑不变，存量数据不迁移。
- 幂等：`feedback_id` 重复 POST 直接返回成功（Outbox 重发不产生重复记录）。

## 4. API 变更（全部增量）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/coomi/feedback/api` | POST | 保持兼容；按 schema 字段分流 v1/v2 |
| `/coomi/feedback/api/stats/dau` | POST | 不变 |
| `/coomi/feedback/api/admin/list?token=…&limit=…&channel=…` | GET | **新增**：迭代管线读取反馈清单（返回 index.json 摘要数组） |
| `/coomi/feedback/api/admin/get?id=…&token=…` | GET | **新增**：读取单条完整 payload + 附件清单 |
| `/coomi/feedback/api/admin/stats?token=…` | GET | **新增**：按版本/渠道聚合统计 |

- `token`：部署时生成的管理令牌（写入服务器私有配置，不入库不入 git），
  为后续「迭代优化管线」读取反馈清单预留。
- 限流：同一 IP 每分钟 ≤ 30 次 POST；payload ≤ 256KB（multipart 总附件 ≤ 6MB 由客户端保证）。

## 5. 实施步骤（待批准后执行）

1. SSH 只读检查现有 `/coomi/feedback/api` 接收脚本与 nginx 配置，确认运行方式（PHP/Node/CGI）。
2. 备份现有脚本与存量数据。
3. 部署新脚本（建议：接收 → 校验 → 原子落盘 → 返回 `{ok, id}`），保持旧响应格式
   `{ok, detail}` 不变（客户端只看 `ok`）。
4. 生成管理令牌，配置 admin 路由。
5. 灰度验证：用测试 payload（v1 + v2 各一）POST，检查落盘结构与 list 接口。
6. 观察一周后，把「迭代管线」的采集任务指向 `/admin/list`。

## 6. 与迭代管线的衔接（后续工作，本轮不实施）

- 管线第一步「采集反馈信息」= 定时拉 `/admin/list` → 纠错/归并 → 生成问题清单。
- `lessons`（经验沉淀）的跨用户聚合：服务端按 `(category, normalized(symptom))`
  聚合后通过 future `/admin/lessons` 下发，本期客户端只上传本地经验，不下发。
