"""cookies.py 的安全回归测试：头部注入、Netscape 行结构、浏览器名白名单、损坏恢复。"""

import json
import os
import shutil
import subprocess
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cookies  # noqa: E402


class CookieTests(unittest.TestCase):
    def setUp(self):
        base = Path(__file__).resolve().parent / ".tmp-cookies"
        base.mkdir(parents=True, exist_ok=True)
        self.home = base / f"case-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self.home.mkdir(parents=True, exist_ok=True)
        patcher = mock.patch.dict(os.environ, {"YTDLP_VISION_HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.home, True)

    def write_cfg(self, data):
        (self.home / "cookies.json").write_text(json.dumps(data), encoding="utf-8")

    def test_control_characters_are_stripped(self):
        self.write_cfg({"sites": {"bilibili": {"enabled": True, "cookies": [
            {"name": "SESSDATA", "value": "abc\r\nX-Evil: 1"},
            {"name": "buvid3", "value": "ok\tbad"},
        ]}}})
        header = cookies.bili_cookie()
        self.assertNotIn("\r", header)
        self.assertNotIn("\n", header)
        self.assertNotIn("\t", header)
        self.assertEqual(header, "SESSDATA=abcX-Evil: 1; buvid3=okbad")

    def test_netscape_rows_stay_seven_columns(self):
        self.write_cfg({"sites": {"bilibili": {"enabled": True, "cookies": [
            {"name": "SESSDATA", "value": "abc\r\ninjected\trow"},
        ]}}})
        rows = [line for line in cookies.export_netscape().splitlines()
                if line and not line.startswith("#")]
        self.assertEqual(len(rows), 1, "注入的换行不应产生额外行")
        self.assertEqual(len(rows[0].split("\t")), 7, "必须还是 7 列")

    def test_illegal_browser_name_falls_back(self):
        self.write_cfg({"browser": {"from": "browser", "name": "../../evil"}})
        args = cookies.ytdlp_auth_args()
        self.assertNotIn("--cookies-from-browser", args)

    def test_legal_browser_name_is_whitelisted(self):
        self.write_cfg({"browser": {"from": "browser", "name": "Edge"}})
        self.assertEqual(cookies.ytdlp_auth_args(), ["--cookies-from-browser", "edge"])

    def test_browser_profile_suffix_allowed(self):
        self.write_cfg({"browser": {"from": "browser", "name": "firefox:default-release"}})
        self.assertEqual(cookies.ytdlp_auth_args(),
                         ["--cookies-from-browser", "firefox:default-release"])

    def test_corrupt_config_is_backed_up(self):
        (self.home / "cookies.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(cookies.load()["sites"], {})
        backups = list(self.home.glob("cookies.corrupt-*.json"))
        self.assertEqual(len(backups), 1, "损坏的配置应被备份而不是直接丢弃")
        self.assertEqual(backups[0].read_text(encoding="utf-8"), "{not json")

    def test_no_config_means_no_credentials(self):
        self.assertEqual(cookies.bili_cookie(), "") if not os.environ.get("BILI_SESSDATA") else None
        self.assertIsNone(cookies.netscape_path())
        self.assertEqual(cookies.ytdlp_auth_args(), [])

    @unittest.skipUnless(os.name == "nt", "icacls 只在 Windows 上可用")
    def test_restrict_drops_inherited_aces(self):
        target = self.home / "cookies.txt"
        target.write_text("x", encoding="utf-8")
        cookies._restrict(target)
        out = subprocess.run(["icacls", str(target)], capture_output=True, text=True,
                             errors="replace")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertNotIn("Everyone", out.stdout)
        self.assertNotIn("BUILTIN\\Users", out.stdout)


if __name__ == "__main__":
    unittest.main()
