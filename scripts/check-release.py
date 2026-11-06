#!/usr/bin/env python3
"""发布前一致性检查：版本号、CHANGELOG、vendor 资产。

跑法：python -B scripts/check-release.py
CI 在 push/PR 上跑这个脚本；本地打 tag 前也应该跑一遍。
任何一项不一致就用中文说清是哪一项、期望什么、实际什么，然后 exit 1。
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
problems: list[str] = []
notes: list[str] = []


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    notes.append(f"package.json version = {version}")

    # 1. README 里的下载链接必须指向当前版本
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    tags = set(re.findall(r"releases/download/v(\d+\.\d+\.\d+)", readme))
    zips = set(re.findall(r"ytdlp-vision-(\d+\.\d+\.\d+)\.zip", readme))
    for stale in sorted((tags | zips) - {version}):
        problems.append(f"README.md 引用了 {stale}，但 package.json 是 {version}：请同步下载链接")
    if not tags and not zips:
        notes.append("README.md 没有版本化的下载链接（跳过）")
    else:
        notes.append(f"README.md 下载链接版本 = {sorted(tags | zips)}")

    # 2. CHANGELOG 最新条目必须是当前版本
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    latest = re.search(r"^##\s+(\d+\.\d+\.\d+)", changelog, re.MULTILINE)
    if not latest:
        problems.append("CHANGELOG.md 里找不到任何 `## x.y.z` 条目")
    elif latest.group(1) != version:
        problems.append(f"CHANGELOG.md 最新条目是 {latest.group(1)}，但 package.json 是 {version}")
    else:
        notes.append(f"CHANGELOG.md 最新条目 = {version}")

    # 3. 打包清单必须包含运行期需要的文件
    files = manifest.get("files") or []
    required = ["index.js", "client.js", "vision.py", "sources.py", "cookies.py", "update.py",
                "cordis.patch.yml", "README.md", "LICENSE", "CHANGELOG.md",
                "vendor/yt-dlp-py.zip", "vendor/VERSION.json", "vendor/yt-dlp-public.key",
                "panel/store.js", "panel/routes.js", "web/index.html", "web/app.js"]
    for item in required:
        if not any(fnmatch.fnmatch(item, pattern) for pattern in files):
            problems.append(f"package.json 的 files 没有覆盖 {item}（npm 打包会漏掉它）")
    if not problems:
        notes.append(f"package.json 的 files 覆盖了 {len(required)} 个必需文件")

    # 4. vendor/VERSION.json 与 vendor 里的 zip 必须一致
    version_file = ROOT / "vendor" / "VERSION.json"
    if not version_file.exists():
        problems.append("缺少 vendor/VERSION.json")
    else:
        vendor = json.loads(version_file.read_text(encoding="utf-8"))
        asset = ROOT / "vendor" / vendor.get("file", "")
        if not asset.exists():
            problems.append(f"vendor/VERSION.json 指向的 {vendor.get('file')} 不存在")
        else:
            actual = sha256(asset)
            if actual != vendor.get("sha256"):
                problems.append(
                    f"vendor/{asset.name} 的 sha256 与 VERSION.json 不符："
                    f"文件 {actual[:16]}…，记录 {str(vendor.get('sha256'))[:16]}…")
            else:
                notes.append(f"vendor/{asset.name} sha256 校验通过（{asset.stat().st_size} 字节）")

    # 5. 验签公钥必须存在，且与 update.py 钉死的哈希一致
    key = ROOT / "vendor" / "yt-dlp-public.key"
    pinned = re.search(r'PUBKEY_SHA256\s*=\s*"([0-9a-f]{64})"',
                       (ROOT / "update.py").read_text(encoding="utf-8"))
    if not key.exists():
        problems.append("缺少 vendor/yt-dlp-public.key（自动更新的 GPG 验签要用）")
    elif not pinned:
        problems.append("update.py 里找不到 PUBKEY_SHA256 常量")
    elif sha256(key) != pinned.group(1):
        problems.append("vendor/yt-dlp-public.key 与 update.py 的 PUBKEY_SHA256 不一致："
                        "要么换错了公钥，要么没同步常量")
    else:
        notes.append("vendor/yt-dlp-public.key 与 PUBKEY_SHA256 一致")

    # 6. requirements.txt 里的每个包都要有上界，避免上游大版本破坏兼容
    reqs = (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
    for line in reqs:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "<" not in line:
            problems.append(f"requirements.txt 的 `{line}` 没有上界（建议加 `<N`）")

    for note in notes:
        print(f"  ok  {note}")
    if problems:
        print("\n发布检查未通过：")
        for item in problems:
            print(f"  !!  {item}")
        return 1
    print(f"\n发布检查通过（版本 {version}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
