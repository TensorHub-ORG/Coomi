#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_SCRIPT="$SCRIPT_DIR/coomidev-env.sh"
[ -f "$ENV_SCRIPT" ] || ENV_SCRIPT="$SCRIPT_DIR/coomidev-env"
. "$ENV_SCRIPT"

usage() {
    printf '%s\n' 'Usage: coomidev-build [doctor|android-smoke|rust-smoke|full]'
}

find_repo_root() {
    current=$PWD
    while [ "$current" != / ]; do
        if [ -f "$current/settings.gradle" ] && [ -d "$current/apps/coomi-app" ]; then
            printf '%s\n' "$current"
            return 0
        fi
        current=$(dirname "$current")
    done
    return 1
}

doctor() {
    doctor_script="$SCRIPT_DIR/coomidev-doctor.sh"
    [ -f "$doctor_script" ] || doctor_script="$SCRIPT_DIR/coomidev-doctor"
    "$doctor_script"
}

android_smoke() {
    doctor
    temp_dir=$(mktemp -d "$COOMI_BUILD_KIT/cache/android-smoke.XXXXXX")
    trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
    mkdir -p "$temp_dir/res/values"
    printf '%s\n' '<resources><string name="app_name">CoomiDevSmoke</string></resources>' > "$temp_dir/res/values/strings.xml"
    printf '%s\n' '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.coomidev.smoke"><uses-sdk android:minSdkVersion="28"/><application android:label="@string/app_name"/></manifest>' > "$temp_dir/AndroidManifest.xml"
    "$COOMI_AAPT2" compile --dir "$temp_dir/res" -o "$temp_dir/resources.zip"
    "$COOMI_AAPT2" link -I "$COOMI_ANDROID_JAR" --manifest "$temp_dir/AndroidManifest.xml" -o "$temp_dir/smoke.apk" "$temp_dir/resources.zip"
    test -s "$temp_dir/smoke.apk"
    printf '[ok] Android resource/APK smoke test\n'
}

rust_smoke() {
    doctor
    temp_dir=$(mktemp -d "$COOMI_BUILD_KIT/cache/rust-smoke.XXXXXX")
    trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
    printf '%s\n' 'fn main() { println!("coomidev-rust-smoke"); }' > "$temp_dir/main.rs"
    rustc "$temp_dir/main.rs" --target aarch64-linux-android -C "linker=$COOMI_ANDROID_CLANG" -o "$temp_dir/smoke"
    file "$temp_dir/smoke" | grep -E 'aarch64|ARM aarch64' >/dev/null
    printf '[ok] Rust/Android linker smoke test\n'
}

full_build() {
    doctor
    repo_root=$(find_repo_root) || {
        printf '[error] run this command inside a Coomi source checkout\n' >&2
        exit 1
    }
    cd "$repo_root"
    mkdir -p /home/coomi/CoomiDev-output
    COOMI_DEV_BUILD=1 \
    COOMI_NDK_HOME="$COOMI_NDK_HOME" \
    COOMI_NDK_TOOLCHAIN_DIR="$COOMI_NDK_TOOLCHAIN_DIR" \
    COOMI_ANDROID_CLANG="$COOMI_ANDROID_CLANG" \
    COOMI_ANDROID_AR="$COOMI_ANDROID_AR" \
    COOMI_ANDROID_RANLIB="$COOMI_ANDROID_RANLIB" \
    COOMI_NPM="$COOMI_NPM" \
    COOMI_CARGO="$COOMI_CARGO" \
    COOMI_RUSTUP="$COOMI_RUSTUP" \
    ./gradlew --no-daemon --max-workers=2 \
        -Pandroid.aapt2FromMavenOverride="$COOMI_AAPT2" \
        :app:clean :app:assembleDebug
    apk=$(find apps/coomi-app/app/build/outputs/apk/debug -type f -name 'CoomiDev-*.apk' | sort | tail -n 1)
    [ -n "$apk" ] && [ -s "$apk" ] || {
        printf '[error] CoomiDev APK was not produced\n' >&2
        exit 1
    }
    "$COOMI_AAPT2" dump badging "$apk" | grep "package: name='com.coomidev.android'" >/dev/null
    "$COOMI_APKSIGNER" verify --verbose "$apk"
    cp "$apk" /home/coomi/CoomiDev-output/
    printf '[ok] APK: /home/coomi/CoomiDev-output/%s\n' "$(basename "$apk")"
}

case "${1:-full}" in
    doctor) doctor ;;
    android-smoke) android_smoke ;;
    rust-smoke) rust_smoke ;;
    full) full_build ;;
    -h|--help|help) usage ;;
    *) usage >&2; exit 2 ;;
esac
