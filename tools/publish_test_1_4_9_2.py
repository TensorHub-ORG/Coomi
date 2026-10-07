import argparse
import difflib
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shlex
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from deploy_release import connect, parse_ssh_config

VERSION = '1.4.9-test.2'
VERSION_CODE = 81
DATE = '2026-10-08'
HEADING = f'v{VERSION} 更新说明【测试】'
NAME = f'Coomi-Android-arm64-v{VERSION}.apk'
BASE = '/www/wwwroot/updates.septemc.com/coomi/android_test'
STABLE = '/www/wwwroot/updates.septemc.com/coomi/android/latest.json'
SITE = '/www/wwwroot/coomi.septemc.com/index.html'
OUTPUT = ROOT / 'build' / 'release-test2'


class ElementSpan(HTMLParser):
    def __init__(self, text, tag, attribute, value):
        super().__init__(convert_charrefs=False)
        self.text = text
        self.tag = tag
        self.attribute = attribute
        self.value = value
        self.depth = 0
        self.start = None
        self.span = None
        self.offsets = [0]
        for line in text.splitlines(keepends=True):
            self.offsets.append(self.offsets[-1] + len(line))
        self.feed(text)

    def position(self):
        line, column = self.getpos()
        return self.offsets[line - 1] + column

    def handle_starttag(self, tag, attrs):
        if self.span or tag != self.tag:
            return
        if self.start is not None:
            self.depth += 1
        elif dict(attrs).get(self.attribute) == self.value:
            start = self.position()
            self.start = (start, start + len(self.get_starttag_text()))
            self.depth = 1

    def handle_endtag(self, tag):
        if self.span or self.start is None or tag != self.tag:
            return
        self.depth -= 1
        if self.depth == 0:
            end = self.position()
            self.span = (*self.start, end, self.text.index('>', end) + 1)


def element_span(text, tag, attribute, value):
    result = ElementSpan(text, tag, attribute, value).span
    if result is None:
        raise ValueError(f'Missing complete {tag}[{attribute}={value}]')
    return result


def notes_text():
    return (ROOT / 'docs' / 'releases' / f'v{VERSION}.md').read_text(encoding='utf-8').lstrip('# ').strip()


def build_site(site, previous, notes):
    stable_span = element_span(site, 'div', 'data-channel-panel', 'stable')
    stable_before = site[stable_span[0]:stable_span[3]]
    previous_heading = f"v{previous['version']} 更新说明【测试】"
    misplaced = re.compile(r'\s*<div class="rel-head"><strong>' + re.escape(previous_heading)
                           + r'</strong>.*?</div>\s*<ul class="rel-list">.*?</ul>', re.S)
    site = misplaced.sub('', site)
    start, open_end, close_start, end = element_span(site, 'div', 'data-channel-panel', 'test')
    body = site[open_end:close_start]
    history_start, history_open, history_close, history_end = element_span(body, 'details', 'class', 'changelog-history')
    latest = body[:history_start].strip()
    if HEADING not in latest:
        old_history = body[history_open:history_close]
        if '展开全部更新记录' not in old_history:
            raise ValueError('Unexpected test changelog structure')
        inner_start, inner_open, inner_close, inner_end = element_span(old_history, 'div', 'class', 'history-inner')
        old_latest = re.sub(r'<h2\b[^>]*>(.*?)</h2>', r'<h3 class="history-version">\1</h3>', latest, count=1, flags=re.S)
        previous_block = ''
        if previous_heading not in latest:
            previous_notes = previous.get('notes', '').strip()
            if previous_notes.startswith(previous_heading):
                previous_notes = previous_notes[len(previous_heading):].strip()
            previous_block = (f'<h3 class="history-version">{html.escape(previous_heading)}</h3>\n'
                              f'<p class="changelog-sub">{html.escape(previous.get("date", ""))} 发布</p>\n'
                              f'<div style="white-space:pre-wrap">{html.escape(previous_notes)}</div>\n')
        bullets = [line[2:] for line in notes.splitlines() if line.startswith('- ')]
        if not bullets:
            raise ValueError('Release notes have no changes')
        latest_block = (f'<h2 class="changelog-title">{HEADING}</h2>\n'
                        f'<p class="changelog-sub">{DATE} 发布 · 基于 1.5.1o2 底座，仅测试通道</p>\n'
                        '<ul class="changelog-list">\n' + ''.join(f'<li>{html.escape(item)}</li>\n' for item in bullets) + '</ul>\n')
        new_body = ('\n' + latest_block + '<details class="changelog-history">\n'
                    '<summary>展开全部更新记录</summary>\n<div class="history-inner">\n'
                    + previous_block + old_latest + '\n' + old_history[inner_open:inner_close].rstrip()
                    + '\n</div>\n</details>\n' + body[history_end:])
        site = site[:open_end] + new_body + site[close_start:]
    download_url = f'https://updates.septemc.com/coomi/android_test/{NAME}'
    def replace_download(match):
        return re.sub(r'href="[^"]*"', f'href="{download_url}"', match.group(0), count=1)
    site, replacements = re.subn(r'<a\b[^>]*data-stat-action="download-test"[^>]*>', replace_download, site)
    if replacements != 1:
        raise ValueError('Expected one test download button')
    stable_span = element_span(site, 'div', 'data-channel-panel', 'stable')
    if site[stable_span[0]:stable_span[3]] != stable_before:
        raise ValueError('Stable release panel must not change')
    return site


