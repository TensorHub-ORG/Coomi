---
name: Runtime Environments
description: The single Agent execution environment (ProotLinux Ubuntu 24.04 guest) — paths, package manager, and capabilities.
keywords: [proot, prootlinux, runtime, environment, path, workspace, github, ssh, build, apt]
tools: [shell, local_shell, read_file, write_file, edit_file, search]
---

# Runtime Environments

The Agent executes in **one unified environment**: an Ubuntu 24.04 (noble) ProotLinux guest. All shell commands run there; paths are Linux paths. There is no model-facing Termux/host execution environment — do not guess or switch.

## Environment facts

- OS: Ubuntu 24.04 LTS (glibc, ARM64) via proot; shell commands run inside this guest.
- Package manager: `apt` (国内镜像源已预配). Missing command → `apt install <package>`, then retry.
- Toolchain: Git, Python3 (+pip/venv), Node.js, curl/wget, and common utilities (unzip/zip/jq/patch/procps/openssh-client…). Heavy build chains may still need one `apt install`.
- Working directories: `/workspace`, `/home/coomi`, `/tmp`. `/home/coomi/.local/bin` is on PATH (pip `--user` scripts work). The guest runs as root: system paths like `/etc` are writable inside the guest image — changes affect only the guest, never Android, so modify with care.
- Network: direct HTTP(S) available; guest DNS is preconfigured.

Each shell tool result carries an `[env: ...]` marker confirming the environment you are in.

## Paths

The canonical guest aliases are:

- `/workspace` -> the active Android workspace
- `/home/coomi` -> persistent Proot home
- `/opt/coomi-dev` -> CoomiDev build kit
- `/tmp` -> runtime temporary directory

File tools accept these guest aliases and host absolute paths. Do not invent paths such as `/workspace/.coomi/runtime-v2/home/...`; that mixes namespaces. When a tool returns both `host_path` and `guest_path`, use the guest path for shell commands and the host path only for host-side APIs (file tools, exports).

## Binary compatibility

Do not run Android/Bionic binaries inside the guest (they are glibc-incompatible and exit 126), and do not copy guest glibc binaries out to the Android side. `permission denied` on system paths usually means the path is outside the writable directories above.

## Diagnostics

For missing files, first check the path mapping above. For Git/SSH, verify `HOME=/home/coomi`, `USER=coomi`, writable `/home/coomi/.ssh`, and the configured `known_hosts` path. Treat suspicious `/etc/hosts` overrides for GitHub as an environment issue and report them before changing them. `runtime_doctor` reports live probe facts.

## Project layout

For custom iteration, keep source in `/home/coomi/custom_coomi`. Keep runtime helpers under `/opt/coomi-dev`; do not put source checkouts in the build kit or temporary directory.
