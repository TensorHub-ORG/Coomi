# Coomi Desktop 打包流程(Windows)

自包含、可移植的 server payload 构建 + electron-builder NSIS 打包。

## 前置

- 主仓库已构建:`pnpm run build`(生成 apps/cli/lib 与全部包的 lib/,apps/web/dist)
- desktop 依赖已安装:`npm install`(desktop/)

## 步骤

```powershell
# 1. 构建 server payload(desktop/release-payload/server)
#    - 复制源树(排除 node_modules/.git/dist/lib)
#    - pnpm-workspace.yaml 加 nodeLinker: hoisted(扁平化,无 junction)
#    - 去掉根 postinstall(lefthook 是 dev 依赖,--prod 下必然失败)
#    - pnpm install --prod
#    - 补拷 apps/cli/lib、apps/cli/config、apps/web/dist
#    - node scripts/materialize-payload.mjs <payload>   # junction → 真实目录
#    - node scripts/populate-root-coomi.mjs <payload>   # 工作区包补齐到根 @coomi
#    - 手动补 @coomi/node-addon-landlock-run(三层路径包)
#    - 删冗余嵌套 node_modules 与源树(瘦身)

# 2. 打包
cd desktop
npm run dist
# 产物:release/Coomi-Setup-<version>.exe(NSIS 安装包)
```

`electron-builder.yml` 的 `afterPack: scripts/after-pack.cjs` 在打包阶段把
`release-payload/server` 整体拷入 `win-unpacked/resources/server`(extraResources
会静默丢弃 node_modules,故用 afterPack 直拷)。钩子随后用当前仓库的工作区
`lib/`、CLI 配置和 Web `dist/` 覆盖 payload,并检查关键桌面界面标志,避免复用
payload 时把旧客户端插件封装进安装包。

## 关键坑位(已踩平)

| 问题 | 原因 | 解法 |
|---|---|---|
| pnpm 工作区 node_modules 不可移植 | Windows junction 存绝对路径 | payload 内 `nodeLinker: hoisted` + 物化 junction |
| hoisted 下工作区传递依赖解析失败 | hoisted 不提升工作区包 | `populate-root-coomi.mjs` 把全部 @coomi 包复制到根 node_modules |
| electron-builder 解析 ICO 失败 | 手写 ICO 头字段错误 | png-to-ico + 256px 预处理 |
| NSIS 拒绝 ICO | png-to-ico 输出超大条目 | 先缩到 256px 再生成 |
| extraResources 丢 node_modules | electron-builder 默认忽略 | afterPack 钩子直拷 |
| payload 缺 lib/dist | robocopy 排除目录 | 单独补拷 |
| `nodeLinker` 配置不生效 | pnpm 11 移到 pnpm-workspace.yaml | 写 workspace yaml |

## 运行

- 开发:`cd desktop; npm start`(源码形态,spawn 内置服务 + 窗口)
- 打包版:`release/win-unpacked/Coomi.exe` 或安装 `Coomi-Setup-0.1.1.exe`
- 数据目录:`%APPDATA%\Coomi\home`(COOMI_HOME,与 CLI 隔离)
