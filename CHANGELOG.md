# Changelog

## 0.7.1 — 2026-11-06

0.7.0 发布后第一次跑 GitHub Actions 暴露出来的问题，加上真机验证自动更新的 GPG 验签。

**自动更新（`update.py`）**
- 修：GitHub 已经把 release 资产的 302 目标换成了 `release-assets.githubusercontent.com`，白名单里只有 `github.com` 和 `objects.githubusercontent.com`，导致真实环境下每次更新都报「拒绝非可信主机」。现在把新域名加入白名单，旧域名保留兼容（`update.py` `RELEASE_HOSTS`）。这是纯离线单测测不出来的问题——假请求不会真的重定向。
- 修：GPG 验签在 Windows 上从来没成功过。Git for Windows 自带的是 MSYS 版 gpg，它把 `--keyring "C:\..."` 当成资源 URL 解析（`gpg: invalid key resource URL`），把 `GNUPGHOME=C:\...` 当成相对 POSIX 路径。现在改成在临时目录里用**相对文件名 + `cwd`**，`GNUPGHOME="gnupg"`，并去掉多余的 `--no-default-keyring/--keyring`（隔离本来就由独立 `GNUPGHOME` 保证）。
- 修：验签失败时只返回「gpg 执行失败」，看不到原因。现在带上 gpg 的 stderr 末尾（压成单行）。
- 修：临时目录不再用 `tempfile.mkdtemp()`，改为在 `~/.dsh/ytdlp-vision/` 下建 `gpg-<pid>-<时间戳>/`。原因是受限环境里 `%TEMP%` 可能不可写，而 `mkdtemp` 按 `0o700` 建出来的目录在带过滤驱动的环境里连自己都写不进去（实测 `PermissionError`）。

**依赖与 CI**
- `requirements.txt`: `Pillow>=10.1,<13` → `<14`。`pip-audit` 报 Pillow 12.3.0 有 21 条漏洞，修复版是 13.0.0，而原上界把修复版挡住了。已用 Pillow 13.0.0 跑通全部 27 项 pipeline 测试（`gridify()` 用到的 API 无变化）。
- `.github/workflows/ci.yml`: Python 测试步骤补装 `requests`、`numpy`。原来只装 `Pillow`，导致 4 项测试在 CI 上报 `ModuleNotFoundError`。

**跨平台字节一致性**
- 新增 `.gitattributes`：`vendor/yt-dlp-public.key` 标 `-text`，`vendor/SHA2-256SUMS`、`SHA2-512SUMS`、`yt-dlp-py.zip` 标 `binary`，源码统一 `eol=lf`。Windows 默认 `core.autocrlf=true` 会在检出时把 LF 转 CRLF，公钥字节一变就对不上 `update.py` 里钉死的 `PUBKEY_SHA256`——结果是**所有 git clone 用户的 GPG 验签被永久静默跳过**。CI 的 windows runner 上两个签名测试挂掉才暴露。
- 修 `test_probe_local_propagates_ffprobe_error`：原来只 patch `vision.run`，但 `probe_local()` 第一行就调 `fp()`，没装 ffprobe 的机器上先抛 `SystemExit`。补 patch `fp()` 返回假路径。

**测试**
- `tests/test_update.py` 新增 6 项：`release-assets` 重定向、验签成功、验签失败带原因、公钥导入失败、没有 gpg、包内公钥被篡改后不调用 gpg。Python 测试从 78 项增到 84 项。

实测：`python -m unittest discover` 84 项通过、`ruff check .` 无告警；真实网络下 `verify_signature()` 对官方 `SHA2-256SUMS` 返回 `ok`，篡改后返回 `failed` 并带 `BAD signature`。

## 0.7.0 — 2026-11-06

安全与可靠性加固。功能没删，配置格式没变（`cookies.json` 仍是 v2，旧文件直接可用）。

**自动更新（`update.py`、`scripts/fetch-ytdlp.py`）**
- 拿不到 `SHA2-256SUMS` 就**放弃更新**，不再「没有校验信息也照装」。
- 下载只写 `<目标>.part`，校验通过才原子替换；哈希不符、文件为空、下载截断都保留旧版本。
- 逐跳校验重定向目标，只允许 `https://github.com`、`https://objects.githubusercontent.com`、`https://api.github.com`；非 https、带凭据、跳转到别的域名一律拒绝。
- API/SHA2-256SUMS/资产都有响应体大小上限；tag 必须匹配 `YYYY.MM.DD[.N]` 才会拼进下载地址。
- 可选 GPG 验签：包内钉死 yt-dlp 官方公钥（`vendor/yt-dlp-public.key`，sha256 写死在 `update.py`），机器上有 `gpg` 时验 `SHA2-256SUMS.sig`，验签失败拒绝替换；没有 `gpg` 就跳过并记日志。
- 本地当前版本与 `state.json` 记录的哈希不符（被人换过）时强制重下。

