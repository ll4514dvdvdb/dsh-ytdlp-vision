"""视频网站 cookie 的统一存取。

面板（`web/`）把配置写进 `<home>/cookies.json`，本模块负责读它并转成两种下游格式：

* **B 站官方 API**：直接用 `SESSDATA` 等字段拼 `Cookie:` 请求头。
* **yt-dlp**：生成 Netscape 格式的 `cookies.txt`，用 `--cookies` 交给 yt-dlp；
  也可以改用 `--cookies-from-browser <浏览器>` 现场读浏览器库。

约定：
- 文件权限 0600；值只在请求头/临时文件里出现，不写日志、不进缓存键。
- 面板配置优先于环境变量（`BILI_SESSDATA` 仍作为兜底，兼容旧装法）。
"""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# cookies.txt 里用的远期过期时间（2099-01-01），避免 yt-dlp 丢弃 session cookie。
FAR_FUTURE = 4070908800

# 常用站点的默认域；面板没给 domain 时按站点 id 兜底。
DEFAULT_DOMAINS = {
    "bilibili": ".bilibili.com",
    "youtube": ".youtube.com",
    "twitter": ".x.com",
    "vimeo": ".vimeo.com",
    "douyin": ".douyin.com",
}

# yt-dlp --cookies-from-browser 接受的浏览器名（值会进命令行，必须白名单）。
BROWSER_NAMES = frozenset({"brave", "chrome", "chromium", "edge", "firefox",
                           "opera", "opera_gx", "safari", "vivaldi", "whale"})
