"""Publish the signed 1.4.8-test.4 APK to the existing Android test channel.

Credentials are read from the existing external SSH configuration. Uploads are
staged, verified on the server and renamed before latest.json is switched.
"""
import argparse
import hashlib
import html
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time

import paramiko

ROOT = Path(__file__).resolve().parents[1]
VERSION = '1.4.8-test.4'
CODE = 70
NAME = f'Coomi-Android-arm64-v{VERSION}.apk'
BASE = '/www/wwwroot/updates.septemc.com/coomi/android_test'
APK = ROOT / 'apps/coomi-app/app/build/outputs/apk/release/coomi-app_apt-android-7-release_arm64-v8a.apk'

def connect():
    spec = importlib.util.spec_from_file_location('previous_test_release', ROOT / 'tools/deploy_test_1_4_8_test_3.py')
    previous = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(previous)
    cfg = previous.parse_ssh_config(os.environ.get('COOMI_DEPLOY_SSH_CONFIG', previous.SSH_CFG))
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(cfg['host'], port=cfg['port'], username=cfg['user'], password=cfg['password'],
                   timeout=30, allow_agent=False, look_for_keys=False)
    return client

def run(client, command):
    _, output, error = client.exec_command(command, timeout=120)
    text, err = output.read().decode(), error.read().decode()
    if output.channel.recv_exit_status():
        raise RuntimeError(err or text)
    return text.strip()

def read(sftp, path):
    with sftp.open(path, 'rb') as file:
        return file.read()

def atomic_write(sftp, path, content):
    tmp = path + '.upload-test4'
    with sftp.open(tmp, 'wb') as file:
        file.write(content if isinstance(content, bytes) else content.encode('utf-8'))
    sftp.chmod(tmp, 0o644)
    sftp.posix_rename(tmp, path)

def website_update(source):
    marker = '<div data-channel-panel="test" hidden>'
    if f'v{VERSION} 更新说明' in source:
        return source
    if marker not in source or 'Coomi-Android-arm64-v1.4.8-test.3.apk' not in source:
        raise RuntimeError('Website baseline does not contain expected test.3 entry')
    notes = (ROOT / 'docs/releases/v1.4.8-test.4.md').read_text(encoding='utf-8')
    items = [line[2:] for line in notes.splitlines() if line.startswith('- ')]
    block = '\n<h2 class="changelog-title">v'+VERSION+' 更新说明【测试】</h2>\n<p class="changelog-sub">2026-09-13 发布</p>\n<ul class="changelog-list">\n'
    block += '\n'.join('<li>'+html.escape(item)+'</li>' for item in items) + '\n</ul>\n'
    source = source.replace('Coomi-Android-arm64-v1.4.8-test.3.apk', NAME)
    return source.replace(marker, marker + block, 1)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--inspect', action='store_true')
    parser.add_argument('--site-path')
    parser.add_argument('--prepare-site', action='store_true')
    args = parser.parse_args()
    client = connect()
    try:
        sftp = client.open_sftp()
        if args.inspect:
            for name in sftp.listdir('/www/server/panel/vhost/nginx'):
                if name.endswith('.conf') and ('coomi' in name or 'septem' in name):
                    config = read(sftp, '/www/server/panel/vhost/nginx/' + name).decode('utf-8')
                    print(name, re.findall(r'^\s*(?:server_name|root)\s+[^;]+;', config, re.M), flush=True)
            print('test_manifest', json.loads(read(sftp, BASE+'/latest.json'))['version'], flush=True)
            return
        if args.prepare_site:
            if not args.site_path:
                parser.error('--prepare-site requires --site-path')
            source = read(sftp, args.site_path).decode('utf-8')
            updated = website_update(source)
            for name in ['index.html', 'index.remote.html']:
                (ROOT/'server/site'/name).write_text(updated, encoding='utf-8')
            print('Website source prepared from live baseline', flush=True)
            return
        digest = hashlib.file_digest(APK.open('rb'), 'sha256').hexdigest()
        old_bytes = read(sftp, BASE+'/latest.json')
        old = json.loads(old_bytes)
        if old['versionCode'] >= CODE:
            raise RuntimeError('Refusing to overwrite same or newer release')
        stable_path = '/www/wwwroot/updates.septemc.com/coomi/android/latest.json'
        stable = read(sftp, stable_path)
        versions = json.loads(read(sftp, BASE+'/versions.json'))
        source_commit = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
        notes = (ROOT/'docs/releases/v1.4.8-test.4.md').read_text(encoding='utf-8').lstrip('# ')
        manifest = dict(versionCode=CODE, version=VERSION, file=NAME, channel='test', platform='android',
                        arch='arm64-v8a', minAndroid='7.0', date='2026-09-13', size=APK.stat().st_size,
                        sha256=digest, notes=notes+'\n\n'+old.get('notes',''), sourceCommit=source_commit)
        site_source = None
        if args.site_path:
            site_source = read(sftp, args.site_path)
            expected = website_update(site_source.decode('utf-8'))
            if expected != (ROOT/'server/site/index.html').read_text(encoding='utf-8'):
                raise RuntimeError('Website changed since preparation; refresh baseline first')
        backup = f'.bak-{VERSION}'
        atomic_write(sftp, BASE+'/latest.json'+backup, old_bytes)
        atomic_write(sftp, BASE+'/versions.json'+backup, read(sftp, BASE+'/versions.json'))
        tmp = BASE+'/'+NAME+'.upload'
        last = [0.0]
        def progress(done,total):
            if time.monotonic()-last[0] > 25 or done == total:
                print(f'Upload {done}/{total} ({done/total:.0%})',flush=True); last[0]=time.monotonic()
        sftp.put(str(APK), tmp, callback=progress)
        remote_hash = run(client, 'sha256sum '+shlex.quote(tmp)).split()[0]
        if remote_hash != digest:
            raise RuntimeError('Uploaded APK checksum mismatch')
        sftp.chmod(tmp, 0o644)
        sftp.posix_rename(tmp, BASE+'/'+NAME)
        atomic_write(sftp, BASE+'/'+NAME+'.sha256', digest+'\n')
        versions['versions'] = [{'version':'v'+VERSION,'file':NAME}]+[v for v in versions.get('versions',[]) if v.get('file') != NAME]
        versions['channel']='android_test'
        atomic_write(sftp, BASE+'/versions.json', json.dumps(versions,ensure_ascii=False,indent=2))
        atomic_write(sftp, BASE+'/last.sha256', digest+'\n')
        atomic_write(sftp, BASE+'/latest.json', json.dumps(manifest,ensure_ascii=False,indent=2))
        if args.site_path:
            atomic_write(sftp, args.site_path+backup, site_source)
            atomic_write(sftp, args.site_path, (ROOT/'server/site/index.html').read_bytes())
        if read(sftp, stable_path) != stable:
            raise RuntimeError('Stable manifest changed during publication; inspect external concurrent activity')
        assert json.loads(read(sftp, BASE+'/latest.json'))['sha256'] == digest
        print(json.dumps({'version':VERSION,'versionCode':CODE,'sha256':digest,'size':manifest['size'],'sourceCommit':source_commit}),flush=True)
    finally:
        client.close()

if __name__ == '__main__':
    main()
