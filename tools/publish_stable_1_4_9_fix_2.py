"""Prepare and atomically publish the Android v1.4.9-fix.2 stable release.

用法:
  python tools/publish_stable_1_4_9_fix_2.py --prepare   # 仅本地生成官网与清单（服务器不变）
  python tools/publish_stable_1_4_9_fix_2.py             # 校验基线后原子发布到服务器
"""
import argparse
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from deploy_release import connect, parse_ssh_config
from publish_test_1_4_9_2 import element_span

VERSION = '1.4.9-fix.2'
CODE = 85
NAME = f'Coomi-Android-arm64-v{VERSION}.apk'
BASE = '/www/wwwroot/updates.septemc.com/coomi/android'
SITE = '/www/wwwroot/coomi.septemc.com/index.html'
TEST = '/www/wwwroot/updates.septemc.com/coomi/android_test/latest.json'
OUT = ROOT / 'build/release-v149-fix2'
APK_SOURCE = ROOT / 'apps/coomi-app/app/build/outputs/apk/release/coomi-app_apt-android-7-release_arm64-v8a.apk'
DATE = '2026-10-09'
HEADING = f'v{VERSION} 更新说明【稳定】'


def build_site(site):
    _, begin, finish, _ = element_span(site, 'div', 'data-channel-panel', 'stable')
    body = site[begin:finish]
    history, opening, closing, end = element_span(body, 'details', 'class', 'changelog-history')
    old_latest = re.sub(r'<h2\b[^>]*>(.*?)</h2>', r'<h3 class="history-version">\1</h3>', body[:history].strip(), count=1, flags=re.S)
    _, inner_begin, inner_end, _ = element_span(body[opening:closing], 'div', 'class', 'history-inner')
    old_history = body[opening:closing][inner_begin:inner_end]
    notes = (ROOT / 'docs/releases/v1.4.9-fix.2.md').read_text(encoding='utf-8')
    bullets = [line[2:] for line in notes.splitlines() if line.startswith('- ')]
    latest = f'<h2 class="changelog-title">{HEADING}</h2>\n<p class="changelog-sub">{DATE} 发布 · Android 7.0+ · ARM64</p>\n<ul class="changelog-list">\n'
    latest += ''.join(f'<li>{html.escape(item)}</li>\n' for item in bullets) + '</ul>\n'
    body = '\n' + latest + '<details class="changelog-history">\n<summary>展开全部更新记录</summary>\n<div class="history-inner">\n' + old_latest + '\n' + old_history + '\n</div>\n</details>\n' + body[end:]
    site = site[:begin] + body + site[finish:]
    site, count = re.subn(r'(<a\b[^>]*id="downloadButtonAndroid"[^>]*href=")[^"]*(")', rf'\g<1>https://updates.septemc.com/coomi/android/{NAME}\2', site)
    if count != 1:
        raise ValueError('Expected exactly one stable Android download link')
    site = re.sub(r'(<span id="versionValue"[^>]*>)[^<]*(</span>)', rf'\g<1>{VERSION}\2', site)
    assert site.count(HEADING) == 1
    return site


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    baseline = (OUT / 'site-baseline.html').read_bytes()
    site = build_site(baseline.decode('utf-8')).encode('utf-8')
    for path in ['server/site/index.html', 'server/site/index.remote.html']:
        (ROOT / path).write_bytes(site)
    (OUT / 'site-reviewed.html').write_bytes(site)
    apk = OUT / NAME
    apk.write_bytes(APK_SOURCE.read_bytes())
    digest = hashlib.file_digest(apk.open('rb'), 'sha256').hexdigest()
    (OUT / f'{NAME}.sha256').write_text(digest + '\n', encoding='ascii')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    notes = (ROOT / 'docs/releases/v1.4.9-fix.2.md').read_text(encoding='utf-8').removeprefix('# ').strip()
    manifest = dict(version=VERSION, versionCode=CODE, file=NAME, channel='stable', platform='android', arch='arm64-v8a', minAndroid='7.0', date=DATE, publishedAt=datetime.now(timezone.utc).isoformat(), size=apk.stat().st_size, sha256=digest, notes=notes, sourceCommit=commit)
    document = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    (OUT / 'latest.json').write_bytes(document)
    versions = json.loads((OUT / 'versions-baseline.json').read_text(encoding='utf-8'))
    versions['versions'] = [{'version': 'v' + VERSION, 'file': NAME}] + [v for v in versions.get('versions', []) if v.get('file') != NAME]
    (OUT / 'versions.json').write_text(json.dumps(versions, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Prepared v{VERSION} website, manifest and APK copy (sha256={digest[:16]}...); server unchanged')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ssh-config', type=Path)
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    if args.prepare:
        prepare()
        return
    if subprocess.check_output(['git', 'branch', '--show-current'], cwd=ROOT, text=True).strip() != 'main':
        raise ValueError('Publish from main')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    apk = OUT / NAME
    with apk.open('rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    config = args.ssh_config or next(Path('F:/_WorkSpace/Projects/AILab/SSH-Agent/ssh-configs').glob('ssh-8.148.146.68-*.txt'))
    client = connect(parse_ssh_config(config))
    try:
        with client.open_sftp() as sftp:
            def read(path):
                with sftp.open(path, 'rb') as stream:
                    return stream.read()
            def atomic(path, content):
                with sftp.open(path + '.v149fix2-upload', 'wb') as stream:
                    stream.write(content)
                sftp.chmod(path + '.v149fix2-upload', 0o644)
                sftp.posix_rename(path + '.v149fix2-upload', path)
            def sha(path):
                _, out, err = client.exec_command('sha256sum ' + shlex.quote(path), timeout=300)
                result = out.read().decode()
                if out.channel.recv_exit_status():
                    raise RuntimeError(err.read().decode())
                return result.split()[0]
            site_before = read(SITE)
            if site_before != (OUT / 'site-baseline.html').read_bytes():
                raise ValueError('Live site changed since review')
            old = read(BASE + '/latest.json')
            if old != (OUT / 'stable-baseline.json').read_bytes() or int(json.loads(old)['versionCode']) >= CODE:
                raise ValueError('Stable manifest changed since review or is newer')
            test_before = read(TEST)
            versions_before = read(BASE + '/versions.json')
            if versions_before != (OUT / 'versions-baseline.json').read_bytes():
                raise ValueError('versions.json changed since review')
            stamp = str(int(time.time()))
            for path, content in [(SITE, site_before), (BASE + '/latest.json', old), (BASE + '/versions.json', versions_before)]:
                atomic(path + '.bak-v149fix2-' + stamp, content)
            progress_at = [0.0]
            def progress(done, total):
                if time.monotonic() - progress_at[0] > 15 or done == total:
                    print(f'APK upload: {done / total:.0%}', flush=True)
                    progress_at[0] = time.monotonic()
            temporary = BASE + '/' + NAME + '.upload'
            sftp.put(str(apk), temporary, callback=progress)
            if sha(temporary) != digest:
                raise ValueError('APK upload checksum differs')
            sftp.chmod(temporary, 0o644)
            sftp.posix_rename(temporary, BASE + '/' + NAME)
            atomic(BASE + '/' + NAME + '.sha256', (digest + '\n').encode())
            atomic(BASE + '/last.sha256', (digest + '\n').encode())
            atomic(BASE + '/versions.json', (OUT / 'versions.json').read_bytes())
            document = (OUT / 'latest.json').read_bytes()
            atomic(BASE + '/latest.json', document)
            site = (OUT / 'site-reviewed.html').read_bytes()
            atomic(SITE, site)
            assert read(SITE) == site and read(BASE + '/latest.json') == document
            assert read(TEST) == test_before and sha(BASE + '/' + NAME) == digest
            (OUT / 'deployment-report.json').write_text(json.dumps(dict(version=VERSION, commit=commit, sha256=digest, verified=True), indent=2), encoding='utf-8')
            print('Stable APK, manifests and website published and verified')
    finally:
        client.close()


if __name__ == '__main__':
    main()
