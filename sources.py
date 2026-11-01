#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""视频源适配层：B 站走官方 API，其余平台交给 yt-dlp。

对外只暴露 resolve() 和几个 fetch/download 函数，返回固定的 meta 结构，
让上层管线（抽帧、OCR、ASR、证据组装）不必关心视频来自哪个平台。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cookies as vcookies  # noqa: E402  （同目录：统一管视频站 cookie）

BILI_HOSTS = {"bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"}
BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")
URL_RE = re.compile(r"^https?://", re.I)

# 字幕语言偏好：中文优先，其次英文；人工字幕优先于自动字幕
LANG_PREF = ("zh-Hans", "zh-CN", "zh", "zh-Hant", "zh-TW", "zh-HK",
             "en", "en-US", "en-GB", "ja", "ko")
SUB_EXTS = ("json3", "srv3", "vtt", "srt", "ttml", "ass")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def run(cmd: list[str], timeout: int = 1800, env: dict | None = None) -> str:
    p = subprocess.run(
        cmd, capture_output=True, timeout=timeout,
        env={**os.environ, **(env or {})},
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if p.returncode != 0:
        tail = (p.stderr or b"")[-1200:].decode("utf-8", "replace")
        raise RuntimeError(f"命令失败({p.returncode}): {' '.join(cmd[:2])}…\n{tail}")
    return p.stdout.decode("utf-8", "replace") + p.stderr.decode("utf-8", "replace")


# ---------------------------------------------------------------- yt-dlp 定位

def runtime_home() -> Path:
    base = os.environ.get("YTDLP_VISION_HOME")
    return Path(base) if base else (Path.home() / ".dsh" / "ytdlp-vision")


def ytdlp_prefix(python: str | None = None) -> list[str]:
    """返回执行 yt-dlp 的命令前缀。

    顺序：运行时更新版（~/.dsh/ytdlp-vision）> 插件自带 vendor > PATH。
    zipapp 需要 Python；exe 在受限沙箱里解压会失败，所以排在最后。
    """
    py = python or sys.executable
    home = runtime_home()
    for path in (home / "yt-dlp-py.zip", ROOT / "vendor" / "yt-dlp-py.zip"):
        if path.is_file() and path.stat().st_size > 100_000:
            return [py, str(path)]
    for name in ("yt-dlp", "yt-dlp.exe"):
        found = shutil.which(name)
        if found:
            return [found]
    for path in (home / "yt-dlp.exe", ROOT / "vendor" / "yt-dlp.exe"):
        if path.is_file():
            return [str(path)]
    raise RuntimeError(
        "找不到 yt-dlp。插件自带的 vendor/yt-dlp-py.zip 应存在；"
        "或用脚本重新下载：python scripts/fetch-ytdlp.py"
    )


def ytdlp_version(python: str | None = None) -> str:
    try:
        return run([*ytdlp_prefix(python), "--version"], timeout=60).strip().splitlines()[-1]
    except Exception:  # noqa: BLE001 - 版本探测失败不该阻断主流程
        return "unknown"


# ---------------------------------------------------------------- 源判定

def is_bilibili(target: str) -> bool:
    t = target.strip()
    if BV_RE.fullmatch(t) or BV_RE.match(t):
        return True
    m = re.match(r"https?://([^/?#]+)", t, re.I)
    if not m:
        return False
    host = m.group(1).lower().split(":")[0]
    return host in BILI_HOSTS


def sanitize(text: str, limit: int = 80) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z._-]+", "_", text).strip("_.")
    return (cleaned or "video")[:limit]


@dataclass
class Source:
    """一个已解析的视频源。kind=bilibili 时 key 是 BV 号，否则是平台_id。"""
    kind: str
    key: str
    page: int
    url: str
    meta: dict = field(default_factory=dict)
    raw: dict = field(default_factory=dict, repr=False)  # yt-dlp 的原始 info，仅内存

    @property
    def duration(self) -> float:
        return float(self.meta.get("duration") or 0)


# ---------------------------------------------------------------- yt-dlp 元数据

def ytdlp_json(url: str, python: str | None = None, timeout: int = 180) -> dict:
    cmd = [*ytdlp_prefix(python), "-J", "--no-warnings", "--no-playlist",
           "--no-progress", *vcookies.ytdlp_auth_args(), url]
    with _tmp_stderr_wrap():
        raw = run(cmd, timeout=timeout)
    # -J 输出到 stdout，run() 把 stderr 拼在后面；从第一个 { 开始找平衡的 JSON
    start = raw.find("{")
    if start < 0:
        raise RuntimeError(f"yt-dlp 没有返回 JSON：{raw[-400:]}")
    info, _ = json.JSONDecoder().raw_decode(raw[start:])
    return _flatten_playlist(info, python, timeout)


