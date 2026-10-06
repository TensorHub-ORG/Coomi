---
name: Runtime Environments
description: Route tools across Host, Termux, and ProotLinux without mixing paths or binaries.
keywords: [termux, proot, prootlinux, runtime, environment, path, workspace, github, ssh, build]
tools: [shell, local_shell, read_file, write_file, edit_file, search]
---

# Runtime Environments

Use the environment router rather than guessing paths or manually prefixing commands.

## Environments

- `host`: Android/Coomi file APIs, exports, and security checks.
- `termux`: Android-native ARM64 tools, USB, notifications, and Android bridges.
- `proot`: Linux userland tools such as Git, Python, Node, Rust, and Linux shell scripts.
- `auto`: prefer ProotLinux when ready, otherwise Termux; use `host` only for file/API work.

## Paths

The canonical guest aliases are:

- `/workspace` -> the active Android workspace
- `/home/coomi` -> persistent Proot home
- `/opt/coomi-dev` -> CoomiDev build kit
- `/tmp` -> runtime temporary directory

File tools accept these guest aliases and host absolute paths. Do not invent paths such as `/workspace/.coomi/runtime-v2/home/...`; that mixes namespaces. When a tool returns both `host_path` and `guest_path`, use the guest path for Proot shell commands and the host path only for host-side APIs.

## Switching

Pass `environment` on shell tools when the target matters: `host`, `termux`, `proot`, or `auto`. Do not put Termux Android-PIE/Bionic binaries into a Proot glibc `PATH`, and do not use Proot glibc binaries from Termux. Switch at a tool-call boundary.

## Diagnostics

For missing files, first identify the environment and inspect the path mapping. For Git/SSH, verify `HOME=/home/coomi`, `USER=coomi`, writable `/home/coomi/.ssh`, and the configured `known_hosts` path. Treat suspicious `/etc/hosts` overrides for GitHub as an environment issue and report them before changing them.

## Project layout

For custom iteration, keep source in `/home/coomi/custom_coomi`. Keep runtime helpers under `/opt/coomi-dev`; do not put source checkouts in the build kit or temporary directory.
