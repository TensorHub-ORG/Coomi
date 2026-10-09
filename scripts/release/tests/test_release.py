import hashlib
import io
import json
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

RELEASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RELEASE_DIR))
import deploy
import package


def manifest(channel="stable"):
    version = "1.4.9" if channel == "stable" else "1.4.9-test.1"
    return {**package.release_identity(version, 76, f"v{version}", "release"),
            "date": "2026-10-05", "notes": "# 更新说明\n\n- 修复 <界面> & 流式输出",
            "sourceCommit": "a" * 40}


class MemoryFile(io.BytesIO):
    def __init__(self, files, path, mode):
        self.files, self.path, self.mode = files, path, mode
        super().__init__(files[path] if mode == "rb" else b"")

    def close(self):
        if self.mode == "wb":
            self.files[self.path] = self.getvalue()
        super().close()


class Sftp:
    def __init__(self, files):
        self.files = files
        self.fail_site = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def open(self, path, mode):
        return MemoryFile(self.files, path, mode)

    def put(self, source, target, callback):
        self.files[target] = Path(source).read_bytes()
        callback(len(self.files[target]), len(self.files[target]))

    def chmod(self, *_):
        pass

    def posix_rename(self, source, target):
        if self.fail_site and target == deploy.SITE_PATH:
            self.fail_site = False
            raise OSError("Simulated website upload failure")
        self.files[target] = self.files.pop(source)


class Output(io.BytesIO):
    @property
    def channel(self):
        return self

    def recv_exit_status(self):
        return 0


