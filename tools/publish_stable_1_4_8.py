"""Publish the signed Coomi Android 1.4.8 APK to the stable channel."""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import time

import publish_test_1_4_8_8 as base
from verify_android_bundle import verify as verify_bundle


ROOT = Path(__file__).resolve().parents[1]
VERSION = "1.4.8"
VERSION_CODE = 75
DATE = "2026-09-14"
APK_NAME = f"Coomi-Android-arm64-v{VERSION}.apk"
APK = ROOT / "apps/coomi-app/app/build/outputs/apk/release/coomi-app_apt-android-7-release_arm64-v8a.apk"
STABLE_ROOT = "/www/wwwroot/updates.septemc.com/coomi/android"
TEST_MANIFEST = "/www/wwwroot/updates.septemc.com/coomi/android_test/latest.json"
SITE_PATH = "/www/wwwroot/coomi.septemc.com/index.html"
SITE_SOURCE = ROOT / "server/site/index.html"
SITE_MIRROR = ROOT / "server/site/index.remote.html"
SITE_BASELINE_SHA256 = "bc9760d698c22a01d9767d371573a53df628697af967a731d4fe1c5373d4a30f"


def ensure_release_state():
    version = subprocess.check_output(
        [str(ROOT / "gradlew.bat"), "-q", ":app:versionName"],
        cwd=ROOT,
        text=True,
    ).strip()
    if version != VERSION:
        raise RuntimeError(f"Gradle version is {version!r}, expected {VERSION!r}")
    if subprocess.check_output(
        ["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT, text=True
    ).strip():
        raise RuntimeError("Stable publication requires a clean tracked worktree")
    if subprocess.check_output(["git", "branch", "--show-current"], cwd=ROOT, text=True).strip() != "main":
        raise RuntimeError("Stable publication requires the main branch")
    if SITE_SOURCE.read_bytes() != SITE_MIRROR.read_bytes():
        raise RuntimeError("Website source and remote mirror are different")

    website = SITE_SOURCE.read_text(encoding="utf-8")
    heading = f"v{VERSION} 更新说明【稳定】"
    fold = "<summary>展开全部更新记录</summary>"
    previous = "v1.4.7 更新说明【稳定】"
    if website.count(heading) != 1:
        raise RuntimeError("Website must contain exactly one latest stable release heading")
    latest_at = website.index(heading)
    fold_at = website.index(fold, latest_at)
    previous_at = website.index(previous, latest_at)
    if not latest_at < fold_at < previous_at:
        raise RuntimeError("Stable website history is not folded below the latest release")
    expected_download = f"https://updates.septemc.com/coomi/android/{APK_NAME}"
    if website.count(expected_download) != 1:
        raise RuntimeError("Stable website download button does not target the release APK")


def configure_base_verifier():
    base.VERSION = VERSION
    base.VERSION_CODE = VERSION_CODE
    base.APK_NAME = APK_NAME
    base.APK = APK


def main():
    ensure_release_state()
    verify_bundle(APK)
    configure_base_verifier()
    base.verify_apk_identity()

    digest = hashlib.sha256(APK.read_bytes()).hexdigest()
    size = APK.stat().st_size
    source_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    release_notes = (ROOT / f"docs/releases/v{VERSION}.md").read_text(encoding="utf-8")
    release_notes = release_notes.removeprefix("# ").strip()

    client = base.connect()
    try:
        sftp = client.open_sftp()
        old_latest_bytes = base.read(sftp, STABLE_ROOT + "/latest.json")
        old_latest = json.loads(old_latest_bytes)
        if int(old_latest.get("versionCode", 0)) >= VERSION_CODE:
            raise RuntimeError("Refusing to overwrite the same or a newer stable release")

        old_versions_bytes = base.read(sftp, STABLE_ROOT + "/versions.json")
        old_versions = json.loads(old_versions_bytes)
        test_before = base.read(sftp, TEST_MANIFEST)
        remote_site = base.read(sftp, SITE_PATH)
        if hashlib.sha256(remote_site).hexdigest() != SITE_BASELINE_SHA256:
            raise RuntimeError("Live website changed since inspection; refusing to overwrite it")

        manifest = {
            "versionCode": VERSION_CODE,
            "version": VERSION,
            "file": APK_NAME,
            "channel": "stable",
            "platform": "android",
            "arch": "arm64-v8a",
            "minAndroid": "7.0",
            "date": DATE,
            "publishedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "size": size,
            "sha256": digest,
            "notes": release_notes,
            "sourceCommit": source_commit,
        }
        versions = [
            entry for entry in old_versions.get("versions", []) if entry.get("file") != APK_NAME
        ]
        versions.insert(0, {"version": f"v{VERSION}", "file": APK_NAME})
        versions_document = {**old_versions, "channel": "android", "versions": versions}

        backup_suffix = f".bak-{VERSION}"
        base.atomic_write(sftp, STABLE_ROOT + "/latest.json" + backup_suffix, old_latest_bytes)
        base.atomic_write(sftp, STABLE_ROOT + "/versions.json" + backup_suffix, old_versions_bytes)
        base.atomic_write(sftp, SITE_PATH + backup_suffix, remote_site)

        temporary_apk = STABLE_ROOT + "/" + APK_NAME + ".upload"
        last_report = [0.0]

        def progress(transferred, total):
            now = time.monotonic()
            if now - last_report[0] >= 20 or transferred == total:
                print(f"APK upload: {transferred}/{total} ({transferred / total:.0%})", flush=True)
                last_report[0] = now

        sftp.put(str(APK), temporary_apk, callback=progress)
        remote_digest = base.run(client, "sha256sum " + shlex.quote(temporary_apk)).split()[0]
        if remote_digest != digest:
            raise RuntimeError("Uploaded APK checksum mismatch")
        sftp.chmod(temporary_apk, 0o644)
        sftp.posix_rename(temporary_apk, STABLE_ROOT + "/" + APK_NAME)

        base.atomic_write(sftp, STABLE_ROOT + "/" + APK_NAME + ".sha256", digest + "\n")
        base.atomic_write(sftp, STABLE_ROOT + "/last.sha256", digest + "\n")
        base.atomic_write(
            sftp,
            STABLE_ROOT + "/versions.json",
            json.dumps(versions_document, ensure_ascii=False, indent=2) + "\n",
        )
        base.atomic_write(
            sftp,
            STABLE_ROOT + "/latest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        )
        base.atomic_write(sftp, SITE_PATH, SITE_SOURCE.read_bytes())

        published = json.loads(base.read(sftp, STABLE_ROOT + "/latest.json"))
        if published != manifest:
            raise RuntimeError("Published stable manifest readback does not match")
        published_digest = base.run(
            client, "sha256sum " + shlex.quote(STABLE_ROOT + "/" + APK_NAME)
        ).split()[0]
        if published_digest != digest:
            raise RuntimeError("Published stable APK checksum mismatch")
        if base.read(sftp, SITE_PATH) != SITE_SOURCE.read_bytes():
            raise RuntimeError("Published website readback does not match")
        if base.read(sftp, TEST_MANIFEST) != test_before:
            raise RuntimeError("Test manifest changed during stable publication")

        print(
            json.dumps(
                {
                    "version": VERSION,
                    "versionCode": VERSION_CODE,
                    "file": APK_NAME,
                    "sha256": digest,
                    "size": size,
                    "sourceCommit": source_commit,
                    "testManifestUnchanged": True,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    finally:
        client.close()


if __name__ == "__main__":
    main()
