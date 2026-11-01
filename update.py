#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 yt-dlp 更新到 GitHub 上的最新 release。

由插件在每次 DSH 启动时后台调用一次（见 index.js）。设计约束：
- 永不阻塞 DSH 启动，永不因为网络失败影响主流程；
- 只有 release tag 变化时才下载；
- 下载走断点续传 + SHA256 校验，写盘用原子替换；
- 代理读 YTDLP_VISION_PROXY，其次 HTTPS_PROXY / https_proxy。

用法:
    python update.py [--force] [--min-interval HOURS] [--quiet]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOME = Path(os.environ.get("YTDLP_VISION_HOME") or (Path.home() / ".dsh" / "ytdlp-vision"))
STATE = HOME / "state.json"
LOG = HOME / "update.log"
TARGET = HOME / "yt-dlp-py.zip"
API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
DL = "https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/yt-dlp"

MAX_LOG_LINES = 200


def log(msg: str, quiet: bool = False) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    if not quiet:
        print(line, file=sys.stderr, flush=True)
    try:
        HOME.mkdir(parents=True, exist_ok=True)
        lines = LOG.read_text(encoding="utf-8").splitlines() if LOG.exists() else []
        lines.append(line)
        LOG.write_text("\n".join(lines[-MAX_LOG_LINES:]) + "\n", encoding="utf-8")
    except Exception:  # noqa: BLE001 - 日志写失败无所谓
        pass


def read_state() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def write_state(state: dict) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, STATE)


def vendored_tag() -> str:
    try:
        return json.loads((ROOT / "vendor" / "VERSION.json").read_text(encoding="utf-8")).get("tag", "")
    except Exception:  # noqa: BLE001
        return ""


def proxies() -> dict | None:
    explicit = os.environ.get("YTDLP_VISION_PROXY", "").strip()
    if explicit:
        return {"http": explicit, "https": explicit}
    for key in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        value = os.environ.get(key, "").strip()
        if value:
            return {"http": value, "https": value}
    return None


def local_version() -> str:
    """当前生效的 yt-dlp 版本：运行时文件优先，其次插件自带。"""
    for path in (TARGET, ROOT / "vendor" / "yt-dlp-py.zip"):
        if path.is_file():
            return read_state().get("tag") if path == TARGET else vendored_tag()
    return ""


def download_with_resume(requests, url: str, dest: Path, px, retries: int = 5) -> str:
    part = dest.with_suffix(dest.suffix + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    attempt = 0
    while True:
        attempt += 1
        have = part.stat().st_size if part.exists() else 0
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            with requests.get(url, stream=True, timeout=(15, 60), proxies=px,
                              headers=headers) as resp:
                if have and resp.status_code == 416:
                    break
                resp.raise_for_status()
                total = have + int(resp.headers.get("content-length") or 0)
                mode = "ab" if have and resp.status_code == 206 else "wb"
                if mode == "wb":
                    have = 0
                with open(part, mode) as fh:
                    for chunk in resp.iter_content(1 << 16):
                        if chunk:
                            fh.write(chunk)
                            have += len(chunk)
            if total and have < total:
                raise OSError(f"{have}/{total} 不完整")
            break
        except Exception as exc:  # noqa: BLE001
            if attempt >= retries:
                part.unlink(missing_ok=True)
                raise
            time.sleep(min(2 ** attempt, 15))
    digest = hashlib.sha256()
    with open(part, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    os.replace(part, dest)
    return digest.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--min-interval", type=float, default=0.0,
                    help="距离上次检查不足这么多小时就跳过（默认 0 = 每次启动都查）")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    state = read_state()
    last = float(state.get("checked_at") or 0)
    if not args.force and args.min_interval > 0 and time.time() - last < args.min_interval * 3600:
        log(f"跳过：{args.min_interval}h 内已检查过", args.quiet)
        return 0

    try:
        import requests
    except ImportError:
        log("缺少 requests，跳过 yt-dlp 更新", args.quiet)
        return 0

    px = proxies()
    try:
        resp = requests.get(API, timeout=15, proxies=px,
                            headers={"Accept": "application/vnd.github+json",
                                     "User-Agent": "ytdlp-vision-updater"})
        resp.raise_for_status()
        release = resp.json()
        tag = str(release.get("tag_name") or "").strip()
    except Exception as exc:  # noqa: BLE001 - 网络问题不该报错退出
        log(f"查询 GitHub 失败（{exc.__class__.__name__}: {exc}）；沿用当前 yt-dlp", args.quiet)
        state["checked_at"] = time.time()
        state.setdefault("last_error", str(exc)[:300])
        write_state(state)
        return 0

    current = state.get("tag") if TARGET.exists() else vendored_tag()
    state["checked_at"] = time.time()
    state.pop("last_error", None)
    if tag and tag == current:
        log(f"yt-dlp 已是最新：{tag}", args.quiet)
        write_state(state)
        return 0

    log(f"发现新版本 {tag}（当前 {current or '无'}），开始下载", args.quiet)
    try:
        sha = download_with_resume(requests, DL.format(tag=tag), TARGET, px)
        # 校验和以 release 自带的 SHA2-256SUMS 为准；拿不到就只记录
        expected = ""
        try:
            sums = requests.get(
                f"https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/SHA2-256SUMS",
                timeout=20, proxies=px).text
            for line in sums.splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[1].lstrip("*") == "yt-dlp":
                    expected = parts[0]
        except Exception:  # noqa: BLE001
            pass
        if expected and expected != sha:
            TARGET.unlink(missing_ok=True)
            raise RuntimeError(f"SHA256 校验失败：期望 {expected}，实际 {sha}")
        state.update({"tag": tag, "sha256": sha, "file": TARGET.name,
                      "updated_at": time.time()})
        write_state(state)
        log(f"yt-dlp 更新完成：{tag}（{TARGET.stat().st_size / 1048576:.1f}MB）", args.quiet)
    except Exception as exc:  # noqa: BLE001
        log(f"更新失败，继续使用旧版：{exc.__class__.__name__}: {exc}", args.quiet)
        write_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
