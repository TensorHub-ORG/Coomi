# Coomi Desktop

Electron 桌面壳,承载 Coomi agent harness(由 DeepSeek Harness 全面改名套壳而来)。

## 结构

- `desktop/` — Electron 工程(独立于 pnpm workspaces,使用 npm 安装依赖)
  - `src/main.cjs` — 主进程:spawn 内置 `coomi --profile web --port 0` 服务,解析就绪 URL 后加载窗口;退出时终止子进程
  - `src/preload.cjs` — 版本信息桥与 Windows 标题栏布局/主题同步;渲染层业务仍走 HTTP/WS
  - `resources/` — 透明背景应用图标(`coomi-agent.png`、`coomi-256.png`、`coomi.ico`)
  - `electron-builder.yml` — Windows NSIS 打包配置
- 其余目录 — 改名后的 Coomi monorepo(`coomi` CLI、`@coomi/coomi-*` 包、Web GUI)

## 运行(开发)

```powershell
# 1. 先构建 monorepo(生成 apps/cli/lib 与 apps/web/dist)
pnpm install
pnpm run build

# 2. 安装并启动桌面应用
cd desktop
npm install
npm start
```

窗口加载 `http://127.0.0.1:<port>`(端口由系统分配);用户数据(profiles、会话、凭据)存放于 Electron `userData/home`(即 `COOMI_HOME`),与 CLI 安装隔离。

Windows 使用 38px 原生 window-controls overlay:侧边栏的透明品牌标志、名称与收起按钮位于带底部分隔线的标题栏左侧,右侧保留系统最小化、最大化和关闭按钮。侧栏收起后只保留可点击的品牌标志。preload 为该区域预留页面高度,把 Web 主题的最终背景色和文字色同步给主进程,并在设置等模态窗口打开时同步遮罩色;标题栏在窗口失去焦点时不切换颜色。

## 打包

```powershell
cd desktop
npm run dist   # 生成 release/Coomi-Setup-<version>.exe(NSIS 安装包)
```

注意:打包会把自包含 server payload 作为运行时资源带入,安装包体积较大。
`afterPack` 会用当前仓库的构建输出覆盖 payload 中的工作区产物并校验关键界面
标志,因此封装前必须先运行 `pnpm run build`。

## 运行形态说明

- v1:本地 loopback HTTP 服务(与浏览器形态完全一致:fetch + WebSocket 下行、`__COOMI_BOOT__` 注入、信任围栏均原样工作)。
- 未来:上游设想形态为 `file://` + IPC 桥(webserver 注释所述),需自建 fetch/WebSocket 双桥,列为 v2。
