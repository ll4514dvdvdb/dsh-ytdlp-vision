#!/usr/bin/env python3
"""下载 yt-dlp 平台二进制到 vendor/，支持断点续传与多次重试。

用法:
    python scripts/fetch-ytdlp.py [--tag TAG] [--proxy URL] [--out DIR]

默认取 GitHub 最新 release，写到仓库的 vendor/ 目录。
这个脚本只在维护插件包时用；运行时更新由插件自己完成（index.js 里的 updater）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import requests

API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
DL = "https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/{name}"

# 每个平台取哪个资产、最终落地文件名。
# 默认用 zipapp（需要 Python，体积 3MB，兼容沙箱）；--kind exe 走 PyInstaller 单文件
# （免 Python，但启动时要往 temp 解压，受限环境下会失败）。
ASSETS = {
    "zipapp": {
        ("win32", "x64"): ("yt-dlp", "yt-dlp-py.zip"),
        ("win32", "arm64"): ("yt-dlp", "yt-dlp-py.zip"),
        ("darwin", "x64"): ("yt-dlp", "yt-dlp-py.zip"),
        ("darwin", "arm64"): ("yt-dlp", "yt-dlp-py.zip"),
        ("linux", "x64"): ("yt-dlp", "yt-dlp-py.zip"),
        ("linux", "arm64"): ("yt-dlp", "yt-dlp-py.zip"),
    },
    "exe": {
        ("win32", "x64"): ("yt-dlp.exe", "yt-dlp.exe"),
        ("win32", "arm64"): ("yt-dlp.exe", "yt-dlp.exe"),
        ("darwin", "x64"): ("yt-dlp_macos", "yt-dlp"),
        ("darwin", "arm64"): ("yt-dlp_macos", "yt-dlp"),
        ("linux", "x64"): ("yt-dlp", "yt-dlp-py.zip"),
        ("linux", "arm64"): ("yt-dlp", "yt-dlp-py.zip"),
    },
}


def asset_for_current_platform(kind: str = "zipapp") -> tuple[str, str]:
    key = ("win32" if os.name == "nt" else sys.platform, player_arch())
    table = ASSETS[kind]
    if key not in table:
        raise SystemExit(f"不支持的平台 {key}，请手动把 yt-dlp 放进 vendor/")
    return table[key]


def player_arch() -> str:
    import platform

    m = platform.machine().lower()
    return "arm64" if m in ("arm64", "aarch64") else "x64"


def get_json(url: str, proxies, timeout=30) -> dict:
    r = requests.get(url, timeout=timeout, proxies=proxies)
    r.raise_for_status()
    return r.json()


def download_to_part(url: str, part: Path, proxies, retries=8) -> str:
    """分块续传下载到 part（不落地到最终文件），返回 sha256。已有 .part 时从断点继续。"""
    part.parent.mkdir(parents=True, exist_ok=True)
    attempt = 0
    while True:
        attempt += 1
        have = part.stat().st_size if part.exists() else 0
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            with requests.get(url, stream=True, timeout=(20, 90), proxies=proxies,
                              headers=headers) as r:
                if have and r.status_code == 416:  # 已经下全了
                    break
                r.raise_for_status()
                total = have + int(r.headers.get("content-length") or 0)
                mode = "ab" if have and r.status_code == 206 else "wb"
                if mode == "wb":
                    have = 0
                with open(part, mode) as f:
                    for chunk in r.iter_content(1 << 16):
                        if chunk:
                            f.write(chunk)
                            have += len(chunk)
            if total and have < total:
                raise requests.exceptions.ChunkedEncodingError(f"{have}/{total} 不完整")
            break
        except Exception as e:  # noqa: BLE001 - 续传要吃掉所有网络异常
            if attempt >= retries:
                part.unlink(missing_ok=True)
                raise SystemExit(f"下载失败（试了 {attempt} 次）: {e}") from e
            wait = min(2 ** attempt, 20)
            print(f"  第 {attempt} 次中断（{e.__class__.__name__}），"
                  f"已下 {have/1048576:.1f}MB，{wait}s 后续传…", file=sys.stderr)
            time.sleep(wait)
    h = hashlib.sha256()
    with open(part, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_sums(tag: str, proxies) -> str:
    """取该 tag 的 SHA2-256SUMS 正文；拿不到就终止（不允许无校验下载）。"""
    sums_url = f"https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/SHA2-256SUMS"
    try:
        r = requests.get(sums_url, timeout=30, proxies=proxies)
        r.raise_for_status()
        return r.text
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"取不到 {tag} 的 SHA2-256SUMS（{e.__class__.__name__}: {e}），"
                         f"没有校验信息就不下载") from e


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="")
    ap.add_argument("--kind", default="zipapp", choices=("zipapp", "exe"))
    ap.add_argument("--proxy", default=os.environ.get("YTDLP_VISION_PROXY", ""))
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "vendor"))
    args = ap.parse_args()

    proxies = {"http": args.proxy, "https": args.proxy} if args.proxy else None
    out = Path(args.out)

    if args.tag:
        tag = args.tag
        print(f"使用指定 tag {tag}", file=sys.stderr)
    else:
        print("查询 GitHub 最新 release…", file=sys.stderr)
        rel = get_json(API, proxies)
        tag = rel["tag_name"]

    sums = fetch_sums(tag, proxies)

    name, local = asset_for_current_platform(args.kind)
    dest = out / local
    part = out / (local + ".part")
    print(f"yt-dlp {tag} -> vendor/{local}", file=sys.stderr)
    sha = download_to_part(DL.format(tag=tag, name=name), part, proxies)
    print(f"sha256 {sha}", file=sys.stderr)

    expected = None
    for line in sums.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == name:
            expected = parts[0].strip().lower()
    if not expected:
        part.unlink(missing_ok=True)
        raise SystemExit(f"SHA2-256SUMS 里没有 {name} 条目，放弃写入 vendor/")
    if expected != sha:
        part.unlink(missing_ok=True)
        raise SystemExit(f"校验失败，期望 {expected} 实际 {sha}（vendor/ 未被改动）")

    os.replace(part, dest)

    (out / "VERSION.json").write_text(
        json.dumps({"tag": tag, "asset": name, "file": local, "sha256": sha,
                    "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")},
                   ensure_ascii=False, indent=1),
        encoding="utf-8")
    print(f"OK -> {out / local} ({os.path.getsize(out / local) / 1048576:.1f}MB)",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
