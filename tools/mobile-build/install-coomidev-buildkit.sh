#!/bin/sh
set -eu

usage() {
    printf '%s\n' 'Usage: coomidev-install-buildkit ARCHIVE EXPECTED_SHA256' >&2
}

[ "$#" -eq 2 ] || { usage; exit 2; }
[ "${COOMI_RUNTIME_BACKEND:-}" = proot_linux ] || {
    printf '[error] this installer must run inside Runtime V2 ProotLinux\n' >&2
    exit 1
}

archive=$1
expected=$2
root="${COOMI_BUILD_KIT:-/opt/coomi-dev}"
[ -f "$archive" ] || { printf '[error] archive not found: %s\n' "$archive" >&2; exit 1; }
case "$expected" in *[!0-9a-fA-F]*|'') printf '[error] expected SHA-256 must be 64 hexadecimal characters\n' >&2; exit 1 ;; esac
[ "${#expected}" -eq 64 ] || { printf '[error] expected SHA-256 must be 64 hexadecimal characters\n' >&2; exit 1; }

mkdir -p "$root/toolchains" "$root/cache" "$root/state" "$root/logs" "$root/keys"
staging=$(mktemp -d "$root/state/install.XXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM

kit_id=$(python3 - "$archive" "$expected" "$staging" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
expected = sys.argv[2].lower()
staging = pathlib.Path(sys.argv[3]).resolve()

digest = hashlib.sha256(archive.read_bytes()).hexdigest()
if digest != expected:
    raise SystemExit(f"archive checksum mismatch: expected {expected}, got {digest}")

with tarfile.open(archive, "r:*") as source:
    members = source.getmembers()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise SystemExit(f"unsafe archive path: {member.name}")
        if not (member.isdir() or member.isfile()):
            raise SystemExit(f"links and special files are not allowed: {member.name}")
    for member in members:
        target = staging.joinpath(*pathlib.PurePosixPath(member.name).parts)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        stream = source.extractfile(member)
        if stream is None:
            raise SystemExit(f"cannot read archive member: {member.name}")
        with target.open("wb") as output:
            output.write(stream.read())
        target.chmod(member.mode & 0o777)

manifest_path = staging / "buildkit.json"
if not manifest_path.is_file():
    raise SystemExit("archive root must contain buildkit.json")
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
if manifest.get("schema_version") != 1 or manifest.get("host_arch") not in ("aarch64", "arm64"):
    raise SystemExit("unsupported Build Kit schema or host architecture")
kit_id = manifest.get("id", "")
if not re.fullmatch(r"[A-Za-z0-9._-]+", kit_id):
    raise SystemExit("invalid Build Kit id")

declared = set()
for item in manifest.get("files", []):
    relative = pathlib.PurePosixPath(item["path"])
    if relative.is_absolute() or ".." in relative.parts:
        raise SystemExit(f"unsafe manifest path: {relative}")
    path = staging.joinpath(*relative.parts).resolve()
    if staging not in path.parents or not path.is_file():
        raise SystemExit(f"manifest file is missing: {relative}")
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual.lower() != item["sha256"].lower():
        raise SystemExit(f"checksum mismatch: {relative}")
    declared.add(relative.as_posix())

actual_files = {
    path.relative_to(staging).as_posix()
    for path in staging.rglob("*")
    if path.is_file() and path != manifest_path
}
if actual_files != declared:
    extra = sorted(actual_files - declared)
    missing = sorted(declared - actual_files)
    raise SystemExit(f"manifest coverage mismatch; extra={extra}, missing={missing}")
print(kit_id)
PY
)

target="$root/toolchains/$kit_id"
if [ -e "$target" ]; then
    printf '[error] Build Kit version already exists: %s\n' "$target" >&2
    exit 1
fi
mv "$staging" "$target"
trap - EXIT HUP INT TERM

if [ -d "$root/current" ] && [ ! -L "$root/current" ]; then
    rmdir "$root/current" 2>/dev/null || {
        printf '[error] refusing to replace non-empty legacy current directory\n' >&2
        exit 1
    }
fi
ln -s "$target" "$root/current.new"
mv -Tf "$root/current.new" "$root/current"
printf '%s\n' "$expected  $(basename "$archive")" > "$root/state/$kit_id.archive.sha256"
printf '[ok] selected Build Kit %s\n' "$kit_id"
