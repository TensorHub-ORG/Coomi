# Coomi Android v1.4.1

## 更新说明【稳定】

- 统一宿主、Termux 与 ProotLinux 的逻辑路径映射，修复文件、补丁、Shell 和进程工具的固定路径问题。
- 新增运行环境诊断与内置运行环境 Skill，支持 Agent 识别当前环境并在 Termux 与 ProotLinux 间安全切换。
- 修复 Proot 工作区路径转换、工具输出 UTF-8 边界处理和运行时允许目录校验。
- 启用 Android release 资源压缩和精确 R8 保留规则，生产 WebView 包移除调试输出。
- 保留 JNI、WebView bridge 和 Runtime V2 资产的兼容性，并完成前端、Rust 与 Android release 构建验证。

## 安装信息

- 包名：`com.coomi.android`
- 版本号：`1.4.1`
- versionCode：`31`
- 架构：`arm64-v8a`
- 最低系统：Android 7.0
