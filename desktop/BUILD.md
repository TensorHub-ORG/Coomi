# Coomi Desktop Windows 打包

本文是轻量桌面外壳的 Windows 发行检查清单。安装包不封装 Coomi 服务端或工作区源码。

## 前置条件

- `desktop/` 已运行 `npm install`。
- 品牌源文件位于 `assets/coomi-desktop.png`，具有透明外部背景。
- 版本号在 `desktop/package.json` 与 `desktop/package-lock.json` 中一致。

## 生成安装包

```powershell
cd desktop
npm run sync:brand
npm test
npm run dist
```

`sync:brand` 从单一品牌源生成 `resources/coomi-agent.png`、`resources/coomi-256.png`、多尺寸 `resources/coomi.ico` 与 Web 内联标志。`dist` 生成 `release/win-unpacked/Coomi.exe`、`release/Coomi-Setup-<version>.exe` 和 blockmap。

## 产物内容

`electron-builder.yml` 只收录 `desktop/src/**` 与 `desktop/resources/**`，并解包安装包内的 Node 与 pnpm 可执行路径。`app.asar` 不应包含 `apps/`、`packages/`、`vendor/` 或 `resources/server`。

外部源码目录必须是 Git 工作区，并包含 `apps/cli/src/bin.ts`、`apps/web/dist/index.html`、`node_modules/tsx/package.json`、根 `package.json` 和 `pnpm-lock.yaml`。首次设置可以下载官方分支，并使用安装包内的 Node/pnpm 执行 `pnpm install` 与 `pnpm run build`。

## 本地验收

1. 安装 `release/Coomi-Setup-<version>.exe`，确认安装目录可以自定义且桌面快捷方式存在。
2. 从安装后的 `Coomi.exe` 提取图标，确认它与 `assets/coomi-desktop.png` 一致且保留透明背景。
3. 启动安装版，确认窗口在插件界面就绪后才显示，且标题栏、托盘、设置页和应用内品牌标志正常。
4. 修改所选源码目录中的客户端插件，确认 watcher 重建并刷新页面，不重新封装安装包。
5. 从托盘保存源码修改记录，确认 `%APPDATA%\Coomi\changes` 中生成 patch 和 manifest，且 Git 暂存区没有变化。