**Cookie（`cookies.py`、`panel/store.js`、`panel/routes.js`、`web/`）**
- 文件权限：POSIX `0600`/目录 `0700`；Windows 用 `icacls` 断继承，只给当前用户和 SYSTEM。
- `cookies.json` 损坏时备份成 `cookies.json.corrupt-<时间戳>` 再从空配置开始，不再静默丢数据。
- 导入/导出都过滤控制字符，Netscape 第 4 列按 cookie 自己的 `secure` 输出（原来恒为 `TRUE`，纯 http 站点会收不到）。
- 新增「导出 Netscape 文件」按钮（`POST export`），提示明文凭据、用完及时删除。
- 拒绝 `__proto__`/`constructor`/`prototype` 作站点 id（原型污染），浏览器名走白名单；非法值降级成 `--cookies cookies.txt`。
- 外部进程（Python 侧或另一个 DSH 实例）改过 `cookies.json` 时按 mtime 重新加载，不再用内存旧值覆盖。

**命令执行与网络（`sources.py`、`vision.py`、`index.js`、`panel/grabber.js`）**
- 字幕地址限制为公网 http(s)，逐跳校验重定向，体积上限 8MB，超限即中止（原来可以指向内网地址）。
- `yt-dlp -J` 输出上限 32MB；下载加 `--max-filesize 4G`；去掉 `--no-part`，避免中断留下残缺文件被当成有效媒体。
- 本地视频/媒体下载有大小上限（默认 8GB，`YTDLP_VISION_MAX_MEDIA_GB`）和磁盘余量检查（默认留 1GB）。
- 浏览器 profile 目录权限收紧；DevTools WebSocket 只连 `127.0.0.1`/`::1`/`localhost`。
- 并发分析任务受 `YTDLP_VISION_MAX_PARALLEL` 限制（默认 2）。

**资源与缓存**
- ASR 缓存键加入音频文件指纹（大小 + mtime），换音轨不会再命中旧转写。
- ASR 解码不再把整段音频拼成一个大数组；超过 4 小时（`YTDLP_VISION_MAX_ASR_SECONDS`）跳过转写并说明原因，而不是静默截断。
- 新增 `cache-stats` / `cache-clean` 命令：按容量上限（默认 5GB）、TTL（默认 30 天）、旧 `CACHE_VERSION` 清理；删除前抢同一把 `video_lock` 锁，正在使用的条目跳过。
- 视频时长/分辨率超建议值时给警告（不阻断），`main()` 兜住 `OSError`，磁盘满、无权限都有中文提示。
- `frame_scores()` 的流式解码加看门狗（`YTDLP_VISION_FFMPEG_TIMEOUT`，默认 900 秒）：ffmpeg 卡死时杀进程并报错，不再让整个分析永久阻塞。
- 删光/删掉站点后不再残留旧 `cookies.txt`（原来只清了内存配置，文件里还留着已删除站点的凭据）。

**可诊断性**
- B 站错误码映射成人话（`-101` 登录失效→重抓 Cookie、`-404` 视频已删除、`-412` 代理导致风控…）。
- 接口请求失败会写明是哪一步（取元数据、下载、字幕、转写）。

**发布与测试**
- 新增 `.github/workflows/ci.yml`：Windows + Linux 双平台跑 Python/Node 测试、语法检查、`pip-audit` 依赖审计、发布一致性检查。
- 新增 `lint` job 与静态检查配置：`.ruff.toml`（pyflakes + bugbear + 语法级错误）、`eslint.config.mjs`（只查真会出错的规则，手写规则不依赖 `@eslint/js`）。本地对应 `npm run lint:py` / `npm run lint`。
- 新增 `.github/dependabot.yml`：pip / npm / github-actions 每周检查依赖版本。
- 新增 `scripts/check-release.py`：校验 README/CHANGELOG/package.json 版本一致、vendor 资产哈希、公钥哈希、requirements 上界。
- 测试从 30 个（Python 26 + Node 4）扩到 97 个（Python 78 + Node 19），全部离线，不依赖真实 Cookie 和网络；本机可跑通 95 个，剩余 2 个受沙箱/依赖限制（详见 `docs/changes-0.7.0.md` §13）。
- 补上「ffprobe 不存在」与 `transcribe()` 三条 ASR 降级路径（无 faster-whisper、模型加载失败、转写失败）的独立测试。
- 修 `web/app.js` 四处 GET/POST 不匹配（`grab/finish`、`grab/cancel`、`sync` 一直 404）。
- `cordis.patch.yml` 去掉写死的本机 Python 路径，改为自动探测。
- 版本号统一到 0.7.0（README 之前还写着 0.4.0）。

实测：Windows 11 + DSH 0.2.1-rc.3 + Python 3.12.14，`python -m unittest discover` 78 项通过、`ruff check .` 与 `eslint .` 均无告警；B 站/YouTube/TikTok 元数据解析正常，本地视频全链路正常。

## 0.6.0 — 2026-11-01

两种新输入：整列视频，和硬盘上的文件。

