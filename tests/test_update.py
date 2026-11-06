"""update.py 的离线单元测试：不联网、不依赖真实 Cookie、不动真实 HOME。

重点验证任务书里的几条硬要求：
- 取不到校验信息时必须终止，旧版本保留；
- 校验失败时必须保留旧版本，不留 staged/.part 垃圾；
- 只接受 https + 可信主机，重定向逐跳校验；
- 下载不完整不得覆盖旧文件；
- 成功路径才原子替换。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import update  # noqa: E402

OLD = b"OLD-YTDLP-BINARY" * 100
NEW = b"NEW-YTDLP-BINARY" * 200


class FakeResp:
    def __init__(self, status=200, body=b"", headers=None):
        self.status_code = status
        self.body = body
        self.headers = {str(k).lower(): str(v) for k, v in (headers or {}).items()}

    def iter_content(self, size=65536):
        for start in range(0, len(self.body), size):
            yield self.body[start:start + size]

    def close(self):
        pass

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeRequests:
    """最小 requests 替身：按 URL 前缀路由，记录每个请求的 URL 与参数。"""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []
        fake = self

        class Session:
            def get(self, url, **kwargs):
                fake.calls.append((url, kwargs))
                for prefix, handler in fake.routes.items():
                    if url.startswith(prefix):
                        return handler(url, kwargs) if callable(handler) else handler
                raise AssertionError(f"测试里出现了未登记的 URL：{url}")

        # 类体里不能同名引用自己，直接构造命名空间对象
        self.module = type("FakeRequestsModule", (), {"Session": Session})()


class UpdateTestBase(unittest.TestCase):
    def setUp(self):
        # 不用 TemporaryDirectory：它在收尾时会 chmod 已有目录，在受限沙箱里会被拒绝。
        base = Path(__file__).resolve().parent / ".tmp-update"
        base.mkdir(parents=True, exist_ok=True)
        self._tmp = base / f"case-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self._tmp.mkdir(parents=True, exist_ok=True)
        self.home = self._tmp / "home"
        self.home.mkdir(parents=True, exist_ok=True)
        self.target = self.home / "yt-dlp-py.zip"
        self.target.write_bytes(OLD)
        patches = {
            "HOME": self.home,
            "STATE": self.home / "state.json",
            "LOG": self.home / "update.log",
            "TARGET": self.target,
            "STAGED": self.home / "yt-dlp-py.zip.new",
        }
        self._patchers = [mock.patch.object(update, k, v) for k, v in patches.items()]
        for patcher in self._patchers:
            patcher.start()
        # 固定“没有 gpg”，让签名分支不依环境变化
        self._which = mock.patch.object(update.shutil, "which", lambda name: None)
        self._which.start()
        # 重试等待改成 0，测试不真睡
        self._sleep = mock.patch.object(update.time, "sleep", lambda seconds: None)
        self._sleep.start()

    def tearDown(self):
        for patcher in (self._sleep, self._which, *self._patchers):
            patcher.stop()
        shutil.rmtree(self._tmp, ignore_errors=True)

    def sums_url(self, tag="2026.10.26"):
        return update.RELEASE_BASE.format(tag=tag, name="SHA2-256SUMS")

    def asset_url(self, tag="2026.10.26"):
        return update.RELEASE_BASE.format(tag=tag, name="yt-dlp")

    def api_release(self, tag="2026.10.26"):
        body = json.dumps({"tag_name": tag}).encode()
        return FakeResp(200, body)

    def sums_for(self, payload: bytes, tag="2026.10.26"):
        digest = hashlib.sha256(payload).hexdigest()
        body = f"{digest}  yt-dlp\n{'0' * 64}  yt-dlp.exe\n".encode()
        return FakeResp(200, body)


class UpdateSafetyTests(UpdateTestBase):
    def test_missing_sums_aborts_and_keeps_old_binary(self):
        fake = FakeRequests({
            update.API: lambda url, kw: self.api_release(),
            self.sums_url(): FakeResp(404),
        })
        code = update.run_update(fake.module, force=True, quiet=True)
        self.assertEqual(code, 0)
        self.assertEqual(self.target.read_bytes(), OLD, "校验信息缺失时绝不能覆盖旧版本")
        state = json.loads(update.STATE.read_text(encoding="utf-8"))
        self.assertIn("sums-failed", state.get("last_error", ""))
        self.assertEqual(list(self.home.glob("yt-dlp-py.zip.new*")), [])

    def test_sums_without_asset_entry_aborts(self):
        fake = FakeRequests({
            update.API: lambda url, kw: self.api_release(),
            self.sums_url(): FakeResp(200, b"deadbeef  other-file\n"),
        })
        update.run_update(fake.module, force=True, quiet=True)
        self.assertEqual(self.target.read_bytes(), OLD)

    def test_hash_mismatch_keeps_old_binary_and_cleans_staging(self):
        fake = FakeRequests({
            update.API: lambda url, kw: self.api_release(),
            self.sums_url(): self.sums_for(NEW),
            self.asset_url(): FakeResp(200, b"TAMPERED" * 300, {"content-length": str(len(b"TAMPERED" * 300))}),
        })
        update.run_update(fake.module, force=True, quiet=True)
        self.assertEqual(self.target.read_bytes(), OLD, "校验失败必须保留旧版本")
        self.assertEqual(list(self.home.glob("yt-dlp-py.zip.new*")), [], "不能留下 staged/.part")

    def test_truncated_download_never_replaces_target(self):
        # content-length 声称 1000 字节，实际只给 10 字节 → 重试耗尽后必须失败
        truncated = FakeResp(200, b"x" * 10, {"content-length": "1000"})
        fake = FakeRequests({
            update.API: lambda url, kw: self.api_release(),
            self.sums_url(): self.sums_for(NEW),
            self.asset_url(): truncated,
        })
        update.run_update(fake.module, force=True, quiet=True)
        self.assertEqual(self.target.read_bytes(), OLD)
        self.assertEqual(list(self.home.glob("yt-dlp-py.zip.new*")), [])

    def test_non_https_url_rejected(self):
        with self.assertRaises(ValueError):
            update.check_url("http://github.com/yt-dlp/yt-dlp/releases/download/x/yt-dlp", update.RELEASE_HOSTS)

    def test_foreign_host_rejected(self):
        with self.assertRaises(ValueError):
            update.check_url("https://evil.example/yt-dlp", update.RELEASE_HOSTS)
        with self.assertRaises(ValueError):
            update.check_url("https://github.com.evil.example/x", update.RELEASE_HOSTS)

    def test_redirect_to_untrusted_host_rejected(self):
        fake = FakeRequests({
            self.sums_url(): FakeResp(302, b"", {"location": "https://evil.example/sums"}),
        })
        with self.assertRaises(ValueError):
            update.open_url(fake.module, self.sums_url(), update.RELEASE_HOSTS, px=None, timeout=10)

    def test_bad_tag_rejected_before_download(self):
        fake = FakeRequests({
            update.API: lambda url, kw: self.api_release("../../etc/passwd"),
        })
        update.run_update(fake.module, force=True, quiet=True)
        self.assertEqual(self.target.read_bytes(), OLD)
        self.assertFalse(any("evil" in url for url, _ in fake.calls))

    def test_redirect_chain_inside_allowlist_is_followed(self):
        payload = NEW
        fake = FakeRequests({
            update.API: lambda url, kw: self.api_release(),
            self.sums_url(): FakeResp(302, b"", {"location": "https://objects.githubusercontent.com/sums"}),
            "https://objects.githubusercontent.com/sums": self.sums_for(payload),
            self.asset_url(): FakeResp(200, payload, {"content-length": str(len(payload))}),
        })
        update.run_update(fake.module, force=True, quiet=True)
        self.assertEqual(self.target.read_bytes(), payload)
        state = json.loads(update.STATE.read_text(encoding="utf-8"))
        self.assertEqual(state["tag"], "2026.10.26")
        self.assertEqual(state["sha256"], hashlib.sha256(payload).hexdigest())

    def test_redirect_to_release_assets_host_is_followed(self):
        # 2026-11 实测：GitHub release 资产的 302 目标是 release-assets.githubusercontent.com。
        # 这个域名必须留在白名单里，否则真实自动更新会报「拒绝非可信主机」。
        payload = NEW
        fake = FakeRequests({
            update.API: lambda url, kw: self.api_release(),
            self.sums_url(): FakeResp(302, b"", {"location": "https://release-assets.githubusercontent.com/sums"}),
            "https://release-assets.githubusercontent.com/sums": self.sums_for(payload),
            self.asset_url(): FakeResp(200, payload, {"content-length": str(len(payload))}),
        })
        update.run_update(fake.module, force=True, quiet=True)
        self.assertEqual(self.target.read_bytes(), payload)

    def test_no_update_needed_does_not_touch_binary(self):
        update.write_state({"tag": "2026.10.26", "sha256": hashlib.sha256(OLD).hexdigest()})
        fake = FakeRequests({update.API: lambda url, kw: self.api_release()})
        update.run_update(fake.module, force=True, quiet=True)
        self.assertEqual(self.target.read_bytes(), OLD)
        self.assertEqual([url for url, _ in fake.calls], [update.API])

    def test_tampered_local_binary_is_replaced(self):
        update.write_state({"tag": "2026.10.26", "sha256": hashlib.sha256(b"something-else").hexdigest()})
        payload = NEW
        fake = FakeRequests({
            update.API: lambda url, kw: self.api_release("2026.10.27"),
            update.RELEASE_BASE.format(tag="2026.10.27", name="SHA2-256SUMS"): self.sums_for(payload, "2026.10.27"),
            update.RELEASE_BASE.format(tag="2026.10.27", name="yt-dlp"): FakeResp(200, payload, {"content-length": str(len(payload))}),
        })
        update.run_update(fake.module, force=True, quiet=True)
        self.assertEqual(self.target.read_bytes(), payload)


class SignatureTests(UpdateTestBase):
    """GPG 验签分支：用假的 subprocess.run，不依赖本机是否装了 gpg。

    这里的断言来自一次真实的失败：Git for Windows 自带 MSYS 版 gpg，
    传 `--keyring C:\\...` 会被当成资源 URL 解析（invalid key resource URL）。
    所以固定要求：不出现 --keyring，且把 cwd 设为临时目录、全程用相对文件名。
    """

    def setUp(self):
        super().setUp()
        self._which.stop()
        self._which = mock.patch.object(
            update.shutil, "which",
            lambda name: r"C:\fake\gpg.exe" if name == "gpg" else None)
        self._which.start()
        self.calls = []
        self.verify_rc = 0
        self.verify_err = b""
        self._run = mock.patch.object(update.subprocess, "run", self._fake_run)
        self._run.start()

    def tearDown(self):
        self._run.stop()
        super().tearDown()

    def _fake_run(self, cmd, **kwargs):
        self.calls.append((list(cmd), dict(kwargs)))

        class Result:
            def __init__(self, returncode, stderr):
                self.returncode = returncode
                self.stdout = b""
                self.stderr = stderr

        if "--import" in cmd:
            return Result(0, b"")
        return Result(self.verify_rc, self.verify_err)

    def _sig_url(self, tag="2026.10.26"):
        return update.RELEASE_BASE.format(tag=tag, name="SHA2-256SUMS.sig")

    def test_signature_ok_when_gpg_accepts(self):
        fake = FakeRequests({self._sig_url(): FakeResp(200, b"FAKE-SIG")})
        status = update.verify_signature(fake.module, "2026.10.26", b"sums-bytes", px=None)
        self.assertEqual(status, "ok")
        self.assertEqual(len(self.calls), 2, "应当是先 import 再 verify")
        import_cmd = self.calls[0][0]
        verify_cmd = self.calls[1][0]
        self.assertIn("--import", import_cmd)
        self.assertIn("pub.key", import_cmd)
        self.assertIn("--verify", verify_cmd)
        self.assertIn("sums.sig", verify_cmd)
        self.assertIn("sums", verify_cmd)
        for cmd, _ in self.calls:
            self.assertNotIn("--keyring", cmd, "MSYS 版 gpg 不接受 Windows 绝对路径的 --keyring")
            self.assertNotIn("--no-default-keyring", cmd)
        for _, kwargs in self.calls:
            self.assertTrue(Path(kwargs["cwd"]).name.startswith("gpg-"), "临时目录要在 HOME 下，不依赖 %TEMP%")
            self.assertEqual(kwargs["env"]["GNUPGHOME"], "gnupg", "隔离靠独立 GNUPGHOME，且必须是相对名")

    def test_signature_failure_reports_gpg_detail(self):
        self.verify_rc = 1
        self.verify_err = (
            b"gpg: Signature made Tue Oct 27 06:24:41 2026\r\n"
            b'gpg: BAD signature from "Simon Sawicki (yt-dlp signing key)"\r\n'
        )
        fake = FakeRequests({self._sig_url(): FakeResp(200, b"BAD-SIG")})
        status = update.verify_signature(fake.module, "2026.10.26", b"sums-bytes", px=None)
        self.assertTrue(status.startswith("failed:"), status)
        self.assertIn("BAD signature", status, "失败原因要带出来，否则用户无法定位")
        self.assertNotIn("\n", status, "返回值必须是单行")

    def test_import_failure_is_reported_as_skipped(self):
        def boom(cmd, **kwargs):
            raise update.subprocess.CalledProcessError(2, cmd, stderr=b"gpg: no writable keyring found")

        with mock.patch.object(update.subprocess, "run", boom):
            fake = FakeRequests({self._sig_url(): FakeResp(200, b"SIG")})
            status = update.verify_signature(fake.module, "2026.10.26", b"sums-bytes", px=None)
        self.assertTrue(status.startswith("skipped:"), status)
        self.assertIn("no writable keyring", status)

    def test_missing_gpg_is_skipped(self):
        with mock.patch.object(update.shutil, "which", lambda name: None):
            fake = FakeRequests({})
            self.assertEqual(
                update.verify_signature(fake.module, "2026.10.26", b"sums", px=None),
                "skipped: gpg 不在 PATH")

    def test_tampered_pubkey_is_rejected_before_gpg_runs(self):
        bogus = pubkey = update.PUBKEY.read_bytes() + b"tampered"
        with mock.patch.object(update, "PUBKEY", self._tmp / "vendor.key"):
            (self._tmp / "vendor.key").write_bytes(bogus)
            fake = FakeRequests({})
            status = update.verify_signature(fake.module, "2026.10.26", b"sums", px=None)
        self.assertEqual(status, "skipped: 包内公钥与钉死的哈希不一致")
        self.assertEqual(self.calls, [], "公钥不可信时不应调用 gpg")
        self.assertTrue(pubkey)


if __name__ == "__main__":
    unittest.main()
