"""Publish a verified Actions artifact to Coomi's website and update channel."""

import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shlex
import time

UPDATE_ROOT = "/www/wwwroot/updates.septemc.com/coomi"
SITE_PATH = "/www/wwwroot/coomi.septemc.com/index.html"
UPDATE_URL = "https://updates.septemc.com/coomi"


def channel_directory(channel):
    return {"stable": "android", "test": "android_test"}[channel]


def replace_once(pattern, replacement, content):
    if len(re.findall(pattern, content, re.DOTALL)) != 1:
        raise ValueError(f"Website markup differs from the expected template: {pattern}")
    return re.sub(pattern, lambda match: replacement(match), content, count=1, flags=re.DOTALL)


def update_website(website, manifest):
    channel = manifest["channel"]
    label = "稳定" if channel == "stable" else "测试"
    heading = f"v{manifest['version']} 更新说明【{label}】"
    if heading in website:
        raise ValueError("Website already contains this version")
    notes = [line.strip() for line in manifest["notes"].splitlines()
             if line.strip() and not line.lstrip().startswith("#")]
    items = "\n".join(f"<li>{html.escape(line.lstrip('- '))}</li>" for line in notes)
    block = (f'<h2 class="changelog-title">{heading}</h2>\n'
             f'<p class="changelog-sub">{manifest["date"]} 发布</p>\n'
             f'<ul class="changelog-list">\n{items}\n</ul>\n')
    # Move the former latest entry into its existing history container.
    pattern = (rf'(<div data-channel-panel="{channel}"[^>]*>)(.*?)'
               r'(<details class="changelog-history">\s*<summary>展开全部更新记录</summary>\s*'
               r'<div class="history-inner">)')
    website = replace_once(pattern, lambda m: m[1] + "\n" + block + m[3] + m[2], website)
    url = f"{UPDATE_URL}/{channel_directory(channel)}/{manifest['file']}"
    if channel == "stable":
        website = replace_once(r'(<a id="downloadButtonAndroid"[^>]*href=")[^"]+("[^>]*>)',
                               lambda m: m[1] + url + m[2], website)
        for element, value in (("versionValue", manifest["version"]),
                               ("releaseBadge", "Android " + manifest["version"])):
            website = replace_once(rf'(<[^>]+id="{element}"[^>]*>)[^<]*(</[^>]+>)',
                                   lambda m: m[1] + value + m[2], website)
    else:
        website = replace_once(r'(<a[^>]*href=")[^"]+("[^>]*data-stat-action="download-test"[^>]*>)',
                               lambda m: m[1] + url + m[2], website)
    return website


def check_version(manifest, current, other):
    if manifest["versionCode"] <= max(current["versionCode"], other["versionCode"]):
        raise ValueError("versionCode must exceed both published Android channels")


def read(sftp, path):
    with sftp.open(path, "rb") as content:
        return content.read()


def atomic_write(sftp, path, data):
    temporary = path + ".actions-upload"
    with sftp.open(temporary, "wb") as content:
        content.write(data)
    sftp.chmod(temporary, 0o644)
    sftp.posix_rename(temporary, path)


def remote_hash(client, path):
    _, output, error = client.exec_command("sha256sum " + shlex.quote(path), timeout=180)
    result = output.read().decode()
    if output.channel.recv_exit_status() != 0:
        raise RuntimeError(error.read().decode())
    return result.split()[0]


def encode_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def publish(client, directory):
    manifest = json.loads((directory / "latest.json").read_text(encoding="utf-8"))
    if manifest["mode"] != "release" or manifest["applicationId"] != "com.coomi.android":
        raise ValueError("Only official Coomi releases can be deployed to the update source")
    apk = directory / manifest["file"]
    with apk.open("rb") as content:
        digest = hashlib.file_digest(content, "sha256").hexdigest()
    if digest != manifest["sha256"] or apk.stat().st_size != manifest["size"]:
        raise ValueError("Release APK does not match latest.json")
    root = f"{UPDATE_ROOT}/{channel_directory(manifest['channel'])}"
    other = "test" if manifest["channel"] == "stable" else "stable"
    other_path = f"{UPDATE_ROOT}/{channel_directory(other)}/latest.json"
    lock = UPDATE_ROOT + "/.actions-release.lock"
    _, output, error = client.exec_command("mkdir " + shlex.quote(lock), timeout=30)
    if output.channel.recv_exit_status() != 0:
        raise RuntimeError("Another deployment holds the release lock: " + error.read().decode())
    try:
        with client.open_sftp() as sftp:
            paths = [root + "/latest.json", root + "/versions.json", SITE_PATH]
            originals = {path: read(sftp, path) for path in paths}
            other_before = read(sftp, other_path)
            check_version(manifest, json.loads(originals[paths[0]]), json.loads(other_before))
            versions = json.loads(originals[paths[1]])
            versions["versions"].insert(0, {"version": f"v{manifest['version']}", "file": manifest["file"]})
            website = update_website(originals[SITE_PATH].decode("utf-8"), manifest).encode("utf-8")
            temporary = root + "/" + manifest["file"] + ".actions-upload"
            last_report = [0.0]

            def progress(done, total):
                now = time.monotonic()
                if now - last_report[0] >= 20 or done == total:
                    print(f"APK upload: {done}/{total}", flush=True)
                    last_report[0] = now

            sftp.put(str(apk), temporary, callback=progress)
            if remote_hash(client, temporary) != digest:
                raise ValueError("Uploaded APK checksum mismatch")
            if any(read(sftp, path) != data for path, data in originals.items()) or read(sftp, other_path) != other_before:
                raise ValueError("Website or update metadata changed during upload")
            sftp.chmod(temporary, 0o644)
            sftp.posix_rename(temporary, root + "/" + manifest["file"])
            atomic_write(sftp, root + "/" + manifest["file"] + ".sha256",
                         f"{digest}  {manifest['file']}\n".encode())
            replacements = {paths[1]: encode_json(versions), SITE_PATH: website, paths[0]: encode_json(manifest)}
            changed = []
            try:
                for path, data in replacements.items():
                    atomic_write(sftp, path, data)
                    changed.append(path)
                    if read(sftp, path) != data:
                        raise ValueError("Published metadata readback mismatch")
            except Exception:
                for path in reversed(changed):
                    atomic_write(sftp, path, originals[path])
                raise
            print(f"Published {manifest['tag']} to {manifest['channel']}", flush=True)
    finally:
        client.exec_command("rmdir " + shlex.quote(lock), timeout=30)


def main():
    import paramiko

    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--known-hosts", type=Path, required=True)
    args = parser.parse_args()
    client = paramiko.SSHClient()
    client.load_host_keys(str(args.known_hosts))
    try:
        client.connect(os.environ["COOMI_DEPLOY_HOST"], port=int(os.environ.get("COOMI_DEPLOY_PORT") or "22"),
                       username=os.environ["COOMI_DEPLOY_USER"], key_filename=str(args.key),
                       timeout=30, allow_agent=False, look_for_keys=False)
        publish(client, args.directory)
    finally:
        client.close()


if __name__ == "__main__":
    main()