- **播放列表 / 合集**：target 换成播放列表链接（`/playlist?list=`、`/@频道/videos`、`space.bilibili.com/…/lists`、`/sets/` 等）会自动识别，不再偷偷只取第一条。
  - `action=plan` 返回条目清单（序号、标题、时长、可单独使用的 url），清单缓存 24h，第二次取第 N 条是秒开。
  - `index=N` 直接按第 N 条走完整分析（抽帧 + 字幕 + OCR）。
  - `action=text` + `limit=N` 批量取前 N 条的字幕/转写，一次看完整列讲什么。
  - 单个视频链接带 `&list=` 时默认仍只看当前视频，要整列处理得显式 `playlist=true`。
- **本地视频文件**：target 给本机路径（绝对路径、相对路径、`file://` 都行，支持 mp4/mkv/webm/mov/flv/ts/m4v/avi/wmv/mpg/mpeg/ogv/3gp/m2ts/mts）。
  - 不下载、不走网络：ffprobe 读时长和分辨率，抽帧直接读原文件，音轨用 PyAV 从容器里解，不用先转音频。
  - 旁边有同名 `.srt` / `.vtt` / `.json3` 字幕就自动加载，不额外跑 ASR。
  - 缓存目录按「文件名 + 路径哈希」隔离，同一文件重复分析命中缓存。
- **修复**：`_bili_request` 对没有 `status_code` 的响应对象（单测 mock）会抛 `AttributeError`，改成 `getattr` 兜底。

## 0.5.0 — 2026-11-01

面板从「每站填一堆字段」改成「点一下、登录、完事」。配置量从十几个输入框降到 0。

- **自动抓取**：点「+ 生成新的 Cookies」→ 选站点或填任意 URL → 本机浏览器打开登录页 → 登录后**自动关窗保存**。零依赖实现：spawn Chrome/Edge 带 `--remote-debugging-port=0` + 独立 `--user-data-dir`，读 `DevToolsActivePort` 拿端口，手写 RFC6455 客户端（`panel/ws.js`）连 CDP，`Target.attachToTarget({flatten:true})` + `Network.getAllCookies` 取 cookie，每 1.2s 轮询到关键项出现即完成，`taskkill /PID <pid> /T /F` 收尾。
- **全部 cookie 落盘**：不再按白名单裁剪，站点域下抓到多少存多少（连带 `buvid3` / `_uuid` / `bili_ticket` 这类风控 cookie 一起留），冷门站点也不会漏字段。
- **手动「保存并关闭」**：所有站点都有，包括会自动保存的预设。自定义域名没有关键项声明、不会自动关，靠这个按钮收尾。
- **15 个预设**（`panel/sites.js`）：B 站、YouTube、X/Twitter、抖音、TikTok、Twitch、Instagram、Facebook、Vimeo、AcFun、小红书、微博、Reddit、niconico、Dailymotion。预设只决定登录页、自动判定用的关键 cookie、默认域名范围。
- **任意网址可用**：`siteFromUrl()` 从 hostname 推自定义站点，带二级公共后缀处理（`video.example.co.uk` → `example.co.uk`）。
- **三条路并存**：自动抓取（默认）/ 手动粘贴 / 浏览器直读（`--cookies-from-browser`），互不排斥。
- **数据格式 v2**：站点从「固定字段列表」改成「cookie 数组」，每条保留 `domain/path/secure/httpOnly`；`cookies.txt` 按每条 cookie 自己的域输出。
- **无浏览器时的降级**：`GET state` 返回 `browser:{ok,label|reason}`，找不到浏览器则「生成」按钮置灰并说明原因，手动填仍然可用。

实测（Windows 11 + Chrome，`YTDLP_VISION_HEADLESS=1` 便于自动化）：`POST grab/start` 打开 bilibili.com 后 9 秒读到 14 个 cookie（`_uuid` / `b_lsid` / `b_nut` / `bili_ticket` / `bmg_*` / `buvid3` / `buvid4` / `buvid_fp` 等），状态 `satisfied:false`（未登录，符合预期）；`POST grab/finish` 保存 14 条 → `cookies.txt` 1287 B / 17 行，站点标记 `source:"grab"`；页面顶栏「共 14 个 cookie，来自 1 个站点」，站点行「14 个 · 自动抓取 · 11月1日 11:25」，展开可见脱敏列表；「验证登录」对无 SESSDATA 的集合正确提示「还没填 SESSDATA」；结束后无残留 chrome 进程。`tests/sites.test.mjs` 4/4（预设健全、`domainMatches` 双向后缀、`siteFromUrl` 预设与自定义、`isSatisfied` 空 need 恒 false）。

> 升级说明：新增 `webServer` 路由与客户端 bundle，升级后必须**完全退出并重开 DSH**；`cookies.json` 会自动迁移到 v2 格式。

Tested host: DSH 0.2.1-rc.3 on Windows 11, Python 3.12.14。其他宿主版本与操作系统需自行验证。

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
