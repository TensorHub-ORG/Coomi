# Coomi 套壳改名记录(Rebrand Map)

本项目由 DeepSeek Harness 全面改名套壳而来。本文记录改名映射,便于日后维护与审计。

## 命名映射

| 原(DeepSeek Harness) | 现(Coomi) | 说明 |
|---|---|---|
| `DeepSeek Harness`(产品名) | `Coomi` | 所有 UI 文案、标题、欢迎弹窗 |
| `@deepseek-ai/dsh-*`(npm scope + 前缀) | `@coomi/coomi-*` | 全部约 200 个包,如 `@coomi/coomi-llm` |
| `@deepseek-ai/cordis*`、`@deepseek-ai/schemastery` 等 vendored 包 | `@coomi/cordis*`、`@coomi/schemastery` | 供应商 rescope 同步改名 |
| `dsh`(CLI / 命令 / 标识符) | `coomi` | `coomi --profile web`、`coomi web:` URL 行 |
| `DSH_*` 环境变量 | `COOMI_*` | `COOMI_HOME`、`COOMI_WEB_URL`、`COOMI_SNAPSHOT`、`COOMI_BUILD_FACE`… |
| `__DSH_BOOT__` | `__COOMI_BOOT__` | index.html 引导注入 |
| `--dsw-*` CSS 变量 | `--coomi-*` | 主题 token,如 `--coomi-alias-bg-base` |
| `--dsw-static-deepseek-*` 品牌色阶 | `--coomi-static-brand-*` | 数值改为 Coomi 蓝(#2D61C6 锚定) |
| `data-ds-dark-theme` | `data-coomi-dark-theme` | 暗色主题属性 |
| `deepseek-harness`(仓库路径/URL) | `coomi-desktop` | GitHub 地址: `github.com/coomi/coomi-desktop` |
| `deepseek_harness_runtime` / `deepseek_harness`(Python) | `coomi_harness_runtime` / `coomi_harness` | SDK 包与模块 |
| `DeepSeekHarness`(Python 类) | `CoomiHarness` | SDK 客户端类 |
| `dsh-badge`、`dsh-code-review` 等内部技能/文件 | `coomi-badge`、`coomi-code-review` 等 | 目录与文件名同步改名 |

## 保留不变(DeepSeek 第三方提供方,按用户决策)

- `llm-deepseek` / `web-search-deepseek` 提供方插件(包名变为 `@coomi/coomi-llm-deepseek`)
- 提供方 ID `deepseek-official`、模型 ID `deepseek-v4-flash` / `deepseek-v4-pro`
- 环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`
- 提供方显示名 "DeepSeek"、`DeepSeekModelsEditor` / `DeepSeekOnboardingDialog` 组件
- `api.deepseek.com`、`deepseek.com` 等提供方 URL
- 设计参考注释(DeepSeek Chat 风格等)

## 品牌资产

- 图标源文件:`Coomi-Android/assets/coomi-agent.png`(975×975,白底 + 品牌蓝 #2D61C6)
- Web favicon:`apps/web/public/favicon.png`(index.html/manifest 引用)
- UI 内 logo:`packages/client/ui-primitives/src/CoomiLogo.tsx` / `CoomiWordmark.tsx`(内联 base64,不依赖静态路由)
- 文档站 wordmark:`website/public/wordmark.svg`
- 桌面应用图标:`desktop/resources/coomi-agent.png` + `coomi.ico`
- 品牌蓝色阶(design-platform.css):
  `50 #F4F8FD → 100 #E1E9F7 → 200 #C9DBF3 → 300 #92BBEF → 400 #5F8ADB → 450 #4472CC → 500 #2D61C6 → 600 #2652A8 → 700 #1E4187 → 800 #173368 → 900 #10244B`

## 桌面应用

- 目录:`desktop/`(独立 npm 工程,不并入 pnpm workspaces)
- 形态:主进程自选空闲端口 → spawn 内置 `coomi --profile web`(stdio ignore,轮询就绪)→ BrowserWindow 加载 `http://127.0.0.1:<port>`
- 数据隔离:`COOMI_HOME = <userData>/home`(Windows: `%APPDATA%\Coomi\home`)
- 打包:electron-builder NSIS(见 `desktop/electron-builder.yml`);注意 v1 将整个 `node_modules`(约 1.3GB)作为运行时资源带入,体积较大