class Client:
    def __init__(self, files):
        self.sftp = Sftp(files)
        self.commands = []

    def open_sftp(self):
        return self.sftp

    def exec_command(self, command, timeout):
        self.commands.append(command)
        args = shlex.split(command)
        result = b""
        if args[0] == "sha256sum":
            result = (hashlib.sha256(self.sftp.files[args[1]]).hexdigest() + "  file\n").encode()
        return None, Output(result), Output()


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.website = (package.ROOT / "server/site/index.html").read_text(encoding="utf-8")

    def test_stable_and_test_channels(self):
        self.assertEqual(package.release_identity("2.0.0", 100, "v2.0.0", "release")["channel"], "stable")
        self.assertEqual(package.release_identity("2.0.0-test.1", 101, "v2.0.0-test.1", "release")["channel"], "test")

    def test_preview_has_independent_package_and_artifact(self):
        identity = package.release_identity("2.0.0", 100, "v2.0.0", "preview")
        self.assertEqual(identity["applicationId"], "com.coomidev.android")
        self.assertEqual(identity["channel"], "preview")
        self.assertEqual(identity["file"], "CoomiDev-Android-arm64-v2.0.0.apk")

    def test_preview_accepts_valid_debug_signature(self):
        identity = package.release_identity("2.0.0", 100, "v2.0.0", "preview")
        signature = "Signer #1 certificate SHA-256 digest: " + "0" * 64
        badging = "package: name='com.coomidev.android' versionCode='100' versionName='2.0.0'\nnative-code: 'arm64-v8a'\n"
        with patch.object(package.subprocess, "check_output", side_effect=[signature, badging]):
            package.verify_identity(Path("preview.apk"), identity, Path("sdk"))

    def test_preview_rejects_official_package(self):
        identity = package.release_identity("2.0.0", 100, "v2.0.0", "preview")
        signature = "Signer #1 certificate SHA-256 digest: " + "0" * 64
        badging = "package: name='com.coomi.android' versionCode='100' versionName='2.0.0'\nnative-code: 'arm64-v8a'\n"
        with patch.object(package.subprocess, "check_output", side_effect=[signature, badging]):
            with self.assertRaisesRegex(ValueError, "package/version"):
                package.verify_identity(Path("preview.apk"), identity, Path("sdk"))

    def test_preview_requires_a_valid_signature(self):
        identity = package.release_identity("2.0.0", 100, "v2.0.0", "preview")
        with patch.object(package.subprocess, "check_output", return_value=""):
            with self.assertRaisesRegex(ValueError, "signing certificate"):
                package.verify_identity(Path("preview.apk"), identity, Path("sdk"))

    def test_rejects_mismatched_tag_and_invalid_code(self):
        for version, code, tag in [("2.0.0", 100, "v2.0.1"), ("2.0.0", 0, "v2.0.0"),
                                   ("2.0.0", 2100000001, "v2.0.0"), ("../bad", 1, "v../bad")]:
            with self.subTest(version=version, code=code), self.assertRaises(ValueError):
                package.release_identity(version, code, tag, "release")

    def test_stable_site_updates_download_and_folds_history(self):
        result = deploy.update_website(self.website, manifest())
        self.assertIn('id="versionValue" class="compatibility-value">1.4.9<', result)
        self.assertIn('Android 1.4.9</div>', result)
        self.assertIn('android/Coomi-Android-arm64-v1.4.9.apk', result)
        self.assertIn('修复 &lt;界面&gt; &amp; 流式输出', result)
        latest = result.index("v1.4.9 更新说明【稳定】")
        fold = result.index("<summary>展开全部更新记录</summary>", latest)
        previous = result.index("v1.4.8 更新说明【稳定】", latest)
        self.assertLess(latest, fold)
        self.assertLess(fold, previous)
        self.assertIn('android_test/Coomi-Android-arm64-v1.4.8-test.8.apk', result)

    def test_test_site_preserves_stable_panel(self):
        result = deploy.update_website(self.website, manifest("test"))
        stable = '<div data-channel-panel="stable">'
        test = '<div data-channel-panel="test"'
        self.assertEqual(self.website.split(stable)[1].split(test)[0], result.split(stable)[1].split(test)[0])
        self.assertIn('android_test/Coomi-Android-arm64-v1.4.9-test.1.apk', result)

    def test_unknown_site_markup_stops_deployment(self):
        with self.assertRaises(ValueError):
            deploy.update_website(self.website.replace('id="downloadButtonAndroid"', 'id="different"'), manifest())

    def test_version_must_exceed_both_channels(self):
        with self.assertRaises(ValueError):
            deploy.check_version(manifest(), {"versionCode": 75}, {"versionCode": 77})
        deploy.check_version(manifest(), {"versionCode": 75}, {"versionCode": 74})

    def test_official_certificate_is_required(self):
        with patch.object(package.subprocess, "check_output", return_value="Signer #1 certificate SHA-256 digest: " + "0" * 64):
            with self.assertRaisesRegex(ValueError, "certificate"):
                package.verify_identity(Path("app.apk"), manifest(), Path("sdk"))

    def test_apk_version_matches_release(self):
        signature = "Signer #1 certificate SHA-256 digest: " + package.SIGNER_SHA256
        badging = "package: name='com.coomi.android' versionCode='75' versionName='1.4.8'"
        with patch.object(package.subprocess, "check_output", side_effect=[signature, badging]):
            with self.assertRaisesRegex(ValueError, "package/version"):
                package.verify_identity(Path("app.apk"), manifest(), Path("sdk"))

    def deployment_fixture(self, directory):
        data = b"verified apk payload"
        release = {**manifest(), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
        (directory / release["file"]).write_bytes(data)
        (directory / "latest.json").write_bytes(deploy.encode_json(release))
        root = deploy.UPDATE_ROOT + "/android"
        files = {root + "/latest.json": b'{"versionCode": 75}',
                 root + "/versions.json": b'{"channel": "android", "versions": []}',
                 deploy.UPDATE_ROOT + "/android_test/latest.json": b'{"versionCode": 74}',
                 deploy.SITE_PATH: self.website.encode()}
        return release, root, files

    def test_publish_uses_verified_apk_and_preserves_other_channel(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            release, root, files = self.deployment_fixture(directory)
            client = Client(files)
            other_path = deploy.UPDATE_ROOT + "/android_test/latest.json"
            original_other = files[other_path]
            deploy.publish(client, directory)
            self.assertEqual(json.loads(files[root + "/latest.json"]), release)
            self.assertEqual(json.loads(files[root + "/versions.json"])["versions"][0]["file"], release["file"])
            self.assertEqual(files[root + "/" + release["file"]], (directory / release["file"]).read_bytes())
            self.assertEqual(files[other_path], original_other)
            self.assertIn("v1.4.9 更新说明【稳定】", files[deploy.SITE_PATH].decode())

    def test_failed_site_publish_restores_update_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            _, root, files = self.deployment_fixture(directory)
            originals = dict(files)
            client = Client(files)
            client.sftp.fail_site = True
            with self.assertRaises(OSError):
                deploy.publish(client, directory)
            for path in (root + "/latest.json", root + "/versions.json", deploy.SITE_PATH):
                self.assertEqual(files[path], originals[path])
            self.assertTrue(client.commands[-1].startswith("rmdir "))

    def test_corrupt_apk_is_rejected_before_connecting_to_server(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            release, _, files = self.deployment_fixture(directory)
            (directory / release["file"]).write_bytes(b"corrupt")
            client = Client(files)
            with self.assertRaises(ValueError):
                deploy.publish(client, directory)
            self.assertEqual(client.commands, [])

    def test_preview_cannot_be_deployed_to_official_update_channel(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            release, _, files = self.deployment_fixture(directory)
            release.update(package.release_identity("1.4.9", 76, "v1.4.9", "preview"))
            (directory / "latest.json").write_bytes(deploy.encode_json(release))
            client = Client(files)
            with self.assertRaisesRegex(ValueError, "Only official"):
                deploy.publish(client, directory)
            self.assertEqual(client.commands, [])


if __name__ == "__main__":
    unittest.main()
