#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT="${RUNTIME_V2_OUTPUT:-$ROOT/runtime-v2-dist}"
BASE_URL="${RUNTIME_V2_BASE_URL:?set RUNTIME_V2_BASE_URL to the immutable release asset base URL}"
RUNTIME_VERSION="${RUNTIME_V2_VERSION:-debian-bookworm-20260803-proot-5.1.107.91}"
PROOT_COMMIT="61681c6481197e3c0cec6726075053adb740f235"

for command in jq sha256sum stat; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

HOST="$OUTPUT/proot-host-arm64.tar.gz"
ROOTFS="$OUTPUT/debian-bookworm-arm64.tar.gz"
test -f "$HOST" && test -f "$ROOTFS"
HOST_SHA="$(sha256sum "$HOST" | cut -d' ' -f1)"
ROOTFS_SHA="$(sha256sum "$ROOTFS" | cut -d' ' -f1)"
HOST_SIZE="$(stat -c %s "$HOST")"
ROOTFS_SIZE="$(stat -c %s "$ROOTFS")"

jq -n \
  --arg runtime_version "$RUNTIME_VERSION" \
  --arg proot_commit "$PROOT_COMMIT" \
  --arg host_url "$BASE_URL/$(basename "$HOST")" \
  --arg host_sha "$HOST_SHA" \
  --argjson host_size "$HOST_SIZE" \
  --arg rootfs_url "$BASE_URL/$(basename "$ROOTFS")" \
  --arg rootfs_sha "$ROOTFS_SHA" \
  --argjson rootfs_size "$ROOTFS_SIZE" \
  '{
    version: 2,
    runtime_version: $runtime_version,
    architecture: "arm64-v8a",
    proot_commit: $proot_commit,
    proot_license: "GPL-2.0-or-later",
    host: {url: $host_url, sha256: $host_sha, size: $host_size},
    rootfs: {url: $rootfs_url, sha256: $rootfs_sha, size: $rootfs_size},
    environment: {
      HOME: "/home/coomi",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt"
    }
  }' > "$OUTPUT/runtime-v2-manifest.json"
