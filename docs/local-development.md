# Windows 本机开发

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev/local.ps1 -OpenBrowser
```

脚本构建真实 Rust 引擎，启动 `127.0.0.1:8765` 后端和 `127.0.0.1:5173` Vite 前端。Vue 修改会热更新；Rust 修改后停止并重新启动，Cargo 增量编译。不需要打包 APK。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev/local.ps1 -Action Status
powershell -ExecutionPolicy Bypass -File scripts/dev/local.ps1 -Action Stop
```

数据位于 `.local-plans/dev/home`，测试文件位于 `.local-plans/dev/workspace`，日志位于 `.local-plans/dev/logs`。npm、pip、Gradle 和临时缓存写入 `.local-plans/dev/cache` / `tmp`；使用现有 E 盘 Rust 工具链，构建产物留在 `apps/coomi-rs/target`。脚本拒绝从 C 盘项目启动，不自动安装 Android rootfs、WSL 或浏览器。

首次打开「本机 Pi」配置页，模型已预填服务端确认的完整 ID `deepseek-v4.1-flash-1017`。填入 Pi 的实际 Base URL 和 API Key，核对协议，保存并设为当前服务商。默认协议为 OpenAI Compatible，如 Pi 使用其他协议，应在页面选择对应类型。模型 ID 必须与服务返回的 ID 完全一致。已有配置在重启时保留。脚本不读取 Pi 或其他应用的凭据，也不自动发送模型请求。

前端 `/api` 和 `/ws` 通过 Vite 同源代理转发到真实引擎；保留引擎的认证和 WebSocket 来源检查。独立 Edge 配置保存在 E 盘，不影响日常浏览器配置。启动地址携带本地引擎令牌，页面读取后清除地址栏令牌，并在开发标签页内保留认证，以支持刷新；它与模型 API Key 不同。

关闭浏览器后可重跑带 `-OpenBrowser` 的启动命令；服务已在运行时会直接打开。Rust 修改后停止再启动：

```powershell
# 服务已运行时，先停止再启动可更新 Rust 并重新打开配置页。
powershell -ExecutionPolicy Bypass -File scripts/dev/local.ps1 -Action Stop
powershell -ExecutionPolicy Bypass -File scripts/dev/local.ps1 -OpenBrowser
```

Windows 下聊天、工作流、协作及 CLI 的默认命令使用 Windows PowerShell 5.1（不是 PowerShell 7）；两个 shell 工具统一使用 UTF-8 输出，PowerShell 错误默认终止后续命令并报告失败，保留最后一个原生命令的非零退出码。本机文件工具、模型请求、会话和工作流均是真实服务。Android 权限、WebView 键盘、悬浮窗、后台保活和 Termux/PRoot 仍需真机回归。停止本机服务会中断活动任务；重启后核对检查点再恢复。
