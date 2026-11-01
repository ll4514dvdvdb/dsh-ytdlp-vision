# Changelog

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
