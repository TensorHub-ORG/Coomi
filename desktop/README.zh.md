# Coomi Desktop

[English](README.md) | 中文

Coomi Desktop 是承载外部可编辑 Coomi 源码目录的轻量 Electron 外壳。安装包提供桌面集成和固定版本的 Node/pnpm 工具链；agent 代码、插件与 Web UI 仍是安装目录外的普通文件。

## 运行时结构

- `src/main.cjs` 管理窗口、托盘、源码进程生命周期、首次运行设置和源码检查点。
- `src/runtime-source.cjs` 校验并准备 Git 源码目录、执行 Git 操作并写入 diff 检查点。
- `src/client-boot.cjs` 在插件 UI 就绪前隐藏窗口，并识别可恢复的冷启动失败。
- `src/preload.cjs` 仅暴露设置／源码 API，并让 Windows 标题栏 overlay 与 Web 主题同步。
- `resources/` 保存生成的应用图标；`electron-builder.yml` 定义 Windows NSIS 安装包。

选定的源码目录通过自身的 `tsx` ESM hook 运行 `apps/cli/src/bin.ts`。Coomi 数据保存在 `%APPDATA%\Coomi\home`，源码目录则留在用户选择的位置。客户端就绪后，外壳启动 Web 包轮询 watcher，因此修改客户端插件会重新构建并加载，无需重新封装桌面应用。

## 开发

首次准备源码目录：

```powershell
pnpm install
pnpm run build
cd desktop
npm install
```

从源码启动外壳：

```powershell
cd desktop
npm start
```

首次启动时，选择已经准备好的 Coomi 源码目录，或选择一个空的父目录来安装官方 `coomi-desktop` 分支。设置窗口可以使用内置工具链为所选源码目录安装依赖并执行构建。托盘操作可以打开或切换源码目录、重启源码运行时，并把检查点保存到 `%APPDATA%\Coomi\changes`。

## 品牌资源

[`../assets/coomi-desktop.png`](../assets/coomi-desktop.png) 是唯一的透明背景品牌源文件。修改后在 `desktop/` 中运行 `npm run sync:brand`；该命令会重新生成应用 PNG 尺寸、多尺寸 Windows ICO 和 Web 内联标志。命令可重复执行，封装前必须运行。

## 打包

```powershell
cd desktop
npm run sync:brand
npm test
npm run dist
```

安装包输出到 `desktop/release/Coomi-Setup-<version>.exe`。它只包含外壳文件、生成的资源和固定版本的 Node/pnpm 运行时，不包含 server payload，也不复制 `apps/`、`packages/` 或 `vendor/`。Windows 发行检查见 [BUILD.md](BUILD.md)。
