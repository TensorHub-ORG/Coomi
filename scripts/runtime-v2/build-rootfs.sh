#!/usr/bin/env bash
set -euo pipefail

# Debian bookworm arm64 rootfs（含 node/python/git/curl 等开发依赖）。
# 构建宿主要求：Linux + root + mmdebstrap + qemu-user-static（binfmt）。
DEBIAN_SUITE="bookworm"
DEBIAN_SNAPSHOT="20260803T000000Z"
SOURCE_DATE_EPOCH="1785715200"

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

mkdir -p "$WORK" "$OUTPUT"
rm -rf "$ROOTFS"
# minbase + 开发/脚本依赖（node/python/git/curl 为 AI 工具链必需）。
PACKAGES="apt,ca-certificates,curl,wget,git,locales,nodejs,npm,python3,python3-pip,python3-venv,python3-aiohttp,python3-numpy,procps,findutils,file,unzip,zip,tar,xz-utils,bzip2,less,jq,diffutils,patch,gawk,openssh-client,iputils-ping,iproute2,net-tools,build-essential,cmake,pkg-config,sqlite3,nano,vim-tiny,bash-completion,man-db,sudo,tzdata,rsync,tmux,htop,tree"

mmdebstrap \
  --architectures=arm64 \
  --keyring=/usr/share/keyrings/debian-archive-keyring.gpg \
  --variant=important \
  --components=main \
  --include="$PACKAGES" \
  --aptopt='Acquire::Check-Valid-Until "false"' \
  --customize-hook='printf "en_US.UTF-8 UTF-8\nzh_CN.UTF-8 UTF-8\n" > "$1/etc/locale.gen"' \
  --customize-hook='chroot "$1" locale-gen' \
  --customize-hook='mkdir -p "$1/workspace" "$1/home/coomi" "$1/opt/coomi-dev" "$1/tmp"' \
  --customize-hook='rm -f "$1/etc/resolv.conf"; printf "# Coomi guest DNS\nnameserver 223.5.5.5\nnameserver 119.29.29.29\nnameserver 8.8.8.8\n" > "$1/etc/resolv.conf"' \
  --customize-hook='chroot "$1" python3 -c "import sys; assert sys.version_info >= (3, 11)"' \
  "$DEBIAN_SUITE" "$ROOTFS" "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/$DEBIAN_SNAPSHOT $DEBIAN_SUITE main"

rm -rf "$ROOTFS/var/cache/apt/archives"/* "$ROOTFS/var/lib/apt/lists"/*
find "$ROOTFS" -xdev -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

TAR="$OUTPUT/debian-bookworm-arm64.tar"
GZIP="$TAR.gz"
tar --sort=name --owner=0 --group=0 --numeric-owner \
  --mtime="@$SOURCE_DATE_EPOCH" -C "$ROOTFS" -cf "$TAR" .
gzip -n -9 -f "$TAR"
sha256sum "$GZIP" > "$GZIP.sha256"
wc -c < "$GZIP" | tr -d ' ' > "$GZIP.size"
echo "rootfs package: $(wc -c < "$GZIP") bytes ($(du -sh "$ROOTFS" | cut -f1) unpacked)"
