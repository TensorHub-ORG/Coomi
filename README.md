# Comax

<p align="center">
  <img alt="release" src="https://img.shields.io/badge/release-v1.5.0o6-2563eb?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-0f766e?style=flat-square" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Android%207.0%2B-16a34a?style=flat-square&logo=android&logoColor=white" />
  <img alt="agent" src="https://img.shields.io/badge/agent-Comax-7c3aed?style=flat-square" />
  <img alt="backend" src="https://img.shields.io/badge/backend-Rust-ef4444?style=flat-square&logo=rust&logoColor=white" />
  <img alt="frontend" src="https://img.shields.io/badge/frontend-Vue%203%20%2B%20Vite-42b883?style=flat-square&logo=vuedotjs&logoColor=white" />
  <img alt="local first" src="https://img.shields.io/badge/local--first-full%20control-334155?style=flat-square" />
</p>

**Comax** 是基于 [Coomi](https://github.com/TensorHub-ORG/Coomi) 深度魔改的 Android 本地优先智能体（Agent）平台：
内置 Rust 智能体引擎、终端式虚拟环境、可扩展的 SKILL / MCP 工具链和 Vue 对话界面。模型服务可自定义配置，会话与文件只留在设备本地，Agent 可以真实执行命令、读写文件、识别图片、操控屏幕并展示结果。

> 本项目是 Coomi 的分支 / 魔改版，在保留上游全部能力的基础上，为个人与群体使用体验做了大量增强（见下方「魔改特性」）。

## 官网与下载

<p align="center">
  <a href="https://api.monai.ccwu.cc/coomi/"><strong>🌐 官网 · 下载最新 APK & 源码</strong></a>　·　
  <a href="https://qm.qq.com/q/2JVYVRKnBe"><strong>💬 QQ 交流群 1108467806</strong></a>
</p>

- 最新版：**v1.5.0o6**（versionCode 73）
- 官网：https://api.monai.ccwu.cc/coomi/
- GitHub：https://github.com/maxtwin114514/comax

## 魔改特性（相对上游 Coomi）

- **控制模式**：主动申请无障碍权限 + 桌面悬浮窗（可收起成悬浮球），Agent 可以真实操控屏幕（点击 / 滑动 / 输入），任务规划与工具调用过程悬浮在屏幕上方实时显示；悬浮窗内置输入框，支持唤起输入法。
- **DeepSeek 官方登录**：深度适配 chat.deepseek.com 账号体系（会话 UUID、`model_type` 兼容、风控 PoW 走官方 `librscrypto.so` 求解），登录请求节流串行、错误码逐条中文翻译，降低封号风险。
- **上下文压缩增强**：压缩摘要按「已完成 / 进行中 / 待办 / 关键上下文」分段，避免重复执行已完成的任务。
- **界面体验**：轮转粒子空态、发送水滴动画、工具卡片左侧划入、三横杠 Morphicons 折叠、极简界面模式、模型选择跟随会话、流式渲染防闪烁。
- **控制台捐赠者计划**：原生控制台内置捐赠入口与 QQ 交流群跳转。

## 业务能力

- **本地智能体引擎**：内置 Rust 引擎（`coomi`），对话、工具执行、会话存储全部在设备本地完成，仅模型请求发往你配置的 Provider。
- **真实终端环境**：内置 Termux 兼容虚拟环境与包管理器，Agent 可执行 shell 命令、读写文件、管理目录，而不是纸上谈兵。
- **多 Provider 模型配置**：支持 OpenAI 兼容、Anthropic、Gemini 等协议，可自定义 base URL 与模型列表，按需开启联网搜索、图像理解等能力。
- **图像理解与展示**：支持视觉模型的 `view_image` 真实读图（OpenAI 兼容 `image_url` 协议），以及面向任意模型的 `show_image` 大图展示，点击全屏预览、保存到相册或下载目录。
- **SKILL / MCP 生态**：Agent 可自行安装 SKILL 与 MCP 服务，管理面板支持停用（文件保留可恢复）或彻底删除，已配置的 MCP 会注入系统提示供 Agent 直接调用。
- **可靠的会话管理**：切换会话不中断任务、运行状态实时显示、草稿按会话独立保存、断线审批缓存补发、按最后一轮执行时间排序。
- **上下文压缩与长会话**：智能 token 估算避免误压缩，压缩后本地缓存完整历史可回溯；长会话窗口化渲染、上滑动态加载，流畅不卡顿。
- **大文件分段读取**：`read_file` 默认只读前 64 KiB，支持按行偏移分批继续读取，超长单行自动截断。
- **三档主题**：跟随系统 / 明亮 / 夜间，对话界面、控制台、引导页全链路统一，原生状态栏联动。
- **隐私与授权可控**：手机存储访问默认关闭，开启时联动系统授权；引擎单实例锁防止多实例串扰；更新检查为手动触发，升级保留全部会话、环境与配置。

## 快速开始

1. 从[官网](https://api.monai.ccwu.cc/coomi/)下载最新 APK（`Comax-*-complete-signed.apk`），安装到 Android 7.0+ 的 ARM64 设备。
2. 打开 App，完成引导：配置模型服务商（Provider）与 API Key，或先跳过、稍后在「对话设置 → Provider 配置」中填写。
3. 进入对话界面，向 Agent 下达任务——它可以执行命令、读写文件、识别图片、管理 SKILL/MCP，甚至操控屏幕。

> 升级请直接在 App 内「检查更新」或覆盖安装新 APK，会话记录、虚拟环境与 API Key 全部保留；卸载 App 会清空设备本地数据，非必要请勿先卸载再安装。

## 项目结构

```text
Comax-Android/
├─ apps/coomi-app/        # Android 应用壳（Termux 环境、WebView、更新安装器、控制台、悬浮窗/无障碍）
├─ apps/coomi-rs/         # Rust 智能体引擎（engine / services / tools / ui）
│  ├─ engine/             # 会话、上下文、Agent 循环
│  ├─ services/           # Provider 适配与消息序列化（含 DeepSeek 官方登录）
│  ├─ tools/              # 内置工具（shell、read_file、view_image、show_image、ui_automation、SKILL/MCP 管理等）
│  └─ ui/                 # coomi serve：本地 HTTP/WebSocket 服务
├─ apps/web/              # Vue 3 + Pinia 对话前端（打包为 web.zip 内嵌）
├─ assets/                # 项目 LOGO 与吉祥物
├─ docs/assets/           # README 展示截图
├─ deploy/                # 发行部署（官网 index.html、更新源 latest.json）
└─ tools/                 # 开发辅助脚本
```

## 构建

参见仓库内 `docs/` 与各模块说明；主要工具链：Android SDK（API 34）、Rust stable-aarch64-linux-android、Node 22 + Vue 3/Vite。

## 许可证

本项目采用 Apache License 2.0 许可证。详细条款请阅读 [LICENSE](LICENSE)。

## 致谢

- 上游项目：[Coomi](https://github.com/TensorHub-ORG/Coomi)（Apache-2.0）
- Copyright 2026 Septemc and TensorHub（上游）；Comax 魔改部分 Copyright 2026 晚风