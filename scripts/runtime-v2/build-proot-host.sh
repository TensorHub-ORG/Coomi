#!/usr/bin/env bash
set -euo pipefail

PROOT_COMMIT="61681c6481197e3c0cec6726075053adb740f235"
PROOT_ARCHIVE_SHA256="17c96daa22e3b1f923a58a68e0827ea78f46cf0f3934f0b83e0fe2768dbfbb73"
TERMUX_PACKAGES_COMMIT="d4623496c2285fa3d583db42646b661513d0d8cc"
TERMUX_BUILDER_IMAGE="ghcr.io/termux/package-builder@sha256:374fedda8d2ce7a8ab499735d39329301c4f2f18ea4411b3cf7c93d4668768ab"
SOURCE_DATE_EPOCH="1787270400"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${RUNTIME_V2_WORK:-$ROOT/.runtime-v2-work}/proot"
OUTPUT="${RUNTIME_V2_OUTPUT:-$ROOT/runtime-v2-dist}"
PACKAGES="$WORK/termux-packages"

for command in git docker dpkg-deb readelf tar gzip sha256sum; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

mkdir -p "$WORK" "$OUTPUT"
if [[ ! -d "$PACKAGES/.git" ]]; then
  git clone --filter=blob:none https://github.com/termux/termux-packages.git "$PACKAGES"
fi
git -C "$PACKAGES" fetch --depth=1 origin "$TERMUX_PACKAGES_COMMIT"
git -C "$PACKAGES" checkout --detach "$TERMUX_PACKAGES_COMMIT"
test "$(git -C "$PACKAGES" rev-parse HEAD)" = "$TERMUX_PACKAGES_COMMIT"

RECIPE="$PACKAGES/packages/proot/build.sh"
python3 - "$RECIPE" "$PROOT_COMMIT" "$PROOT_ARCHIVE_SHA256" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
commit = sys.argv[2]
digest = sys.argv[3]
text = path.read_text(encoding="utf-8")
text = text.replace(
    "TERMUX_PKG_SRCURL=https://github.com/termux/proot/archive/v${TERMUX_PKG_VERSION}.zip",
    f"TERMUX_PKG_SRCURL=https://github.com/termux/proot/archive/{commit}.tar.gz",
)
text = text.replace(
    "TERMUX_PKG_SHA256=a7bc2fab34bf9a39073e8291f08a662e848c61a67494e59f5f84f5ca10690128",
    f"TERMUX_PKG_SHA256={digest}",
)
text = text.replace("export PROOT_UNBUNDLE_LOADER=$TERMUX_PREFIX/libexec/proot\n", "")
needle = "termux_step_pre_configure() {\n"
patch = '''termux_step_post_get_source() {
\t# Link the two small dependencies statically so the host archive is self-contained.
\tsed -i 's|LDFLAGS  += -ltalloc -Wl,-z,noexecstack|LDFLAGS  += -Wl,-Bstatic -ltalloc -Wl,-Bdynamic -Wl,-z,noexecstack|' src/GNUmakefile
\tsed -i 's|LDFLAGS += -landroid-shmem|LDFLAGS += -Wl,-Bstatic -landroid-shmem -Wl,-Bdynamic -llog -landroid|' src/GNUmakefile
}

'''
if needle not in text:
    raise SystemExit("unexpected Termux PRoot recipe")
text = text.replace(needle, patch + needle)
path.write_text(text, encoding="utf-8", newline="\n")
PY

export TERMUX_BUILDER_IMAGE_NAME="$TERMUX_BUILDER_IMAGE"
export CI=true
(
  cd "$PACKAGES"
  ./scripts/run-docker.sh ./build-package.sh -a aarch64 proot
)

DEB="$(find "$PACKAGES/output" -maxdepth 1 -type f -name 'proot_*_aarch64.deb' -print | sort | tail -n 1)"
test -n "$DEB"
STAGE="$WORK/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/package" "$STAGE/archive/bin"
dpkg-deb -x "$DEB" "$STAGE/package"
PROOT="$(find "$STAGE/package" -type f -path '*/bin/proot' -print -quit)"
test -n "$PROOT"
cp "$PROOT" "$STAGE/archive/bin/proot"
chmod 0755 "$STAGE/archive/bin/proot"

if readelf -d "$STAGE/archive/bin/proot" | grep -Eq 'libtalloc|libandroid-shmem'; then
  echo "PRoot still has non-system dynamic dependencies" >&2
  exit 1
fi
readelf -h "$STAGE/archive/bin/proot" | grep -q 'AArch64'

TAR="$OUTPUT/proot-host-arm64.tar"
GZIP="$TAR.gz"
tar --sort=name --owner=0 --group=0 --numeric-owner \
  --mtime="@$SOURCE_DATE_EPOCH" -C "$STAGE/archive" -cf "$TAR" .
gzip -n -9 -f "$TAR"
sha256sum "$GZIP" > "$GZIP.sha256"
wc -c < "$GZIP" | tr -d ' ' > "$GZIP.size"
