"""Verify the actual release APK contains its complete offline runtime payload."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile


def verify(apk: Path):
    with zipfile.ZipFile(apk) as archive:
        manifest = json.loads(archive.read('assets/runtime-v2-manifest.json'))
        for key, name in [('host', 'proot-host-arm64'), ('rootfs', 'ubuntu-noble-arm64')]:
            asset = f'assets/runtime-v2/{name}.tgz'
            info = archive.getinfo(asset)
            with archive.open(asset) as content:
                digest = hashlib.file_digest(content, 'sha256').hexdigest()
            if info.file_size != manifest[key]['size'] or digest != manifest[key]['sha256']:
                raise ValueError(f'Bundled {key} differs from manifest')
        for library in ['libcoomi.so', 'libtermux-bootstrap.so']:
            info = archive.getinfo(f'lib/arm64-v8a/{library}')
            with archive.open(info) as content:
                header = content.read(20)
            if header[:5] != b'\x7fELF\x02' or int.from_bytes(header[18:20], 'little') != 183:
                raise ValueError(f'{library} is not an ARM64 ELF binary')
            if info.file_size < 1024 * 1024:
                raise ValueError(f'{library} is unexpectedly small')
        with zipfile.ZipFile(io.BytesIO(archive.read('assets/web.zip'))) as web:
            if not web.read('index.html') or web.testzip() is not None:
                raise ValueError('Bundled web assets are invalid')
    print(json.dumps({'apk': str(apk), 'offlineRuntime': manifest['runtime_version'],
                      'verified': ['engine', 'terminal-bootstrap', 'proot', 'ubuntu-rootfs', 'web']}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('apk', type=Path)
    verify(parser.parse_args().apk)
