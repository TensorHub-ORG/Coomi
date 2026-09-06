#!/usr/bin/env bash
set -euo pipefail

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
MIRROR="deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/$DEBIAN_SNAPSHOT $DEBIAN_SUITE main"
# 构建期用 snapshot 保证可复现；构建完成后把 guest 的 apt sources 改指清华 TUNA
# （与 guest DNS 223.5.5.5/119.29.29.29 配套，用户 apt install 走国内源）。
RUNTIME_MIRROR_HOOK='printf "deb https://mirrors.tuna.tsinghua.edu.cn/debian bookworm main\ndeb https://mirrors.tuna.tsinghua.edu.cn/debian bookworm-updates main\ndeb https://mirrors.tuna.tsinghua.edu.cn/debian-security bookworm-security main\n" > "$1/etc/apt/sources.list"'
# 反馈批次一 #1.1：从"7 个包最小镜像"扩到"够用的完整发行版"底座。
# 基础工具 / Python 工具链 / 网络与远程；重型构建链（build-essential、JDK）留给 full 档。
PACKAGES="apt,ca-certificates,curl,git,locales,nodejs,python3,python3-pip,python3-venv,python3-aiohttp,python3-numpy,procps,findutils,file,unzip,zip,tar,xz-utils,bzip2,less,jq,diffutils,patch,gawk,openssh-client,wget,iputils-ping,iproute2"
mmdebstrap \
  --architectures=arm64 \
  --keyring=/usr/share/keyrings/debian-archive-keyring.gpg \
  --variant=minbase \
  --include="$PACKAGES" \
  --components=main \
  --aptopt='Acquire::Check-Valid-Until "false"' \
  --customize-hook='printf "en_US.UTF-8 UTF-8\nzh_CN.UTF-8 UTF-8\n" > "$1/etc/locale.gen"' \
  --customize-hook='chroot "$1" locale-gen' \
  --customize-hook='chroot "$1" python3 -c "import sys, aiohttp, numpy; assert sys.version_info >= (3, 11); assert tuple(map(int, aiohttp.__version__.split(\".\")[:2])) >= (3, 8); assert (1, 24) <= tuple(map(int, numpy.__version__.split(\".\")[:2])) < (3, 0)"' \
  --customize-hook="$RUNTIME_MIRROR_HOOK" \
  "$DEBIAN_SUITE" "$ROOTFS" "$MIRROR"

rm -rf "$ROOTFS/var/cache/apt/archives"/* "$ROOTFS/var/lib/apt/lists"/*
find "$ROOTFS" -xdev -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

TAR="$OUTPUT/debian-bookworm-arm64.tar"
GZIP="$TAR.gz"
tar --sort=name --owner=0 --group=0 --numeric-owner \
  --mtime="@$SOURCE_DATE_EPOCH" -C "$ROOTFS" -cf "$TAR" .
gzip -n -9 -f "$TAR"
sha256sum "$GZIP" > "$GZIP.sha256"
wc -c < "$GZIP" | tr -d ' ' > "$GZIP.size"
# 体积基线（批次八 1.1）：base 档目标 ≤ 300MB 压缩包；超线需回查 PACKAGES。
echo "rootfs package: $(wc -c < "$GZIP") bytes ($(du -sh "$ROOTFS" | cut -f1) unpacked)"
