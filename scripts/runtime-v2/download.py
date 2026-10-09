"""Download the pinned offline runtime, verifying cached and new archives."""

import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
ASSETS = {"host": "proot-host-arm64.tar.gz", "rootfs": "ubuntu-noble-arm64.tar.gz"}


def verified(path, asset):
    if not path.is_file() or path.stat().st_size != asset["size"]:
        return False
    with path.open("rb") as content:
        return hashlib.file_digest(content, "sha256").hexdigest() == asset["sha256"]


def resolve_manifest(manifest, repository):
    if manifest["version"] != 2 or manifest["architecture"] != "arm64-v8a":
        raise ValueError("Expected an ARM64 Runtime V2 manifest")
    if repository and not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Runtime repository must be owner/repository")
    resolved = {**manifest}
    tags = set()
    for key, name in ASSETS.items():
        asset = {**manifest[key]}
        url = urlsplit(asset["url"])
        match = re.fullmatch(r"/[^/]+/[^/]+/releases/download/(runtime-v2-[A-Za-z0-9._-]+)/" + re.escape(name), url.path)
        if url.scheme != "https" or url.netloc != "github.com" or not match or url.query or url.fragment:
            raise ValueError(f"Invalid immutable GitHub runtime URL for {key}")
        if not re.fullmatch(r"[0-9a-f]{64}", asset["sha256"]) or type(asset["size"]) is not int or asset["size"] <= 0:
            raise ValueError(f"Invalid runtime checksum or size for {key}")
        tag = match[1]
        tags.add(tag)
        if repository:
            asset["url"] = f"https://github.com/{repository}/releases/download/{tag}/{name}"
        resolved[key] = asset
    if len(tags) != 1:
        raise ValueError("Runtime archives must belong to the same release")
    return resolved


def download_runtime(manifest, directory, opener=urlopen):
    directory.mkdir(parents=True, exist_ok=True)
    for key, name in ASSETS.items():
        asset = manifest[key]
        target = directory / name
        if verified(target, asset):
            print(f"Verified cached {name}", flush=True)
            continue
        temporary = directory / (name + ".part")
        print(f"Downloading {asset['url']}", flush=True)
        try:
            request = Request(asset["url"], headers={"User-Agent": "Coomi-runtime-build"})
            with opener(request, timeout=120) as response, temporary.open("wb") as output:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > asset["size"]:
                        raise ValueError(f"Downloaded {name} exceeds pinned size")
                    output.write(chunk)
            if not verified(temporary, asset):
                raise ValueError(f"Downloaded {name} does not match pinned checksum and size")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    (directory / "runtime-v2-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path,
                        default=ROOT / "apps/coomi-app/app/src/main/assets/runtime-v2-manifest.json")
    parser.add_argument("--repository", default="")
    parser.add_argument("--output", type=Path, default=ROOT / "runtime-v2-dist")
    args = parser.parse_args()
    manifest = resolve_manifest(json.loads(args.manifest.read_text(encoding="utf-8")), args.repository)
    download_runtime(manifest, args.output)


if __name__ == "__main__":
    main()
