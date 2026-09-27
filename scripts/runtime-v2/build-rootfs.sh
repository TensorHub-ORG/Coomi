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
PACKAGES="apt,ca-certificates,curl,git,locales,nodejs,python3,python3-aiohttp,python3-numpy"
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
