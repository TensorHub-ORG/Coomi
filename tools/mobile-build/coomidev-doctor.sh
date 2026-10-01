#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_SCRIPT="$SCRIPT_DIR/coomidev-env.sh"
[ -f "$ENV_SCRIPT" ] || ENV_SCRIPT="$SCRIPT_DIR/coomidev-env"
. "$ENV_SCRIPT"

errors=0
warnings=0

ok() { printf '[ok] %s\n' "$1"; }
fail() { printf '[error] %s\n' "$1" >&2; errors=$((errors + 1)); }
warn() { printf '[warn] %s\n' "$1" >&2; warnings=$((warnings + 1)); }

check_command() {
    name=$1
    path=$(command -v "$name" 2>/dev/null || true)
    if [ -z "$path" ]; then
        fail "missing command: $name"
        return
    fi
    case "$path" in
        /data/data/*/files/usr/*|/data/user/*/*/files/usr/*)
            fail "$name resolves to a Termux/Bionic path: $path"
            ;;
        *) ok "$name: $path" ;;
    esac
}

check_file() {
    label=$1
    path=$2
    if [ -f "$path" ]; then ok "$label: $path"; else fail "$label is missing: $path"; fi
}

check_directory() {
    label=$1
    path=$2
    if [ -d "$path" ]; then ok "$label: $path"; else fail "$label is missing: $path"; fi
}

check_native_aarch64() {
    label=$1
    path=$2
    [ -e "$path" ] || return 0
    info=$(file -L "$path" 2>/dev/null || true)
    case "$info" in
        *script*|*Java*|*JAR*) return 0 ;;
        *aarch64*|*ARM\ aarch64*) ;;
        *) fail "$label is not a Linux AArch64 executable: $info"; return ;;
    esac
    if command -v readelf >/dev/null 2>&1; then
        machine=$(readelf -h "$path" 2>/dev/null | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')
        case "$machine" in *AArch64*) ;; *) fail "$label has an unexpected ELF machine: ${machine:-unknown}" ;; esac
    fi
}

printf 'CoomiDev Build Kit doctor\n'
printf 'Build Kit: %s\n' "$COOMI_BUILD_KIT"

if [ "${COOMI_RUNTIME_BACKEND:-}" = proot_linux ]; then
    ok 'Runtime backend is ProotLinux'
else
    fail 'COOMI_RUNTIME_BACKEND must be proot_linux'
fi

arch=$(uname -m 2>/dev/null || true)
case "$arch" in aarch64|arm64) ok "host architecture: $arch" ;; *) fail "unsupported host architecture: ${arch:-unknown}" ;; esac

case "$(getconf GNU_LIBC_VERSION 2>/dev/null || true)" in
    glibc*) ok 'guest C library is glibc' ;;
    *) fail 'the guest must be Debian/glibc; do not use Termux/Bionic tools' ;;
esac

if [ -f "$COOMI_TOOLCHAIN_ROOT/buildkit.json" ]; then
    if python3 - "$COOMI_TOOLCHAIN_ROOT" <<'PY'
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
manifest = json.loads((root / "buildkit.json").read_text(encoding="utf-8"))
if manifest.get("schema_version") != 1:
    raise SystemExit("unsupported buildkit schema_version")
if manifest.get("host_arch") not in ("aarch64", "arm64"):
    raise SystemExit("buildkit host_arch is not ARM64")
for item in manifest.get("files", []):
    relative = pathlib.PurePosixPath(item["path"])
    if relative.is_absolute() or ".." in relative.parts:
        raise SystemExit(f"unsafe manifest path: {relative}")
    path = root.joinpath(*relative.parts).resolve()
    if root not in path.parents:
        raise SystemExit(f"manifest path escapes buildkit: {relative}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest.lower() != item["sha256"].lower():
        raise SystemExit(f"checksum mismatch: {relative}")
print(f"verified {len(manifest.get('files', []))} pinned files")
PY
    then ok 'versioned Build Kit manifest and checksums'; else fail 'Build Kit manifest verification failed'; fi
else
    fail "versioned Build Kit is not selected: $COOMI_TOOLCHAIN_ROOT/buildkit.json"
fi

available_kb=$(df -Pk "$COOMI_BUILD_KIT" 2>/dev/null | awk 'NR == 2 { print $4 }')
if [ -n "$available_kb" ] && [ "$available_kb" -ge 6291456 ]; then
    ok 'at least 6 GiB of free space is available'
else
    fail 'at least 6 GiB of free space is required'
fi

for command_name in file readelf python3 java javac node npm cargo rustc rustup clang ld.lld; do
    check_command "$command_name"
done

check_file 'Android platform android.jar' "$COOMI_ANDROID_JAR"
check_directory 'Android NDK sysroot' "$COOMI_NDK_HOME/toolchains/llvm/prebuilt"
check_file 'Android target clang' "$COOMI_ANDROID_CLANG"
check_file 'llvm-ar' "$COOMI_ANDROID_AR"
check_file 'llvm-ranlib' "$COOMI_ANDROID_RANLIB"
check_file 'ARM64 aapt2' "$COOMI_AAPT2"
check_file 'apksigner launcher' "$COOMI_APKSIGNER"
check_file 'd8 launcher' "$COOMI_D8"
check_file 'R8/d8 JAR' "$COOMI_R8_JAR"

check_native_aarch64 'Android target clang' "$COOMI_ANDROID_CLANG"
check_native_aarch64 'aapt2' "$COOMI_AAPT2"

if rustup target list --installed 2>/dev/null | grep -qx 'aarch64-linux-android'; then
    ok 'Rust aarch64-linux-android target'
else
    fail 'Rust target aarch64-linux-android is not installed'
fi

printf 'Doctor result: %s error(s), %s warning(s)\n' "$errors" "$warnings"
[ "$errors" -eq 0 ]
