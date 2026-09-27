# Coomi 反馈查询与统计指南

## 1. 数据位置与安全

反馈服务目录：`/www/wwwroot/updates.septemc.com/coomi/feedback`。
正式记录在 `data/error_*.json`；图片在 `attachments/<反馈 id>/`；`data/rate_*.tmp` 是限流状态，不能计入反馈数。
服务器访问凭据只保存在 SSH 配置文件中，不要复制到仓库、日志、截图或聊天记录。

## 2. 一键统计

在仓库根目录执行：

```powershell
python scripts/analyze_coomi_feedback.py `
  --ssh-config "F:\_WorkSpace\Projects\AILab\SSH-Agent\ssh-configs\ssh-8.148.146.68-2C2G-阿里云.txt" `
  --output feedback.csv
```

脚本通过 SFTP 读取 `error_*.json`，兼容 `diagnostics` 为对象或 JSON 字符串的旧记录，输出分类计数，并可导出规范化 CSV。首次使用前确认本机安装 `paramiko`：`python -m pip install paramiko`。

## 3. 管理页查询

浏览器打开 `https://updates.septemc.com/coomi/feedback/admin`，使用服务器 `admin_config.json` 或环境变量 `ADMIN_PASSWORD` 对应的管理员密码登录。

管理 API：

- `GET /coomi/feedback/admin/api/list?limit=200&q=关键词`：按时间倒序列出记录。
- `GET /coomi/feedback/admin/api/detail?id=error_....json`：读取单条原始 JSON。
- `GET /coomi/feedback/admin/api/attachment?id=反馈id&name=文件名`：读取附件，需要管理员 token。

不要把 `ip` 字段用于产品画像；它只用于服务端限流和排障。`message` 是主摘要，`detail` 是补充信息，`diagnostics` 用于版本/设备聚合，`provider`、`model` 用于定位上游兼容性。`attachments` 只记录安全文件名、MIME 和大小；图片内容必须通过鉴权接口读取。

`reasoning_statistics` 默认包含全部五档（`auto/low/medium/high/xhigh`）平均统计。每档字段含 `turns`、`cache_available`，并在数据可用时包含 `cache_hit_rate`、`average_duration_ms`、`average_total_tokens`。

- 均轮命中读取 `cache_hit_rate`；`cache_available=false` 时记为“暂无缓存数据”。
- 均轮耗时读取 `average_duration_ms`。
- 均轮用量读取 `average_total_tokens`。
- 不要对各轮百分比做算术平均；缓存命中必须按 Token 加权。

## 4. 统计口径

按 `received_at`（缺失时使用 `time`）统计时间；按 `diagnostics.version_name` 统计版本。分类规则优先匹配具体错误：测试探针、工具轮次上限、上下文/压缩、鉴权失败、限流/模型繁忙、网络/上游/流式中断、协议兼容/消息格式、模型配置/能力不匹配、余额不足、其他请求参数错误。

每次统计应记录：统计时间、记录总数、剔除的测试探针数、分类计数、版本分布、Top provider/model、已确认重复事件。不要仅按字符串去重；同一上游故障可能在不同时间产生不同记录。

## 5. 基线说明（2026-08-12）

早期检查时记录数为 102，随后持续有用户反馈写入；因此不要把静态总数当作当前值。每次分析都必须重新运行脚本，并同时记录查询时间、总记录数、剔除探针数和真实记录数。

真实错误中最突出的信号：`provider stream failed` 23 条；工具轮次上限 7 条；直接访问 DeepSeek 失败 7 条；限流/模型繁忙至少 8 条；上下文过长或压缩失败至少 6 条；消息/工具协议兼容问题至少 10 条。另有鉴权失败、模型能力误配、余额不足等低频但高影响事件。

## 6. 迭代计划

1. **P0：流式与上游可观测性**。统一区分连接失败、超时、上游 5xx、解析失败；增加重试退避、请求 ID 和用户可见的下一步。验收：同类错误不再全部显示为 `provider stream failed`。
2. **P0：消息协议归一化**。在发送前校验 assistant/tool 消息、`image_url`、工具参数 JSON，以及 Responses/Chat Completions 能力矩阵。验收：400 错误能指出具体消息索引和修复建议。
3. **P1：上下文治理**。压缩前估算 token，超限时分段摘要并保留工具调用闭环；工具轮次达到阈值时提供继续/总结选项。验收：长会话不因单个 image/tool 内容直接失败。
4. **P1：Provider/模型配置防错**。模型列表按能力（文本、图像、ASR、TTS、Responses）标注并在保存时校验；API Key 做连通性检查但不回传密钥。验收：模型不匹配在发送前被阻止。
5. **P1：反馈闭环**。使用控制台“反馈建议”收集主动建议/问题，定期将高频类别转为回归测试；保留版本与设备诊断但不上传对话或 API Key。
6. **P2：限流与余额提示**。识别 429/402，展示供应商、重试时间和切换模型入口；统计按 provider/model 计算失败率。

每周运行一次脚本，将 CSV 与上周按分类、版本、provider 对比；只有在错误率和复现用例同时下降后才关闭对应计划项。

## 7. 下次直接执行提示词

```text
请使用 F:\_WorkSpace\Projects\AILab\SSH-Agent\ssh-configs\ssh-8.148.146.68-2C2G-阿里云.txt 连接服务器，只读取 /www/wwwroot/updates.septemc.com/coomi/feedback。先阅读 F:\_WorkSpace\Projects\Coomi-Android\docs\coomi-feedback-guide.md，再运行 scripts/analyze_coomi_feedback.py 导出 CSV。不要输出、提交或记录 SSH 密码、管理员密码、API Key 和完整 IP。

请给出：查询时间、JSON 总数、测试探针数、真实反馈数；按错误类别、App 版本、provider/model 的分布；最近 7 天趋势；高频消息聚类；带附件反馈数；五档推理强度的均轮命中（Token 加权）、均轮耗时、均轮用量，并将无缓存字段的记录显示为“暂无缓存数据”而不是 0%。结合上一轮基线指出新增、下降和仍未解决的问题，最后按 P0/P1/P2 输出可验证的迭代计划。除非我明确要求，不修改远端数据、服务或管理页。
```
