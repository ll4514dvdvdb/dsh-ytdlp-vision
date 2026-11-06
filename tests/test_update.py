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


if __name__ == "__main__":
    unittest.main()
