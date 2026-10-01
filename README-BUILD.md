Coomi 电脑版 1.0.2 · 完整源码包
=====================================

本包包含构建「Coomi 电脑版（Windows）」所需的全部源码。

目录结构
--------
  apps/coomi-rs/          引擎（Rust workspace：engine / services / tools / security /
                          ui / catalogs / telemetry 七个 crate）
  apps/desktop/           Tauri 2 外壳（Rust）+ 打包脚本
  apps/desktop-ui-react/  渲染层（React 19 + TypeScript + Vite）
  tools/mobile-build/     引擎内嵌的 Build Kit 脚本（catalogs crate 用 include_str!
                          直接嵌进二进制，**缺了会编译不过**，不是可选项）
  docs/                   设计与评估文档
  scripts/                构建辅助脚本与版本说明

版本
----
  软件版本      1.0.2          （apps/desktop/Cargo.toml；tauri.conf.json 不写 version，继承之）
  引擎版本      2.1.0          （apps/coomi-rs/Cargo.toml 的 workspace.package）

环境要求
--------
  · Rust stable（含 x86_64-pc-windows-msvc target）
  · Node.js 20+ 与 npm
  · Microsoft Edge WebView2 Runtime（Windows 10/11 一般已内置）

构建步骤
--------
  1) 引擎
       cd apps/coomi-rs
       cargo build --release -p coomi-ui
     产物：target/release/coomi.exe

  2) 前端
       cd apps/desktop-ui-react
       npm install
       npm run build
     产物：dist/

  3) 外壳（beforeBuildCommand 会自动重跑第 2 步并把产物复制进 crate 目录）
       cd apps/desktop
       npm install
       npx tauri build
     产物：
       target/release/coomi-desktop.exe
       target/release/bundle/nsis/Coomi_1.0.2_x64-setup.exe

  注意：apps/desktop/scripts/prepare-bundle.mjs 会把
        apps/coomi-rs/target/release/coomi.exe → apps/desktop/coomi.exe
        apps/desktop-ui-react/dist          → apps/desktop/ui-dist
        tauri.conf.json 的 bundle.resources 只引用这两个**相对路径**，
        所以换机器/换目录都能构建（历史上曾因写死绝对路径导致装不上）。

本包不含
--------
  · 任何构建产物（target/、node_modules/、dist/、预编译的 coomi.exe）
  · Android 端源码（apps/coomi-app、apps/web）
  · 本机配置与密钥

依赖安装
--------
  两个 package.json 都带了完整的 package-lock.json，可以直接：
    npm ci
  直连 npm 官方源慢的话换镜像：
    npm ci --registry=https://registry.npmmirror.com

源码与更新源
------------
  · 源码仓库：https://github.com/TensorHub-ORG/Coomi （分支 coomi-desktop）
  · 更新检查读同分支的 windows/latest.json：
      { code, name, url, size, sha256, channel }
    发布新版本时把安装包与 latest.json 放到该分支的 windows/ 下即可；
    国内加速（gh-proxy / jsDelivr）已在 apps/desktop/src/main.rs 里配好。


