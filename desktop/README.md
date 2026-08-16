# Coomi Desktop

Electron 桌面壳,承载 Coomi agent harness(由 DeepSeek Harness 全面改名套壳而来)。

## 结构

- `desktop/` — Electron 工程(独立于 pnpm workspaces,使用 npm 安装依赖)
  - `src/main.cjs` — 主进程:spawn 内置 `coomi --profile web --port 0` 服务,解析就绪 URL 后加载窗口;退出时终止子进程
  - `src/preload.cjs` — 最小 preload 桥(版本信息;当前形态渲染层走 HTTP/WS,无需 RPC 桥)
  - `resources/` — 应用图标(`coomi-agent.png`、`coomi.ico`)
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

## 打包

```powershell
cd desktop
npm run dist   # 生成 release/Coomi-Setup-<version>.exe(NSIS 安装包)
```

注意:打包会把整个 `node_modules` 作为运行时资源带入(`extraResources`),体积较大;这是 v1 的简化方案。

## 运行形态说明

- v1:本地 loopback HTTP 服务(与浏览器形态完全一致:fetch + WebSocket 下行、`__COOMI_BOOT__` 注入、信任围栏均原样工作)。
- 未来:上游设想形态为 `file://` + IPC 桥(webserver 注释所述),需自建 fetch/WebSocket 双桥,列为 v2。
