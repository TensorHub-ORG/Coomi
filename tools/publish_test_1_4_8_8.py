"""Publish the signed 1.4.8-test.8 APK and its website notes to the test channel."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time

import paramiko

from verify_android_bundle import verify as verify_bundle


ROOT = Path(__file__).resolve().parents[1]
VERSION = "1.4.8-test.8"
VERSION_CODE = 74
DATE = "2026-09-14"
APK_NAME = f"Coomi-Android-arm64-v{VERSION}.apk"
APK = ROOT / "apps/coomi-app/app/build/outputs/apk/release/coomi-app_apt-android-7-release_arm64-v8a.apk"
TEST_ROOT = "/www/wwwroot/updates.septemc.com/coomi/android_test"
STABLE_MANIFEST = "/www/wwwroot/updates.septemc.com/coomi/android/latest.json"
SITE_PATH = "/www/wwwroot/coomi.septemc.com/index.html"
SITE_SOURCE = ROOT / "server/site/index.html"
SITE_MIRROR = ROOT / "server/site/index.remote.html"
SITE_BASELINE_SHA256 = "258c0acbd5ceab4d9caa15670aa53663e5aaa24cbac4d28ccc1ff999821e47d7"
PACKAGE_NAME = "com.coomi.android"
SIGNER_SHA256 = "b6da01480eefd5fbf2cd3771b8d1021ec791304bdd6c4bf41d3faabad48ee5e1"


def connect():
    module_path = ROOT / "tools/deploy_test_1_4_8_test_3.py"
    spec = importlib.util.spec_from_file_location("coomi_deploy_config", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    config_path = os.environ.get("COOMI_DEPLOY_SSH_CONFIG", module.SSH_CFG)
    config = module.parse_ssh_config(config_path)
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        config["host"],
        port=config["port"],
        username=config["user"],
        password=config["password"],
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def read(sftp, path):
    with sftp.open(path, "rb") as remote_file:
        return remote_file.read()


def atomic_write(sftp, path, content):
    temporary = path + ".upload-test8"
    payload = content if isinstance(content, bytes) else content.encode("utf-8")
    with sftp.open(temporary, "wb") as remote_file:
        remote_file.write(payload)
    sftp.chmod(temporary, 0o644)
    sftp.posix_rename(temporary, path)


def run(client, command):
    _, stdout, stderr = client.exec_command(command, timeout=180)
    output = stdout.read().decode("utf-8", errors="replace")
    error = stderr.read().decode("utf-8", errors="replace")
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(error or output)
    return output.strip()


def android_build_tools():
    roots = [
        os.environ.get("ANDROID_SDK_ROOT"),
        os.environ.get("ANDROID_HOME"),
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "Android/Sdk"),
    ]
    for root in filter(None, roots):
        build_tools = Path(root) / "build-tools"
        if not build_tools.is_dir():
            continue
        versions = sorted(
            build_tools.iterdir(),
            key=lambda path: tuple(int(part) if part.isdigit() else 0 for part in path.name.split(".")),
            reverse=True,
        )
        for version in versions:
            apksigner = version / ("apksigner.bat" if os.name == "nt" else "apksigner")
            aapt = version / ("aapt.exe" if os.name == "nt" else "aapt")
            if apksigner.is_file() and aapt.is_file():
                return apksigner, aapt
    raise RuntimeError("Android build tools with apksigner and aapt were not found")


def verify_apk_identity():
    apksigner, aapt = android_build_tools()
    signature = subprocess.run(
        [str(apksigner), "verify", "--verbose", "--print-certs", str(APK)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    signer = re.search(r"Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]+)", signature)
    if signer is None or signer.group(1).lower() != SIGNER_SHA256:
        raise RuntimeError("APK signing certificate does not match the official Coomi signer")

    badging = subprocess.run(
        [str(aapt), "dump", "badging", str(APK)],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    ).stdout
    package = re.search(
        r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'",
        badging,
        re.MULTILINE,
    )
    if package is None:
        raise RuntimeError("Unable to read APK package metadata")
    actual_package, actual_code, actual_version = package.groups()
    if (actual_package, actual_code, actual_version) != (
        PACKAGE_NAME,
        str(VERSION_CODE),
        VERSION,
    ):
        raise RuntimeError(
            f"APK identity mismatch: package={actual_package}, code={actual_code}, version={actual_version}"
        )


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
        raise RuntimeError("Release publication requires a clean Git worktree")
    if subprocess.check_output(["git", "branch", "--show-current"], cwd=ROOT, text=True).strip() != "main":
        raise RuntimeError("Release publication requires the main branch")
    if SITE_SOURCE.read_bytes() != SITE_MIRROR.read_bytes():
        raise RuntimeError("Website source and remote mirror are different")
    website = SITE_SOURCE.read_text(encoding="utf-8")
    if website.count(f"v{VERSION} 更新说明【测试】") != 1:
        raise RuntimeError("Website must contain exactly one latest test release heading")
    latest_at = website.index(f"v{VERSION} 更新说明【测试】")
    history_at = website.index("<summary>展开全部更新记录</summary>", latest_at)
    previous_at = website.index("v1.4.8-test.7 更新说明【测试】", latest_at)
    if not latest_at < history_at < previous_at:
        raise RuntimeError("Website history is not folded below the latest release")


def main():
    ensure_release_state()
    verify_bundle(APK)
    verify_apk_identity()

    apk_bytes = APK.read_bytes()
    digest = hashlib.sha256(apk_bytes).hexdigest()
    source_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    release_notes = (ROOT / f"docs/releases/v{VERSION}.md").read_text(encoding="utf-8")
    release_notes = release_notes.removeprefix("# ").strip()

    client = connect()
    try:
        sftp = client.open_sftp()
        old_latest_bytes = read(sftp, TEST_ROOT + "/latest.json")
        old_latest = json.loads(old_latest_bytes)
        if int(old_latest.get("versionCode", 0)) >= VERSION_CODE:
            raise RuntimeError("Refusing to overwrite the same or a newer test release")

        old_versions_bytes = read(sftp, TEST_ROOT + "/versions.json")
        old_versions = json.loads(old_versions_bytes)
        stable_before = read(sftp, STABLE_MANIFEST)
        remote_site = read(sftp, SITE_PATH)
        remote_site_digest = hashlib.sha256(remote_site).hexdigest()
        if remote_site_digest != SITE_BASELINE_SHA256:
            raise RuntimeError(
                "Live website changed since inspection; refusing to overwrite an unknown baseline"
            )

        manifest = {
            "versionCode": VERSION_CODE,
            "version": VERSION,
            "file": APK_NAME,
            "channel": "test",
            "platform": "android",
            "arch": "arm64-v8a",
            "minAndroid": "7.0",
            "date": DATE,
            "size": len(apk_bytes),
            "sha256": digest,
            "notes": release_notes,
            "sourceCommit": source_commit,
        }
        versions = [
            entry
            for entry in old_versions.get("versions", [])
            if entry.get("file") != APK_NAME
        ]
        versions.insert(0, {"version": f"v{VERSION}", "file": APK_NAME})
        versions_document = {**old_versions, "channel": "android_test", "versions": versions}

        backup_suffix = f".bak-{VERSION}"
        atomic_write(sftp, TEST_ROOT + "/latest.json" + backup_suffix, old_latest_bytes)
        atomic_write(sftp, TEST_ROOT + "/versions.json" + backup_suffix, old_versions_bytes)
        atomic_write(sftp, SITE_PATH + backup_suffix, remote_site)

        temporary_apk = TEST_ROOT + "/" + APK_NAME + ".upload"
        last_report = [0.0]

        def progress(transferred, total):
            now = time.monotonic()
            if now - last_report[0] >= 20 or transferred == total:
                print(f"APK upload: {transferred}/{total} ({transferred / total:.0%})", flush=True)
                last_report[0] = now

        sftp.put(str(APK), temporary_apk, callback=progress)
        remote_digest = run(client, "sha256sum " + shlex.quote(temporary_apk)).split()[0]
        if remote_digest != digest:
            raise RuntimeError("Uploaded APK checksum mismatch")
        sftp.chmod(temporary_apk, 0o644)
        sftp.posix_rename(temporary_apk, TEST_ROOT + "/" + APK_NAME)

        atomic_write(sftp, TEST_ROOT + "/" + APK_NAME + ".sha256", digest + "\n")
        atomic_write(sftp, TEST_ROOT + "/last.sha256", digest + "\n")
        atomic_write(
            sftp,
            TEST_ROOT + "/versions.json",
            json.dumps(versions_document, ensure_ascii=False, indent=2) + "\n",
        )
        atomic_write(
            sftp,
            TEST_ROOT + "/latest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        )
        atomic_write(sftp, SITE_PATH, SITE_SOURCE.read_bytes())

        published = json.loads(read(sftp, TEST_ROOT + "/latest.json"))
        if published != manifest:
            raise RuntimeError("Published test manifest readback does not match")
        if hashlib.sha256(read(sftp, TEST_ROOT + "/" + APK_NAME)).hexdigest() != digest:
            raise RuntimeError("Published APK readback checksum mismatch")
        if read(sftp, SITE_PATH) != SITE_SOURCE.read_bytes():
            raise RuntimeError("Published website readback does not match")
        if read(sftp, STABLE_MANIFEST) != stable_before:
            raise RuntimeError("Stable manifest changed during test publication")

        print(
            json.dumps(
                {
                    "version": VERSION,
                    "versionCode": VERSION_CODE,
                    "file": APK_NAME,
                    "sha256": digest,
                    "size": len(apk_bytes),
                    "sourceCommit": source_commit,
                    "stableManifestUnchanged": True,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    finally:
        client.close()


if __name__ == "__main__":
    main()
