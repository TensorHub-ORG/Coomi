# Coomi 环境契约（单一事实源）

> 批次八 2.2 产物。本文档是 Coomi Android 环境行为的**唯一权威描述**：代码（backend 实现、PathMapper）与提示词（engine 模板、Skill）均以此为准。修改任何环境行为必须先改本文档。
> 最后核对：2026-09-07（v1.4.6-test.4 时代，main 分支；底座已切换为 Ubuntu 24.04 noble）。

## 一、环境清单

| 环境 | 归属 | 对模型的可见性 | 用途 |
|------|------|----------------|------|
| **proot Debian guest** | 引擎托管（Runtime V2） | ✅ 唯一 Agent 执行环境 | 所有 shell/local_shell 命令、Linux 工具链 |
| Termux 用户域 | Android 壳（内置 Termux） | ❌ 不对模型暴露（仅内部引导） | 引擎自举、coomi CLI/TUI、APK 内安装 |
| Android host | 引擎进程本身 | ❌ 不对模型暴露 | 文件工具（read_file 等，经 PathMapper）、导出 |

规则：`shell`/`local_shell` 的 `environment` 参数只允许 `auto|proot`；`auto` 即 proot guest。termux/host 后端代码保留供内部引导，不进入工具 schema。

## 二、路径视图（PathMapper 双向映射）

| guest 路径 | 宿主真实路径 | 说明 |
|------------|--------------|------|
| `/workspace` | Android 工作目录（会话 cwd） | 当前工作区，双向读写 |
| `/home/coomi` | `<home>/runtime-v2/home` | 持久 guest home（SSH 配置、pip --user、custom_coomi） |
| `/opt/coomi-dev` | `<home>/runtime-v2/coomi-dev` | 构建工具包 |
| `/tmp` | `<home>/runtime-v2/tmp` | 临时目录 |
| `/usr/local/bin/proot` | Runtime V2 校验过的 proot 二进制 | guest 内再入 proot 用 |

规则：
- Agent shell 一律用 guest 路径；内置文件工具/导出用宿主绝对路径。两者经 `RuntimePathMap` 自动转换，禁止手工猜测（如拼 `/workspace/.coomi/...`）。
- 工具结果同时携带 `host_path`/`guest_path` 时（`paths_guest`），shell 用 guest 路径、文件工具用宿主路径。

## 三、guest 能力基线（完整 Ubuntu 档，批次八 ①）

- 发行版：**Ubuntu 24.04 LTS (noble)**（glibc, ARM64），proot 运行，guest 内 root 视角；important 变体（常规 Ubuntu 用户空间，对齐 Operit 的完整发行版模式）。
- 包管理：`apt`，universe 组件已启用，运行时源为清华 TUNA ubuntu-ports；缺命令 `apt install <pkg>`。
- 预装：git、curl/wget、nodejs+npm、python3(+pip/venv)+aiohttp/numpy、**build-essential/cmake/pkg-config**（C/C++ 工具链开箱即用）、openssh-client、iputils-ping、iproute2、net-tools、sqlite3、unzip/zip/tar/xz/bzip2、jq、patch、diffutils、gawk、procps、findutils、file、less、tree、htop、tmux、rsync、nano/vim-tiny、man-db、bash-completion、sudo、locales(en_US/zh_CN UTF-8)。
- JDK 等重型专用链不进 base（体积控制），由 env-templates Skill 按需 `apt install`。
- PATH（guest 内固定注入，不依赖 .profile）：`/home/coomi/.local/bin:/home/coomi/bin:/opt/coomi-dev/current/bin:/opt/coomi-dev/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`。
- 可写：整个 guest 文件树（root 视角，含 /etc——改动只影响 guest 镜像，不影响 Android）；宿主侧挂载以上表为准。
- 网络：直连 HTTP(S)；guest DNS 预配 223.5.5.5 / 119.29.29.29 / 8.8.8.8。
- full 档（规划，见批次八 3.2）：base + build-essential + JDK 等构建链，按需扩容。

## 四、错误反馈契约

- 上游供应商错误：归因前缀「【上游供应商问题】」+ 中文原因 + 可执行建议 + 脱敏后的上游 error.code/message 原文。
- 网络链路错误：「【网络问题】」+ 归因说明（非软件故障）。
- shell 错误：结构化自纠提示（127 缺命令→apt install；126 架构/权限；Permission denied→可写目录）。
- 超时：返回已产生输出 + 引导 local_shell exec/wait，进程组清理。
- 每条 shell 结果尾部带 `[env: ...]` 环境标记。

## 五、运行时分发契约

- 镜像构建：`scripts/runtime-v2/build-rootfs.sh`（mmdebstrap + snapshot 可复现 + SOURCE_DATE_EPOCH）；产物 `debian-bookworm-arm64.tar.gz` + `.sha256` + `.size`。
- 清单：`create-manifest.sh` → `runtime-v2-manifest.json`（runtime_version、architecture、proot_commit、host/rootfs 的 url/sha256/size、environment 变量）。
- 安装：`RuntimeManager::download_artifact` 断点续传 + SHA-256 校验 + `.staging` 原子安装；`RuntimeState.previous_version` 支持回滚。
- APK 内嵌归档是**首启兜底种子**；在线路径走 manifest URL 更新。

## 六、模板体系（3.3）

`env-templates` 内置 Skill（随包分发、默认安装、可停用）提供三套环境初始化模板：`python-web`、`node-web`、`android-build`。Agent 通过 read_skill 获取脚本内容，一次命令完成整套环境配置；已知 proot 兼容性 workaround 固化在模板内（不要求模型临场发现）。

## 七、变更纪律

1. 修改 PATH/挂载/预装清单 → 先改本文档，再改 `build-rootfs.sh` / `runtime.rs`。
2. 新增环境暴露面（对模型）→ 必须经过讨论，防止回到"三世界并存"。
3. 每次发布前用 `runtime_doctor` 探测结果对照第三节基线。
