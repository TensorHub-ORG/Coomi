---
name: Env Templates
description: 三套环境初始化模板（python-web / node-web / android-build），一条命令完成 Coomi guest 内的常用技术栈配置，内置已知兼容性适配。
keywords: [template, 模板, 环境, 初始化, python, node, android, gradle, aapt2, proot]
tools: [shell, local_shell, read_file, write_file]
---

# Env Templates（环境初始化模板）

在 Coomi guest（proot Debian）里初始化常用技术栈时，**用下面的模板，不要从零摸索**——模板已固化 proot 环境的已知兼容性适配（参照 Operit 模板体系的经验）。按需让 Agent 执行对应模板命令即可。

## 模板一：python-web

```bash
mkdir -p ~/pyweb && cd ~/pyweb
python3 -m venv .venv
. .venv/bin/activate
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
pip install --upgrade pip
# 常用 Web 栈：换项目按需增删
pip install fastapi uvicorn[standard] httpx
echo 'export PATH="$HOME/pyweb/.venv/bin:$PATH"' >> ~/.bashrc
```

要点：一律用 venv（不要 `pip install` 到系统）；国内镜像已配 TUNA；aiohttp/numpy 已随镜像预装。

## 模板二：node-web

```bash
mkdir -p ~/nodeweb && cd ~/nodeweb
npm config set registry https://registry.npmmirror.com
npm init -y
# 原生模块编译需要构建链（full 档预装；base 档先装）：
command -v make >/dev/null || apt install -y build-essential python3-dev
npm install
```

要点：原生扩展（node-gyp）在 proot 内可正常编译，但需要 build-essential；registry 用 npmmirror 加速。

## 模板三：android-build

```bash
mkdir -p ~/android && cd ~/android
# proot 内构建 Android 工程的已知适配（固化自 Operit 模板经验）：
cat >> gradle.properties <<'EOF'
org.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m
android.enableAapt2WorkerNoDaemon=true
EOF
# AAPT2 在 proot 下必须禁用 daemon（fork/进程语义差异），否则资源编译挂起：
printf 'android.aapt2FromMavenOverride=/usr/bin/aapt2\n' >> local.properties 2>/dev/null || true
# 内存受限：Gradle daemon 关闭 + 低堆，避免 proot 下 OOM
./gradlew --stop; ./gradlew assembleDebug --no-daemon
```

要点（proot 适配，勿删）：
1. `android.enableAapt2WorkerNoDaemon=true` + 关闭 Gradle daemon——proot 的进程组/fork 语义会让 AAPT2 worker daemon 挂死；
2. JVM 堆压到 1.5G——guest 内存限额（512M~2G）下默认堆会 OOM；
3. 构建输出目录建议放 `/workspace`（宿主可见，便于导出 APK）。

## 使用规则

- 执行模板前先 `read_file` 确认用户项目结构，不要盲目覆盖已有配置。
- 模板命令逐条执行并检查输出；失败按错误自纠提示处理（缺包 apt install、权限换目录）。
- 模板未覆盖的新技术栈：完成初始化后，把成功的步骤追加回本 Skill（保持模板资产持续沉淀）。