class _tmp_stderr_wrap:
    """占位上下文：保留结构，方便以后加日志钩子。"""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _flatten_playlist(info: dict, python: str | None, timeout: int) -> dict:
    if info.get("_type") != "playlist":
        return info
    entries = info.get("entries") or []
    if not entries:
        raise RuntimeError("这个链接是播放列表，但没有可读取的条目")
    first = entries[0]
    if first.get("title") and first.get("duration"):
        return first
    url = first.get("webpage_url") or first.get("url")
    if not url:
        raise RuntimeError("播放列表条目缺少可解析的链接")
    return ytdlp_json(url, python, timeout)


def _platform(info: dict) -> str:
    return (info.get("extractor_key") or info.get("extractor") or "video").lower()


def normalize(info: dict) -> dict:
    """把 yt-dlp 的 info 转成管线内部的 meta 结构。"""
    platform = _platform(info)
    vid = info.get("id") or "unknown"
    key = sanitize(f"{platform}_{vid}", 90)
    duration = info.get("duration") or info.get("duration_string") or 0
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        duration = 0.0
    if not duration and info.get("is_live"):
        raise RuntimeError("这是直播，没有固定时长；等直播结束形成回放后再试")
    if not duration:
        raise RuntimeError("yt-dlp 没有拿到视频时长，无法做时间轴采样")
    uploader = (info.get("uploader") or info.get("channel")
                or info.get("uploader_id") or info.get("creator") or "")
    return {
        "bvid": key,          # 管线沿用的字段名，这里放平台唯一 key
        "aid": 0,
        "cid": 0,
        "page": 1,
        "platform": platform,
        "video_id": vid,
        "title": info.get("title") or "未命名视频",
        "desc": (info.get("description") or "")[:2000],
        "duration": duration,
        "owner": uploader,
        "tname": (info.get("categories") or [""])[0] if info.get("categories") else "",
        "webpage_url": info.get("webpage_url") or info.get("original_url") or "",
        "kind": "ytdlp",
    }


def fetch_meta_ytdlp(url: str, python: str | None = None) -> dict:
    return normalize(ytdlp_json(url, python))


# ---------------------------------------------------------------- 字幕

def _lang_rank(lang: str) -> int:
    lang = (lang or "").lower()
    for i, pref in enumerate(LANG_PREF):
        p = pref.lower()
        if lang == p or lang.startswith(p + "-") or lang.startswith(p + "_"):
            return i
    return len(LANG_PREF) + 10


def _pick_sub(info: dict) -> tuple[str, str, str] | None:
    """返回 (url, ext, lang)。人工字幕优先于自动字幕。"""
    for bucket in ("subtitles", "automatic_captions"):
        subs = info.get(bucket) or {}
        if not subs:
            continue
        for lang in sorted(subs, key=_lang_rank):
            formats = subs.get(lang) or []
            by_ext = {}
            for fmt in formats:
                ext = (fmt.get("ext") or "").lower()
                if ext in SUB_EXTS and fmt.get("url"):
                    by_ext.setdefault(ext, fmt["url"])
            for ext in SUB_EXTS:
                if ext in by_ext:
                    return by_ext[ext], ext, lang
    return None


def _parse_json3(data: dict) -> list[dict]:
    rows = []
    for ev in data.get("events") or []:
        segs = ev.get("segs") or []
        text = "".join(s.get("utf8") or "" for s in segs).strip()
        if not text:
            continue
        t0 = float(ev.get("tStartMs") or 0) / 1000.0
        t1 = t0 + float(ev.get("dDurationMs") or 0) / 1000.0
        rows.append({"start": round(t0, 2), "end": round(max(t1, t0 + 0.2), 2), "text": text})
    return _merge_rows(rows)


def _parse_vtt(text: str) -> list[dict]:
    rows = []
    stamp = re.compile(
        r"(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})")

    def secs(h, m, s, ms):
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000.0

    lines = text.replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines):
        m = stamp.search(lines[i])
        if not m:
            i += 1
            continue
        t0 = secs(*m.group(1, 2, 3, 4))
        t1 = secs(*m.group(5, 6, 7, 8))
        i += 1
        buf = []
        while i < len(lines) and lines[i].strip():
            line = re.sub(r"<[^>]+>", "", lines[i]).strip()
            if line:
                buf.append(line)
            i += 1
        if buf:
            rows.append({"start": round(t0, 2), "end": round(max(t1, t0 + 0.2), 2),
                         "text": " ".join(buf)})
    return _merge_rows(rows)


