# 社区注册表与匿名统计

Coomi 的「市场」是 TensorHub 社区注册表（[coomi-registry](https://github.com/TensorHub-ORG/coomi-registry)）的 App 内入口。本页说明它的工作方式与隐私边界。

## 市场（SKILL / MCP / Workflow）

- **内容在哪**：所有 SKILL / MCP / Workflow 都托管在**贡献者自己的公开 GitHub 仓库**中。社区注册表只保存元数据（名称、描述、仓库链接），App 市场页展示这些条目，安装时直接从贡献者仓库拉取。
- **如何提交**：在 [coomi-registry](https://github.com/TensorHub-ORG/coomi-registry/issues) 用提交表单（Issue 模板）填写信息，维护者审核后合入。审核标准与下架流程见仓库的 [CONTRIBUTING.md](https://github.com/TensorHub-ORG/coomi-registry/blob/main/CONTRIBUTING.md)。
- **数据链路**：App 引擎每 10 分钟拉取一次注册表与统计（走 jsDelivr 镜像兜底）；注册表不可达时市场显示为空，不影响本地任何功能。

## 热度统计

市场条目展示两类热度指标：

| 指标 | 来源 | 说明 |
|---|---|---|
| stars / 30 天下载量 | GitHub 公开 API | 注册表仓库每日自动刷新 |
| 周安装 / 累计安装 | App 匿名打点 | 见下方隐私说明 |

安装量统计点位于引擎安装服务层——无论是你手动点击安装，还是 Agent 自己安装，都会被计入同一统计维度。

## 隐私说明（匿名使用统计）

- 只上报**事件类型 + 技能标识**（如 `install_ok` + `owner/repo`），用于计算安装量与使用量。
- **不含**任何对话内容、文件内容、设备标识或身份信息。
- 事件先在本地缓冲，达到阈值后批量上报，上报失败自动保留重试。
- 可在「设置 → 隐私 → 匿名使用统计」随时关闭；关闭后立即停止缓冲与上报。

## 下载官网

官方 APK 下载页与更新检查独立于社区注册表，见官网与 App 内「检查更新」。