_BROWSER_SPEC = re.compile(r"^(?P<name>[a-z_]+)(?::(?P<profile>[^:\r\n\t]{1,80}))?$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def home() -> Path:
    base = os.environ.get("YTDLP_VISION_HOME")
    return Path(base) if base else (Path.home() / ".dsh" / "ytdlp-vision")


def config_path() -> Path:
    return home() / "cookies.json"


def _clean(text: str) -> str:
    """剔除会破坏 Cookie 头 / Netscape 行结构的控制字符（防头部注入与行注入）。"""
    return _CONTROL.sub("", text or "")


def _restrict(path: Path) -> None:
    """尽力把文件收紧到「只有当前用户 + SYSTEM 可读写」。

    POSIX 上 chmod 0600 就够；Windows 上 os.chmod 基本无效，改用 icacls 断继承 + 显式授权。
    失败不抛错（受限环境里可能没有 icacls 权限），但绝不因此让调用方崩溃。
    """
    if os.name != "nt":
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return
    user = os.environ.get("USERNAME") or getpass.getuser()
    try:
        subprocess.run(
            ["icacls", str(path), "/inheritance:r",
             "/grant:r", f"{user}:(F)", "/grant:r", "SYSTEM:(F)"],
            capture_output=True, timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        pass


def _warn(msg: str) -> None:
    print(f"[ytdlp-vision] {msg}", file=sys.stderr, flush=True)


def _read_raw() -> dict:
    path = config_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except ValueError as exc:
        # 内容损坏：备份一份再按空配置继续，避免后续写入把坏文件覆盖掉。
        _warn(f"读取 {path.name} 失败（{exc.__class__.__name__}），按空配置继续")
        try:
            broken = path.with_suffix(f".corrupt-{int(time.time())}.json")
            path.replace(broken)
            _warn(f"已把损坏的配置文件移到 {broken.name}，可在面板里重新生成")
        except OSError:
            pass
        return {}
    except OSError as exc:
        # 权限/占用之类的问题不动文件，只报告；下次调用可能就好了。
        _warn(f"读取 {path.name} 失败（{exc.__class__.__name__}），本次按空配置继续")
        return {}
    return raw if isinstance(raw, dict) else {}


def load() -> dict:
    """返回规范化后的配置；任何损坏都退化成空配置而不是抛错。"""
    raw = _read_raw()
    if not isinstance(raw, dict):
        return {}
    sites = raw.get("sites")
    out: dict[str, dict] = {}
    if isinstance(sites, dict):
        for site_id, entry in sites.items():
            if not isinstance(entry, dict):
                continue
            pairs: list[dict] = []
            for item in entry.get("cookies") or []:
                if isinstance(item, dict):
                    name, value = item.get("name"), item.get("value")
                elif isinstance(item, (list, tuple)) and len(item) >= 2:
                    name, value = item[0], item[1]
                else:
                    continue
                if isinstance(name, str) and name.strip() and isinstance(value, str) and value.strip():
                    pairs.append({"name": name.strip(), "value": value.strip()})
            out[str(site_id)] = {
                "enabled": bool(entry.get("enabled")),
                "domain": str(entry.get("domain") or DEFAULT_DOMAINS.get(str(site_id), "")).strip(),
                "cookies": pairs,
            }
    browser = raw.get("browser") if isinstance(raw.get("browser"), dict) else {}
    return {
        "sites": out,
        "browser": {
            "from": str(browser.get("from") or "off"),
            "name": str(browser.get("name") or "edge"),
        },
        "extra": str(raw.get("extra") or ""),
    }


def _site_values(cfg: dict, site_id: str) -> dict[str, str]:
    site = cfg.get("sites", {}).get(site_id) or {}
    if not site.get("enabled"):
        return {}
    return {item["name"]: item["value"] for item in site.get("cookies") or []}


def sessdata() -> str:
    """B 站 SESSDATA：面板配置优先，环境变量兜底。"""
    value = _site_values(load(), "bilibili").get("SESSDATA", "")
    return value or os.environ.get("BILI_SESSDATA", "").strip()


def bili_cookie() -> str:
    """拼出 B 站请求头用的 Cookie 字符串（只要配了的字段）。"""
    values = _site_values(load(), "bilibili")
    if not values:
        sess = _clean(os.environ.get("BILI_SESSDATA", "").strip())
        return f"SESSDATA={sess}" if sess else ""
    # 顺序固定，便于日志阅读；只带面板里出现的字段。
    order = ("SESSDATA", "bili_jct", "buvid3", "DedeUserID", "SESSDATA_ENC")
    names = [n for n in order if n in values] + [n for n in values if n not in order]
    pairs = []
    for name in names:
        token, value = _clean(name).strip(), _clean(values[name]).strip()
        if token and value:  # 空名/空值会把 Cookie 头弄坏
            pairs.append(f"{token}={value}")
    return "; ".join(pairs)


def _netscape_body(cfg: dict) -> str:
    lines = ["# Netscape HTTP Cookie File", "# generated by ytdlp-vision; do not edit by hand", ""]
    for site_id, site in (cfg.get("sites") or {}).items():
        if not site.get("enabled") or not site.get("cookies"):
            continue
        domain = _clean(site.get("domain") or DEFAULT_DOMAINS.get(site_id, "")).strip()
        if not domain:
            continue
        include_sub = "TRUE" if domain.startswith(".") else "FALSE"
        for item in site["cookies"]:
            name, value = _clean(item["name"]).strip(), _clean(item["value"]).strip()
            if not name or not value:
                continue
            # Netscape 一行 7 列，用 TAB 分隔；控制字符已在上面剔除，不会串行。
            lines.append("\t".join([domain, include_sub, "/", "TRUE", str(FAR_FUTURE), name, value]))
    extra = (cfg.get("extra") or "").strip()
    if extra:
        lines.append("")
        lines.extend(line for line in extra.splitlines() if line.strip() and not line.startswith("#"))
    return "\n".join(lines) + "\n"


def export_netscape() -> str:
    """导出当前配置为 Netscape 文本（面板「导出」按钮用，不落盘）。"""
    return _netscape_body(load())


def netscape_path() -> Path | None:
    """把启用中的 cookie 写成 Netscape 文件；没有可用配置时返回 None。

    内容有变化才重写，避免每次调用都碰磁盘。
    """
    body = _netscape_body(load())
    has_rows = any(line and not line.startswith("#") for line in body.splitlines())
    if not has_rows:
        return None
    target = home() / "cookies.txt"
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    stamp = target.with_suffix(".sha256")
    try:
        if target.is_file() and stamp.is_file() and stamp.read_text(encoding="utf-8").strip() == digest:
            return target
    except OSError:
        pass
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".cookies-", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(body)
        _restrict(Path(tmp))
        os.replace(tmp, target)
        _restrict(target)
        stamp.write_text(digest, encoding="utf-8")
    except OSError as exc:
        _warn(f"写入 {target.name} 失败（{exc.__class__.__name__}: {exc}），本次不带 cookie")
        return None
    return target


def _browser_spec(name: str) -> str | None:
    """校验 --cookies-from-browser 的取值，防命令参数被注入或塞进奇怪的东西。"""
    match = _BROWSER_SPEC.match((name or "").strip().lower())
    if not match or match.group("name") not in BROWSER_NAMES:
        return None
    return match.group(0)


def ytdlp_auth_args() -> list[str]:
    """给 yt-dlp 追加的鉴权参数：优先用浏览器直读，其次用 cookies.txt。"""
    cfg = load()
    browser = cfg.get("browser") or {}
    if browser.get("from") != "off" and browser.get("name"):
        spec = _browser_spec(browser["name"])
        if spec:
            return ["--cookies-from-browser", spec]
        _warn(f"面板里的浏览器名 {browser['name']!r} 不在支持列表内，改用 cookies.txt")
    path = netscape_path()
    if path is not None:
        return ["--cookies", str(path)]
    return []


if __name__ == "__main__":  # 手动排查用：python cookies.py
    cfg = load()
    print("config:", config_path(), "exists:", config_path().is_file())
    for site_id, site in cfg.get("sites", {}).items():
        print(f"  {site_id}: enabled={site['enabled']} domain={site['domain']} keys={[c['name'] for c in site['cookies']]}")
    print("browser:", cfg.get("browser"))
    print("sessdata set:", bool(sessdata()))
    print("netscape:", netscape_path())
    print("yt-dlp args:", ytdlp_auth_args())