def write_preview(site, previous, notes):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    updated = build_site(site, previous, notes)
    (OUTPUT / 'site-test2.html').write_text(updated, encoding='utf-8')
    local = (ROOT / 'server' / 'site' / 'index.html').read_text(encoding='utf-8')
    local_updated = build_site(local, previous, notes)
    diff = list(difflib.unified_diff(local.splitlines(keepends=True), local_updated.splitlines(keepends=True), n=3))
    hunks = ['@@\n' if line.startswith('@@ ') else line for line in diff[2:]]
    patch = ('*** Begin Patch\n*** Update File: server/site/index.html\n' + ''.join(hunks)
             + '*** Update File: server/site/index.remote.html\n' + ''.join(hunks) + '*** End Patch\n')
    (OUTPUT / 'site.patch').write_text(patch, encoding='utf-8')
    return updated


def newest_test_section(site):
    start, open_end, close_start, end = element_span(site, 'div', 'data-channel-panel', 'test')
    body = site[open_end:close_start]
    history_start, history_open, history_close, history_end = element_span(body, 'details', 'class', 'changelog-history')
    return body[:history_start].strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ssh-config', required=True)
    parser.add_argument('--apk', type=Path, default=ROOT / 'apps/coomi-app/app/build/outputs/apk/release/coomi-app_apt-android-7-release_arm64-v8a.apk')
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    client = connect(parse_ssh_config(args.ssh_config))
    try:
        with client.open_sftp() as sftp:
            def read(remote):
                with sftp.open(remote, 'rb') as stream:
                    return stream.read()
            def run(command):
                _, stdout, stderr = client.exec_command(command, timeout=300)
                output = stdout.read().decode('utf-8', 'replace')
                error = stderr.read().decode('utf-8', 'replace')
                if stdout.channel.recv_exit_status():
                    raise RuntimeError(error or output)
                return output.strip()
            def atomic(remote, content):
                temporary = remote + '.test2-upload'
                with sftp.open(temporary, 'wb') as stream:
                    stream.write(content)
                sftp.chmod(temporary, 0o644)
                sftp.posix_rename(temporary, remote)
            stable_before = read(STABLE)
            previous_bytes = read(BASE + '/latest.json')
            previous = json.loads(previous_bytes)
            if int(previous['versionCode']) > VERSION_CODE:
                raise ValueError('A newer test release already exists; refusing to overwrite it')
            if int(previous['versionCode']) == VERSION_CODE and previous['version'] != VERSION:
                raise ValueError('versionCode is already used by another release')
            site_before = read(SITE)
            notes = notes_text()
            updated_site = write_preview(site_before.decode('utf-8'), previous, notes)
            if args.prepare:
                print('Prepared test site preview and focused source patch; server unchanged')
                return
            reviewed_site = (ROOT / 'server/site/index.html').read_text(encoding='utf-8')
            if newest_test_section(reviewed_site) != newest_test_section(updated_site):
                raise ValueError('Reviewed site source differs from server preview; rerun --prepare and apply site.patch')
            with args.apk.open('rb') as content:
                digest = hashlib.file_digest(content, 'sha256').hexdigest()
            history = previous.get('notes', '')
            if previous['version'] == VERSION:
                history = history[len(notes):].lstrip() if history.startswith(notes) else ''
            manifest = {'version': VERSION, 'versionCode': VERSION_CODE, 'channel': 'test', 'platform': 'android',
                        'arch': 'arm64-v8a', 'minAndroid': '7.0', 'date': DATE, 'file': NAME,
                        'size': args.apk.stat().st_size, 'sha256': digest, 'notes': notes + ('\n\n' + history if history else '')}
            manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
            (OUTPUT / 'latest.json').write_bytes(manifest_bytes)
            stamp = str(int(time.time()))
            atomic(SITE + '.bak-test2-' + stamp, site_before)
            atomic(BASE + '/latest.json.bak-test2-' + stamp, previous_bytes)
            temporary_apk = BASE + '/' + NAME + '.upload'
            last_progress = [0.0]
            def progress(done, total):
                if time.monotonic() - last_progress[0] > 10:
                    print(f'Uploading APK: {done / total:.0%}', flush=True)
                    last_progress[0] = time.monotonic()
            sftp.put(str(args.apk), temporary_apk, callback=progress)
            remote_digest = run('sha256sum ' + shlex.quote(temporary_apk)).split()[0]
            if remote_digest != digest:
                raise ValueError('Uploaded APK SHA256 differs from local artifact')
            sftp.chmod(temporary_apk, 0o644)
            sftp.posix_rename(temporary_apk, BASE + '/' + NAME)
            atomic(BASE + '/' + NAME + '.sha256', (digest + '\n').encode())
            try:
                versions_bytes = read(BASE + '/versions.json')
                versions = json.loads(versions_bytes)
                atomic(BASE + '/versions.json.bak-test2-' + stamp, versions_bytes)
            except FileNotFoundError:
                versions = {}
            entries = [entry for entry in versions.get('versions', []) if entry.get('version') != 'v' + VERSION]
            versions.update(channel='android_test', versions=[{'version': 'v' + VERSION, 'file': NAME}] + entries)
            atomic(BASE + '/versions.json', (json.dumps(versions, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
            atomic(BASE + '/last.sha256', (digest + '\n').encode())
            atomic(BASE + '/latest.json', manifest_bytes)
            atomic(SITE, updated_site.encode('utf-8'))
            if read(STABLE) != stable_before:
                raise ValueError('Stable manifest changed unexpectedly')
            if read(BASE + '/latest.json') != manifest_bytes or read(SITE).decode('utf-8') != updated_site:
                raise ValueError('Release metadata read-back differs')
            print(json.dumps({'version': VERSION, 'versionCode': VERSION_CODE, 'file': NAME,
                              'sha256': digest, 'size': manifest['size'], 'stableUnchanged': True}, ensure_ascii=False))
    finally:
        client.close()


if __name__ == '__main__':
    main()
