import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts/runtime-v2"))
import download


class RuntimeDownloadTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / "apps/coomi-app/app/src/main/assets/runtime-v2-manifest.json").read_text(encoding="utf-8"))
        self.payloads = {"host": b"pinned host", "rootfs": b"pinned rootfs"}
        for key, data in self.payloads.items():
            self.manifest[key].update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
        self.requests = []

    def opener(self, request, timeout):
        self.requests.append(request.full_url)
        key = next(key for key, name in download.ASSETS.items() if request.full_url.endswith(name))
        return io.BytesIO(self.payloads[key])

    def test_selects_runtime_repository_without_changing_checksums(self):
        resolved = download.resolve_manifest(self.manifest, "example/runtime")
        for key in download.ASSETS:
            self.assertIn("https://github.com/example/runtime/releases/download/runtime-v2-", resolved[key]["url"])
            self.assertEqual(resolved[key]["sha256"], self.manifest[key]["sha256"])
            self.assertEqual(resolved[key]["size"], self.manifest[key]["size"])

    def test_downloads_and_writes_verified_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            resolved = download.resolve_manifest(self.manifest, "example/runtime")
            download.download_runtime(resolved, directory, self.opener)
            self.assertEqual(len(self.requests), 2)
            for key, name in download.ASSETS.items():
                self.assertEqual((directory / name).read_bytes(), self.payloads[key])
            self.assertEqual(json.loads((directory / "runtime-v2-manifest.json").read_text()), resolved)

    def test_reuses_verified_cache_without_network(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            for key, name in download.ASSETS.items():
                (directory / name).write_bytes(self.payloads[key])
            download.download_runtime(self.manifest, directory, self.opener)
            self.assertEqual(self.requests, [])

    def test_replaces_corrupted_cache_with_verified_download(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            for key, name in download.ASSETS.items():
                (directory / name).write_bytes(self.payloads[key])
            (directory / download.ASSETS["rootfs"]).write_bytes(b"corrupt")
            download.download_runtime(self.manifest, directory, self.opener)
            self.assertEqual(len(self.requests), 1)
            self.assertTrue(download.verified(directory / download.ASSETS["rootfs"], self.manifest["rootfs"]))

    def test_rejects_tampered_download_and_preserves_existing_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            target = directory / download.ASSETS["host"]
            target.write_bytes(b"existing")
            self.payloads["host"] = b"tampered!!!"
            with self.assertRaisesRegex(ValueError, "checksum"):
                download.download_runtime(self.manifest, directory, self.opener)
            self.assertEqual(target.read_bytes(), b"existing")

    def test_rejects_oversized_download(self):
        with tempfile.TemporaryDirectory() as temp:
            self.payloads["host"] = b"too large" * 20
            with self.assertRaisesRegex(ValueError, "exceeds pinned size"):
                download.download_runtime(self.manifest, Path(temp), self.opener)

    def test_rejects_mutable_or_mixed_runtime_urls(self):
        for url in ("https://github.com/example/runtime/releases/latest/download/proot-host-arm64.tar.gz",
                    "http://github.com/example/runtime/releases/download/runtime-v2-test/proot-host-arm64.tar.gz",
                    self.manifest["host"]["url"].replace("20260907", "different-version")):
            candidate = copy.deepcopy(self.manifest)
            candidate["host"]["url"] = url
            with self.subTest(url=url), self.assertRaises(ValueError):
                download.resolve_manifest(candidate, "example/runtime")


if __name__ == "__main__":
    unittest.main()
