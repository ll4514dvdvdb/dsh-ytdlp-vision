#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 yt-dlp 更新到 GitHub 上的最新 release。

由插件在每次 DSH 启动时后台调用一次（见 index.js）。设计约束：
- 永不阻塞 DSH 启动，永不因为网络失败影响主流程；
- 只有 release tag 变化时才下载；
- 下载走断点续传 + **强制** SHA256 校验，写盘先落到 staged 文件，校验通过才原子替换；
- 校验信息拿不到、校验失败、下载不完整时一律保留旧版本；
- 只接受 https + 可信主机（含重定向逐跳校验）；
- 可选 GPG 验签（系统有 gpg 且包内公钥未被改动时）；
- 代理读 YTDLP_VISION_PROXY，其次 HTTPS_PROXY / https_proxy。

用法:
    python update.py [--force] [--min-interval HOURS] [--quiet]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit

ROOT = Path(__file__).resolve().parent
HOME = Path(os.environ.get("YTDLP_VISION_HOME") or (Path.home() / ".dsh" / "ytdlp-vision"))
STATE = HOME / "state.json"
LOG = HOME / "update.log"
TARGET = HOME / "yt-dlp-py.zip"
STAGED = HOME / "yt-dlp-py.zip.new"
PUBKEY = ROOT / "vendor" / "yt-dlp-public.key"

API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
ASSET = "yt-dlp"
RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/{name}"

# 钉死包内 yt-dlp 公钥的内容哈希：公钥被换掉就不再信任它做验签。
PUBKEY_SHA256 = "45d6b415928b5f3e228b461fa9e6d7eb56a824931c785ece00279a06c7a6d6e5"

API_HOSTS = ("api.github.com",)
# GitHub 自 2025 年起把 release 资产的 302 目标改成 release-assets.githubusercontent.com；
# objects.githubusercontent.com 是旧域名，仍保留以兼容未切换的账号/镜像。
RELEASE_HOSTS = ("github.com", "release-assets.githubusercontent.com",
                 "objects.githubusercontent.com")
WEB_HOSTS = ("github.com",)