def _parse_srt(text: str) -> list[dict]:
    rows = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n")):
        m = re.search(r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*"
                      r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})", block)
        if not m:
            continue

        def secs(h, mi, s, ms):
            return int(h) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000.0

        body = block[m.end():]
        text_ = " ".join(l.strip() for l in body.strip().splitlines() if l.strip())
        if text_:
            rows.append({"start": round(secs(*m.group(1, 2, 3, 4)), 2),
                         "end": round(max(secs(*m.group(5, 6, 7, 8)),
                                          secs(*m.group(1, 2, 3, 4)) + 0.2), 2),
                         "text": text_})
    return _merge_rows(rows)


def _merge_rows(rows: list[dict], gap: float = 0.35, max_len: int = 120) -> list[dict]:
    """滚动字幕会被切成大量短片段，这里合并成可读的句子。"""
    out: list[dict] = []
    for row in rows:
        text = row["text"]
        if not text:
            continue
        if out:
            prev = out[-1]
            joinable = row["start"] - prev["end"] <= gap and len(prev["text"]) < max_len
            # 自动字幕常见「同一句话重复追加」，去重后能明显减少冗余
            if joinable and (text.startswith(prev["text"][-6:]) or prev["text"].endswith(text[:6])):
                prev["text"] = (prev["text"] + " " + text).strip()
                prev["end"] = row["end"]
                continue
            if joinable and not re.search(r"[。！？.!?]$", prev["text"]):
                prev["text"] = prev["text"] + " " + text
                prev["end"] = row["end"]
                continue
        out.append(dict(row))
    return [r for r in out if r["text"]]


def fetch_subtitle_ytdlp(info: dict, timeout: int = 90) -> list[dict] | None:
    picked = _pick_sub(info)
    if not picked:
        return None
    url, ext, lang = picked
    import requests
    try:
        resp = requests.get(url, timeout=timeout, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        body = resp.text
        if ext in ("json3", "srv3"):
            rows = _parse_json3(json.loads(body))
        elif ext in ("vtt",):
            rows = _parse_vtt(body)
        elif ext in ("srt",):
            rows = _parse_srt(body)
        else:
            rows = _parse_vtt(body) or _parse_srt(body)
    except Exception as exc:  # noqa: BLE001 - 字幕失败降级到 ASR
        log(f"字幕拉取失败（{lang}/{ext}）：{exc}；改用本地转写")
        return None
    log(f"字幕：{lang}（{ext}），共 {len(rows)} 段")
    return rows or None


# ---------------------------------------------------------------- 下载

def _download_glob(work: Path, stem: str) -> Path | None:
    for path in sorted(work.glob(stem + ".*"), key=lambda p: p.stat().st_size, reverse=True):
        if path.suffix.lower() in (".part", ".ytdl", ".json", ".tmp"):
            continue
        if path.is_file() and path.stat().st_size > 1024:
            return path
    return None


def download_audio_ytdlp(src: Source, work: Path, python: str | None = None,
                         timeout: int = 3600) -> Path | None:
    work = Path(work)
    dl = work / "dl"
    dl.mkdir(parents=True, exist_ok=True)
    url = src.meta.get("webpage_url") or src.url
    log(f"yt-dlp 下载音频：{url}")
    try:
        run([*ytdlp_prefix(python), "-f", "bestaudio/best", "--no-warnings",
             "--no-playlist", "--no-progress", "--no-part",
             *vcookies.ytdlp_auth_args(),
             "-o", str(dl / "audio.%(ext)s"), url], timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        log(f"音频下载失败：{exc}")
        return None
    return _download_glob(dl, "audio")


def download_video_ytdlp(src: Source, work: Path, height: int = 720,
                         python: str | None = None, timeout: int = 3600) -> Path | None:
    work = Path(work)
    dl = work / "dl"
    dl.mkdir(parents=True, exist_ok=True)
    url = src.meta.get("webpage_url") or src.url
    fmt = (f"bestvideo[height<={height}][vcodec^=avc1]/"
           f"bestvideo[height<={height}]/"
           f"best[height<={height}]/best")
    log(f"yt-dlp 下载视频（≤{height}p）：{url}")
    try:
        run([*ytdlp_prefix(python), "-f", fmt, "--no-warnings", "--no-playlist",
             "--no-progress", "--no-part", *vcookies.ytdlp_auth_args(),
             "-o", str(dl / "video.%(ext)s"), url],
            timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        log(f"视频下载失败：{exc}")
        return None
    return _download_glob(dl, "video")
