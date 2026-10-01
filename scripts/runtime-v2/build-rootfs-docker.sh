#!/usr/bin/env bash
# Docker 化构建 Debian bookworm arm64 rootfs：无需 root 主机（容器内跑 mmdebstrap）。
# 用法：bash scripts/runtime-v2/build-rootfs-docker.sh
# 输出：runtime-v2-dist/debian-bookworm-arm64.tar.gz(.sha256/.size)
set -euo pipefail

# ROOT：优先调用方显式传入的 ROOT（Windows 路径，最稳），其次 PWD，最后脚本相对位置。
if [[ -n "${ROOT:-}" ]]; then
  : # 已显式给定
elif [[ "$(basename "$PWD")" == "coomi-full-project" ]]; then
  ROOT="$PWD"
  if command -v cygpath >/dev/null 2>&1 && [[ "$ROOT" == /* ]]; then ROOT="$(cygpath -w "$ROOT")"; fi
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  if command -v cygpath >/dev/null 2>&1 && [[ "$ROOT" == /* ]]; then ROOT="$(cygpath -w "$ROOT")"; fi
fi
OUTPUT="${RUNTIME_V2_OUTPUT:-$ROOT/runtime-v2-dist}"

for command in docker; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

mkdir -p "$OUTPUT"

echo "[docker-rootfs] building Debian bookworm (arm64) via mmdebstrap container ..."
# 宿主上直接跑 build-rootfs.sh 无法满足 root 要求，故挂载进容器，
# 容器内以 root 身份执行；产物写到宿主的 runtime-v2-dist（挂载卷）。
docker run --rm --privileged \
  -v "$ROOT":/work:rw \
  -e RUNTIME_V2_OUTPUT=/work/runtime-v2-dist \
  -e RUNTIME_V2_WORK=/work/.runtime-v2-work \
  debian:bookworm-slim \
  bash -c '
    set -euo pipefail
    cd /work
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq mmdebstrap debian-archive-keyring \
      ca-certificates curl gzip tar xz-utils wget >/dev/null 2>&1
    # arm64 模拟：容器内装 qemu-user-static，并把 qemu-aarch64-static 放到 /usr/bin（mmdebstrap 期望路径）。
    apt-get install -y -qq qemu-user-static binfmt-support >/dev/null 2>&1 || true
    if [ ! -f /usr/bin/qemu-aarch64-static ] && [ -f /usr/bin/qemu-aarch64 ]; then
      ln -sf /usr/bin/qemu-aarch64 /usr/bin/qemu-aarch64-static
    fi
    bash /work/scripts/runtime-v2/build-rootfs.sh
  '

echo "[docker-rootfs] done -> $(ls -lh "$OUTPUT"/debian-bookworm-arm64.tar.gz 2>/dev/null | awk '{print $9, $5}')"