TAG_RE = re.compile(r"^\d{4}\.\d{2}\.\d{2}(?:\.\d{1,6})?$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_REDIRECTS = 8
MAX_JSON_BYTES = 1 << 20
MAX_SUMS_BYTES = 1 << 20
MAX_ASSET_BYTES = 512 << 20
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
        data = json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    return data if isinstance(data, dict) else {}


def write_state(state: dict) -> None:
    """原子写 state.json（临时文件用 mkstemp，避免多实例互相覆盖同一个 .tmp）。"""
    HOME.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="state.", suffix=".tmp", dir=str(HOME))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(state, ensure_ascii=False, indent=1))
        os.replace(tmp, STATE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def host_allowed(host: str | None, allowed: tuple[str, ...]) -> bool:
    name = (host or "").strip().lower().rstrip(".")
    if not name:
        return False
    return any(name == item or name.endswith("." + item) for item in allowed)


def check_url(url: str, allowed: tuple[str, ...]) -> str:
    """只放行 https + 白名单主机；返回原 url 便于链式调用。"""
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise ValueError(f"拒绝非 HTTPS 地址（{parts.scheme or '无协议'}）：{url[:120]}")
    if parts.username or parts.password:
        raise ValueError("拒绝带凭据的 URL")
    if parts.port not in (None, 443):
        raise ValueError(f"拒绝非 443 端口：{parts.port}")
    if not host_allowed(parts.hostname, allowed):
        raise ValueError(f"拒绝非可信主机：{parts.hostname}")
    return url


def open_url(requests, url: str, allowed: tuple[str, ...], *, px, timeout, headers=None, stream=True):
    """手动逐跳跟随重定向，每一跳都校验协议与主机。调用方负责 close。"""
    session = requests.Session()
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        check_url(current, allowed)
        resp = session.get(current, timeout=timeout, proxies=px, allow_redirects=False,
                           stream=stream, headers=headers or {})
        if resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("location") or ""
            resp.close()
            if not location:
                raise RuntimeError(f"重定向缺少 Location（HTTP {resp.status_code}）")
            current = urljoin(current, location)
            continue
        resp.raise_for_status()
        return resp
    raise RuntimeError("重定向次数过多，已放弃")


def read_limited(resp, limit: int) -> bytes:
    """读响应体，超过 limit 立即报错，避免把大文件读进内存。"""
    buf = bytearray()
    try:
        for chunk in resp.iter_content(1 << 16):
            if not chunk:
                continue
            buf += chunk
            if len(buf) > limit:
                raise ValueError(f"响应体超过 {limit} 字节上限，已中止")
    finally:
        resp.close()
    return bytes(buf)


def fetch_expected(requests, tag: str, px) -> tuple[str, bytes]:
    """取 release 自带的 SHA2-256SUMS 里 yt-dlp 的摘要。取不到就抛错（不允许无校验更新）。"""
    url = RELEASE_BASE.format(tag=tag, name="SHA2-256SUMS")
    resp = open_url(requests, url, RELEASE_HOSTS, px=px, timeout=(15, 40))
    body = read_limited(resp, MAX_SUMS_BYTES)
    text = body.decode("utf-8", "replace")
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == ASSET:
            digest = parts[0].strip().lower()
            if not SHA_RE.match(digest):
                raise RuntimeError(f"SHA2-256SUMS 里的摘要格式不合法：{digest[:80]}")
            return digest, body
    raise RuntimeError(f"SHA2-256SUMS 中找不到 {ASSET} 条目")


def verify_signature(requests, tag: str, sums_bytes: bytes, px) -> str:
    """用 yt-dlp 官方公钥验证 SHA2-256SUMS.sig。返回状态字符串，绝不抛错。

    只有三种情况会跳过（记录原因）：没有 gpg、公钥缺失或被改、下载签名失败。
    """
    gpg = shutil.which("gpg")
    if not gpg:
        return "skipped: gpg 不在 PATH"
    try:
        key_bytes = PUBKEY.read_bytes()
    except OSError as exc:
        return f"skipped: 读不到公钥（{exc.__class__.__name__}）"
    if hashlib.sha256(key_bytes).hexdigest() != PUBKEY_SHA256:
        return "skipped: 包内公钥与钉死的哈希不一致"
    try:
        url = RELEASE_BASE.format(tag=tag, name="SHA2-256SUMS.sig")
        resp = open_url(requests, url, RELEASE_HOSTS, px=px, timeout=(15, 40))
        sig = read_limited(resp, MAX_SUMS_BYTES)
    except Exception as exc:  # noqa: BLE001 - 验签是加分项，不阻塞更新
        return f"skipped: 下载签名失败（{exc.__class__.__name__}）"
    try:
        # 临时目录放在 HOME 下而不是 %TEMP%：受限环境（服务账号、精简系统、组策略）
        # 下 %TEMP% 可能不可写，那会让验签永远 skipped。
        # 也不用 tempfile.mkdtemp：它按 0o700 建目录，在带沙箱/过滤驱动的环境里
        # 建出来就是不可写目录（实测 PermissionError），普通 mkdir 反而正常。
        HOME.mkdir(parents=True, exist_ok=True)
        tmp = HOME / f"gpg-{os.getpid()}-{time.time_ns()}"
        tmp.mkdir()
    except OSError as exc:
        return f"skipped: 建不了临时目录（{exc.__class__.__name__}）"
    try:
        home = tmp
        (home / "pub.key").write_bytes(key_bytes)
        (home / "sums").write_bytes(sums_bytes)
        (home / "sums.sig").write_bytes(sig)
        (home / "gnupg").mkdir()
        if os.name != "nt":
            # Windows 上 mkdir(mode=0o700) 会触发 chmod，受限环境里直接被拒绝（WinError 5）；
            # NTFS 权限由用户目录继承保证，这里只在 POSIX 上收紧。
            os.chmod(home / "gnupg", 0o700)
        # 全部用相对名 + cwd=home：Git for Windows 自带的是 MSYS 版 gpg，
        # 它把 "C:\..." 当成相对 POSIX 路径甚至资源 URL 解析，绝对路径会直接失效
        # （实测：gpg: invalid key resource URL / no writable keyring found）。
        # 在临时目录内用相对路径就绕开了盘符问题，隔离仍由独立 GNUPGHOME 保证。
        env = {**os.environ, "GNUPGHOME": "gnupg"}
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.run([gpg, "--batch", "--quiet", "--import", "pub.key"],
                       cwd=home, env=env, timeout=90, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       creationflags=flags)
        proc = subprocess.run([gpg, "--batch", "--quiet", "--verify", "sums.sig", "sums"],
                              cwd=home, env=env, timeout=90, capture_output=True,
                              creationflags=flags)
        if proc.returncode != 0:
            detail = _stderr_tail(proc.stderr)
            return f"failed: 签名校验不通过（gpg {proc.returncode}）{('：' + detail) if detail else ''}"
        return "ok"
    except subprocess.CalledProcessError as exc:
        detail = _stderr_tail(exc.stderr)
        return f"skipped: gpg 执行失败（{exc.returncode}）{('：' + detail) if detail else ''}"
    except subprocess.TimeoutExpired:
        return "skipped: gpg 超时"
    except Exception as exc:  # noqa: BLE001
        return f"skipped: gpg 执行失败（{exc.__class__.__name__}）"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _stderr_tail(raw, limit: int = 300) -> str:
    """把子进程 stderr 压成一行，供日志/返回值使用。"""
    if not raw:
        return ""
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    text = " ".join(text.split())
    return text[-limit:]


def download_asset(requests, url: str, dest: Path, px, retries: int = 5,
                   quiet: bool = False) -> str:
    """断点续传下载到 dest（staged 路径，绝不触碰 TARGET），返回 sha256。"""
    part = Path(str(dest) + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    attempt = 0
    while True:
        attempt += 1
        have = part.stat().st_size if part.exists() else 0
        if have > MAX_ASSET_BYTES:
            part.unlink(missing_ok=True)
            have = 0
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            resp = open_url(requests, url, RELEASE_HOSTS, px=px, timeout=(15, 60), headers=headers)
            try:
                if have and resp.status_code == 416:
                    # 已经下满时，必须能证明总长一致才接受，否则丢掉重下。
                    match = re.search(r"bytes\s+\*/(\d+)", resp.headers.get("content-range") or "")
                    expected_total = int(match.group(1)) if match else None
                    resp.close()
                    if expected_total is not None and have == expected_total:
                        break
                    part.unlink(missing_ok=True)
                    if attempt >= retries:
                        raise RuntimeError("续传状态异常：本地分片比远端大，且无法确认完整")
                    continue
                total = have + int(resp.headers.get("content-length") or 0)
                mode = "ab" if have and resp.status_code == 206 else "wb"
                if mode == "wb":
                    have = 0
                cap = min(MAX_ASSET_BYTES, total) if total else MAX_ASSET_BYTES
                with open(part, mode) as fh:
                    for chunk in resp.iter_content(1 << 16):
                        if not chunk:
                            continue
                        fh.write(chunk)
                        have += len(chunk)
                        if have > cap:
                            raise ValueError(f"下载体积超过预期上限 {cap} 字节，已中止")
            finally:
                resp.close()
            if total and have < total:
                raise OSError(f"下载不完整（{have}/{total} 字节）")
            break
        except Exception as exc:  # noqa: BLE001 - 续传要吃掉所有网络异常
            if attempt >= retries:
                part.unlink(missing_ok=True)
                raise
            log(f"下载中断（第 {attempt}/{retries} 次），稍后重试："
                f"{exc.__class__.__name__}: {exc}", quiet)
            time.sleep(min(2 ** attempt, 15))
    digest = sha256_file(part)
    os.replace(part, dest)
    return digest


def current_tag(state: dict) -> str:
    if TARGET.is_file():
        return str(state.get("tag") or "")
    return vendored_tag()


def verify_existing(state: dict) -> str:
    """更新前确认当前 TARGET 与上次记录一致；返回提示文本（不一致时要求重下）。"""
    expected = str(state.get("sha256") or "").lower()
    if not TARGET.is_file() or not SHA_RE.match(expected):
        return ""
    actual = sha256_file(TARGET)
    if actual != expected:
        log(f"当前 yt-dlp 与记录不符（{actual[:12]}… ≠ {expected[:12]}…），将重新下载")
        return "mismatch"
    return ""


def run_update(requests, *, force: bool = False, quiet: bool = False,
               min_interval: float = 0.0) -> int:
    """更新主流程。返回 0 表示「没有把状态搞坏」，不等于更新成功。"""
    state = read_state()
    last = float(state.get("checked_at") or 0)
    if not force and min_interval > 0 and time.time() - last < min_interval * 3600:
        log(f"跳过：{min_interval}h 内已检查过", quiet)
        return 0

    px = proxies()
    try:
        resp = open_url(requests, API, API_HOSTS, px=px, timeout=15,
                        headers={"Accept": "application/vnd.github+json",
                                 "User-Agent": "ytdlp-vision-updater"})
        release = json.loads(read_limited(resp, MAX_JSON_BYTES).decode("utf-8", "replace"))
        tag = str(release.get("tag_name") or "").strip()
    except Exception as exc:  # noqa: BLE001 - 网络问题不该报错退出
        log(f"查询 GitHub 失败（{exc.__class__.__name__}: {exc}）；沿用当前 yt-dlp", quiet)
        state["checked_at"] = time.time()
        state["last_error"] = str(exc)[:300]
        write_state(state)
        return 0

    if not TAG_RE.match(tag):
        log(f"GitHub 返回的 tag 格式不认识（{tag[:40]!r}），放弃本次更新", quiet)
        state["checked_at"] = time.time()
        state["last_error"] = f"非法 tag: {tag[:80]}"
        write_state(state)
        return 0

    if verify_existing(state) == "mismatch":
        state.pop("tag", None)
        state.pop("sha256", None)

    current = current_tag(state)
    state["checked_at"] = time.time()
    state.pop("last_error", None)
    if tag == current:
        log(f"yt-dlp 已是最新：{tag}", quiet)
        write_state(state)
        return 0

    log(f"发现新版本 {tag}（当前 {current or '无'}），开始下载", quiet)
    staged = STAGED
    try:
        expected, sums_bytes = fetch_expected(requests, tag, px)
    except Exception as exc:  # noqa: BLE001
        log(f"取不到 SHA2-256SUMS（{exc.__class__.__name__}: {exc}）；"
            f"没有可信校验信息，放弃更新，继续使用当前 yt-dlp", quiet)
        state["last_error"] = f"sums-failed: {exc}"[:300]
        write_state(state)
        return 0

    try:
        url = RELEASE_BASE.format(tag=tag, name=ASSET)
        actual = download_asset(requests, url, staged, px, quiet=quiet)
        if actual != expected:
            staged.unlink(missing_ok=True)
            raise RuntimeError(f"SHA256 校验失败：期望 {expected}，实际 {actual}")
        if staged.stat().st_size <= 0:
            staged.unlink(missing_ok=True)
            raise RuntimeError("下载到的文件是空的")
        sig = verify_signature(requests, tag, sums_bytes, px)
        if sig.startswith("failed"):
            staged.unlink(missing_ok=True)
            raise RuntimeError(f"GPG 验签未通过（{sig}），拒绝替换")
        try:
            os.replace(staged, TARGET)
        except OSError as exc:
            # Windows 上旧文件可能正被读取，保留旧版，下次启动再试。
            staged.unlink(missing_ok=True)
            raise RuntimeError(f"无法替换当前文件（{exc.__class__.__name__}），保留旧版") from exc
        state.update({"tag": tag, "sha256": actual, "file": TARGET.name,
                      "updated_at": time.time(), "signature": sig})
        write_state(state)
        log(f"yt-dlp 更新完成：{tag}（{TARGET.stat().st_size / 1048576:.1f}MB，签名 {sig}）", quiet)
    except Exception as exc:  # noqa: BLE001
        staged.unlink(missing_ok=True)
        Path(str(staged) + ".part").unlink(missing_ok=True)
        log(f"更新失败，继续使用旧版：{exc.__class__.__name__}: {exc}", quiet)
        state["last_error"] = f"download-failed: {exc}"[:300]
        write_state(state)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--min-interval", type=float, default=0.0,
                    help="距离上次检查不足这么多小时就跳过（默认 0 = 每次启动都查）")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    try:
        import requests
    except ImportError:
        log("缺少 requests，跳过 yt-dlp 更新", args.quiet)
        return 0

    try:
        return run_update(requests, force=args.force, quiet=args.quiet,
                          min_interval=args.min_interval)
    except Exception as exc:  # noqa: BLE001 - 后台任务不能把异常抛给 DSH
        log(f"更新流程异常退出（{exc.__class__.__name__}: {exc}），继续使用当前 yt-dlp", args.quiet)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
