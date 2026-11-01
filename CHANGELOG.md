# Changelog

## 0.4.0 — 2026-11-01

新增可视化 cookie 配置页面，登录态配置不再依赖环境变量。

- **面板**：`client.js` 注册侧栏入口（order 31）与对话视图标签（order 41），页面本体是同源 iframe `/ytdlp-vision-panel/`，由插件的 `webServer` 前缀路由提供（`panel/routes.js`）。不引入构建步骤，页面就是普通 HTML/CSS/JS。
- **多站点**：B 站 / YouTube / X / Vimeo / 抖音预置字段，外加自定义站点（任意 id + cookie 域）。每站点独立开关，关掉即不写入 `cookies.txt`。
- **整串粘贴**：同时解析 `a=b; c=d` 与 Netscape 制表符行，一次写入多个字段。
- **B 站验证登录**：`POST /test` 调 `x/web-interface/nav` 实测 SESSDATA，返回昵称与等级；直连被风控时给出明确提示。
- **浏览器直读**：可选 `--cookies-from-browser edge|chrome|chromium|firefox|brave|safari|off`，此时 yt-dlp 现场读浏览器库，不落盘。
- **存储**：`~/.dsh/ytdlp-vision/cookies.json`（0600）由 Node 写、Python `cookies.py` 读，两侧共用同一份格式；`cookies.txt` 由任一方向生成，带 sha256 陈旧检测，内容不变不重写。
- **安全**：页面只拿到脱敏值（`abcd…wxyz`）；路由只认 loopback 源地址，API 要求自定义头 `x-ytdlp-vision`；`cookies.json` / `cookies.txt` 均 0600。
- **接入**：`vision.py` 的 `_cookie()` 改为 `cookies.bili_cookie()`，面板配置优先于 `BILI_SESSDATA`；`sources.py` 的 `ytdlp_json` / `download_audio_ytdlp` / `download_video_ytdlp` 都追加 `cookies.ytdlp_auth_args()`。
- **packaging**：`package.json` 增加 `exports["./client"]`、`dsh.client`（inject locale/layout/sidebar，platform web），`files` 收录 `client.js` / `panel/` / `web/`。

实测：面板页面渲染、站点保存、整串解析、B 站登录校验（无效 SESSDATA 正确返回 `-101 账号未登录`）、`cookies.txt` 生成、浏览器直读切换、自定义站点添加均通过；`yt-dlp --cookies <生成文件>` 抓 YouTube 正常。

> 升级说明：0.4.0 新增了客户端 bundle 与 HTTP 路由，升级后必须**完全退出并重开 DSH**（HMR 不会重新挂载 `webServer` 路由）。

Tested host: DSH 0.2.1-rc.3 on Windows 11, Python 3.12.14。其他宿主版本与操作系统需自行验证。

## 0.3.0 — 2026-11-01

从 `bili-vision` 0.2.0 分叉扩展为多平台插件，包名与工具名改为 `ytdlp-vision` / `ytdlp_vision` / `ytdlp_summary`。

- **多平台**：新增 `sources.py` 源适配层。B 站继续走官方 API（保留 SESSDATA、CC 字幕、1080P 选流），其他站点交给 yt-dlp 抓元数据、字幕、音轨与 ≤H 视频。上层抽帧/选帧/ASR/OCR/证据组装完全复用，不重复实现。
- **yt-dlp 内置**：`vendor/yt-dlp-py.zip`（zipapp，2026.10.26）+ `vendor/SHA2-256SUMS` + `vendor/VERSION.json`。Windows 上不用 `yt-dlp.exe`——PyInstaller 单文件在受限环境会 `Failed to create parent directory structure`。
- **启动自更新**：`update.py` 在 DSH 启动 0.8 秒后后台静默执行，查 GitHub latest release，tag 变化才下载，Range 断点续传 + SHA256 校验 + 原子替换；失败只写日志，绝不阻塞启动。`updateOnBoot` / `updateIntervalHours` / `YTDLP_VISION_PROXY` 可配。
- **字幕策略**：人工字幕优先于自动字幕，语言优先级 zh-Hans > zh-CN > zh > zh-Hant > zh-TW > zh-HK > en > en-US > en-GB > ja > ko；解析 json3 / VTT / SRT，滚动字幕按 `gap=0.35s, max_len=120` 合并；拿不到字幕自动降级到 faster-whisper ASR。
- **B 站 412 修复**：`_bili_request()` 先直连（`proxies={'http':None,'https':None}`），状态码 412 或连接异常时记录日志并回退系统代理。开着全局代理时 B 站风控海外 IP 会返回 412，此改动让两种网络环境都能用。
- **配置迁移**：环境变量前缀改为 `YTDLP_VISION_*`，仍回退读取 `BILI_VISION_*`；缓存版本 `CACHE_VERSION` 2 → 3，避免与旧插件缓存互串。
- **测试**：`tests/plugin.test.mjs` 6 项通过 5 项（末项在 DSH 沙箱下 `spawn EPERM`，属环境限制）；`tests/host.test.mjs` 与 `tests/prepare_fixture.py` 已适配新模块名与 `v3` 缓存目录。

Tested host: DSH 0.2.1-rc.3 on Windows 11, Python 3.12.14。B 站（BV1GJ411x7h7）与 YouTube（dQw4w9WgXcQ）端到端实测通过。其他平台、其他宿主版本与操作系统需自行验证。
不宣称逐帧穷尽理解，也不宣称测得的延迟或成本节省。

## 0.2.0 — 2026-10-23

- Return timestamped video evidence as native DSH image attachments with subtitles, local ASR and OCR.
- Preserve optional independent vision API analysis through `action=run`; direct evidence uses `action=inspect`.
- Add full-video temporal coverage, focused time ranges, configurable grids and exact image deduplication.
- Cache transcripts, frames, OCR and independent model answers; isolate multipart videos and incomplete downloads.
- Validate tool schemas and image-capable routes; cancel child processes when the tool is cancelled.
- Fix frame tail extraction, JPEG encoding and PowerShell profile manifest updates.
- Package as a DSH bundle with public exports, localized metadata and explicit compatibility range.

Tested host: DSH 0.2.0-rc.2 on Windows. Other host versions and operating systems require validation.
No claim of exhaustive frame-by-frame understanding or measured latency/cost savings is made.
