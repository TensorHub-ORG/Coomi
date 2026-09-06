#!/usr/bin/env bash
set -euo pipefail

# 批次八 ①：完整 Ubuntu 发行版底座（对齐 Operit 的 Ubuntu 24.04 rootfs 模式）。
# 构建宿主要求：Linux x86_64 + root + mmdebstrap + qemu-user-static（binfmt）。
# WSL2 Ubuntu 宿主已验证可用；Windows 侧通过 `wsl -d Ubuntu -u root` 调用。
UBUNTU_SUITE="noble"
UBUNTU_MIRROR="https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports"
SOURCE_DATE_EPOCH="1788297600"  # 2026-09-01 00:00 UTC：tar 元数据可复现

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${RUNTIME_V2_WORK:-$ROOT/.runtime-v2-work}/rootfs"
OUTPUT="${RUNTIME_V2_OUTPUT:-$ROOT/runtime-v2-dist}"
ROOTFS="$WORK/rootfs"

for command in mmdebstrap tar gzip sha256sum; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
if [[ "$(id -u)" != 0 ]]; then
  echo "build-rootfs.sh must run as root so mmdebstrap can configure arm64 packages" >&2
  exit 1
fi
if [[ ! -f /usr/share/keyrings/ubuntu-archive-keyring.gpg ]]; then
  echo "missing ubuntu keyring: apt-get install -y ubuntu-keyring" >&2
  exit 1
fi

mkdir -p "$WORK" "$OUTPUT"
rm -rf "$ROOTFS"

# 完整发行版底座：important 变体（常规 Ubuntu 用户空间，含 systemd 等标准组件）
# + 开发全家桶。JDK/重型专用链不进 base（体积控制），由 env-templates 按需 apt 安装。
PACKAGES="apt,ca-certificates,curl,wget,git,locales,nodejs,npm,python3,python3-pip,python3-venv,python3-aiohttp,python3-numpy,procps,findutils,file,unzip,zip,tar,xz-utils,bzip2,less,jq,diffutils,patch,gawk,openssh-client,iputils-ping,iproute2,net-tools,build-essential,cmake,pkg-config,sqlite3,nano,vim-tiny,bash-completion,man-db,sudo,tzdata,rsync,tmux,htop,tree"

mmdebstrap \
  --architectures=arm64 \
  --keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg \
  --variant=important \
  --components=main,universe \
  --include="$PACKAGES" \
  --aptopt='Acquire::Check-Valid-Until "false"' \
  --customize-hook='printf "en_US.UTF-8 UTF-8\nzh_CN.UTF-8 UTF-8\n" > "$1/etc/locale.gen"' \
  --customize-hook='chroot "$1" locale-gen' \
  --customize-hook='mkdir -p "$1/workspace" "$1/home/coomi" "$1/opt/coomi-dev" "$1/tmp"' \
  --customize-hook='printf "deb https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports noble main universe\ndeb https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports noble-updates main universe\ndeb https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports noble-security main universe\n" > "$1/etc/apt/sources.list"' \
  --customize-hook='chroot "$1" python3 -c "import sys; assert sys.version_info >= (3, 11)"' \
  "$UBUNTU_SUITE" "$ROOTFS" "deb $UBUNTU_MIRROR $UBUNTU_SUITE main universe"

rm -rf "$ROOTFS/var/cache/apt/archives"/* "$ROOTFS/var/lib/apt/lists"/*
find "$ROOTFS" -xdev -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

TAR="$OUTPUT/ubuntu-noble-arm64.tar"
GZIP="$TAR.gz"
tar --sort=name --owner=0 --group=0 --numeric-owner \
  --mtime="@$SOURCE_DATE_EPOCH" -C "$ROOTFS" -cf "$TAR" .
gzip -n -9 -f "$TAR"
sha256sum "$GZIP" > "$GZIP.sha256"
wc -c < "$GZIP" | tr -d ' ' > "$GZIP.size"
# 体积基线（批次八 ①）：完整 Ubuntu 档目标 ≤ 300MB 压缩包；超线需回查 PACKAGES。
echo "rootfs package: $(wc -c < "$GZIP") bytes ($(du -sh "$ROOTFS" | cut -f1) unpacked)"
