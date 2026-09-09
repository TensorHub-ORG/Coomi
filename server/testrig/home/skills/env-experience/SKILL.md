---
name: Env Experience
description: Coomi guest 环境的实战经验与避坑清单——执行 shell 前先读我，可显著减少环境类报错（缺命令/权限/超时/路径错乱）。
keywords: [经验, environment, 避坑, apt, pip, proot, ubuntu, 超时, 权限, 报错]
tools: [shell, local_shell, read_file, write_file]
---

# Env Experience（环境实战经验）

在 Coomi guest（Ubuntu 24.04 proot）里干活前，记住这些经验——它们来自真实用户报错。

## 环境事实（先记住再动手）

- **Ubuntu 24.04 (noble)，glibc/ARM64**，proot guest，root 视角。每条 shell 结果尾部的 `[env: ...]` 标记可确认。
- shell 是**非交互执行**：不读 `.profile`/`.bashrc`。PATH 已由引擎注入（含 `/home/coomi/.local/bin`），但你在 `.bashrc` 里写的别名/函数在这里**不可用**。
- 可写：整个 guest 树（含 /etc，但改动只影响 guest）。工作产物放 `/workspace`（宿主可见、可导出）。
- apt 源已配清华 TUNA；pip 换 TUNA、npm 换 npmmirror（见 Env Templates Skill）。

## 高频坑与规避（按报错率排序）

1. **缺命令（exit 127）**：先 `command -v <cmd>` 探测；缺失直接 `apt install -y <包名>`（先 `apt update` 一次更稳）。不要用 pip 装系统工具（unzip/jq 等走 apt）。
2. **超时误杀**：超过 30s 的命令（构建/安装/下载）**必须**用 `local_shell` exec（`yield_time_ms: 0`）+ wait 模式；`shell` 工具超时会被清理。apt 操作前先 `apt update`。
3. **内存受限**：guest 内存有上限。Gradle/大构建用 `--no-daemon` + 低堆（`-Xmx1536m`）；避免同时开多个大编译。
4. **二进制架构**：guest 是 glibc/ARM64。Android/Bionic 二进制搬进来会 exit 126；x86 二进制无法运行。需要工具就 apt 装 ARM64 版。
5. **Android 构建**：AAPT2 必须禁 daemon + Gradle 关 daemon（详见 Env Templates android-build 模板），否则资源编译挂死。
6. **路径**：shell 用 guest 路径（/workspace…），文件工具/导出用宿主绝对路径；不要手拼 `/workspace/.coomi/...` 这类跨界路径。
7. **pip 实践**：项目用 venv；`pip install --user` 的脚本已在 PATH；不要 `sudo pip`（本来就是 root）。
8. **systemd 不可用**：proot 里没有运行的 systemd——不要 `systemctl start x`；需要后台服务用 `nohup ... &` + local_shell 会话。
9. **排障入口**：环境异常先调 `runtime_doctor` 看探测事实（工具链版本/网络/挂载），再动手修。
10. **DNS/网络（Ubuntu 镜像坑）**：镜像自带的 `/etc/resolv.conf` 是指向 systemd-resolved 的悬空符号链接（proot 无 systemd）——`cat /etc/resolv.conf` 报错或 `ping/curl` 域名失败时，先 `ls -l /etc/resolv.conf` 看是否符号链接；引擎每次启动已自动重写为实体 DNS 文件（223.5.5.5/119.29.29.29），若仍异常可手动 `rm -f /etc/resolv.conf` 后重写（勿用 `systemctl` 重启 resolver，proot 里没有 systemd）。

## 报错自纠流程

1. 读错误原文——上游供应商错误（带 code）按提示归因：欠费/Key 无效是**用户侧配置问题**，提醒用户处理，不要反复重试。
2. 缺命令 → apt 装；权限 → 换 /workspace 或 chmod；超时 → 换 local_shell 模式。
3. 同一失败调用最多重试一次，改参数再试；连续失败换思路。
