# ytdlp-vision

给 DSH（DeepSeek Harness）的多平台视频证据插件：把 B 站、YouTube、Vimeo、X、TikTok、Twitch 等站点的视频，转成**带真实时间戳的画面帧 + 字幕/转写文本 + OCR 文本**，直接交给当前对话模型看。

它不是"总结视频"的独立模型，而是把视频**降维成当前模型能吃下的证据**：不下载整片、不抽全片、按问题选帧，文本与画面一起返回。

---

## 和 bili-vision 的关系

| | bili-vision（旧） | ytdlp-vision（本插件） |
|---|---|---|
| 平台 | 只有 B 站 | B 站 + yt-dlp 支持的 1000+ 站点 |
| B 站抓取 | 官方 API（SESSDATA、1080P 选流） | **保留**，同一套实现 |
| 其他平台 | 不支持 | yt-dlp 抓元数据 / 字幕 / 音视频 |
| yt-dlp 版本 | — | 包内自带 + 每次启动后台自动更新 |
| cookie 配置 | 只能设环境变量 | **自带可视化页面**，多站点、可验证登录 |
| 工具名 | `bili_vision` / `bili_summary` | `ytdlp_vision` / `ytdlp_summary` |

本插件**完全替代** bili-vision：先卸旧的再装这个，两个不要同时挂载。

---

## 工作原理

```
target ──┬─ B 站（BV 号 / bilibili.com / b23.tv）
         │     → 官方 API：view / player.v2 / playurl
         │     → 字幕接口 + SESSDATA（登录态才能拿 1080P 和 CC 字幕）
         │
         └─ 其他链接
               → yt-dlp -J 取元数据与字幕清单
               → yt-dlp 下载音轨 / ≤H 视频
                     ↓
        统一进入同一条管线：
          字幕优先 → 无字幕则 faster-whisper 本地转写（ASR）
          视频按场景切分打分 → 选帧 → 合成网格图（可 OCR）
                     ↓
        返回：文本证据（带时间戳）+ 原生图片块 + 结构化 coverage
```

**关键设计**：B 站不走 yt-dlp。实测 yt-dlp 抓 B 站会 `HTTP Error 412: Precondition Failed`（风控），加 UA 和 Referer 也无效，所以 B 站保留原来的官方 API 实现。

---

## 安装

```powershell
# 1. 取包（或用 git clone https://github.com/ll4514dvdvdb/dsh-ytdlp-vision）
curl -L -o ytdlp-vision.zip https://github.com/ll4514dvdvdb/dsh-ytdlp-vision/releases/download/v0.7.0/ytdlp-vision-0.7.0.zip
Expand-Archive ytdlp-vision.zip -DestinationPath "$env:USERPROFILE\.dsh\ytdlp-vision-src" -Force

# 2. 装 Python 依赖（用 DSH 自带解释器或任意 3.10+）
& "$env:USERPROFILE\.dsh\bili-vision-venv\Scripts\python.exe" -m pip install -r "$env:USERPROFILE\.dsh\ytdlp-vision-src\requirements.txt"

# 3. 注册进 profile，然后完全退出重开 DSH
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "file:$env:USERPROFILE\.dsh\ytdlp-vision-src"
```

装好后工具名是 `ytdlp_vision` / `ytdlp_summary`。**不要和 `bili-vision` 同时装**，两者注册的是同一套能力。

> 本插件为个人自用改造版，上游 `bili-vision` 的 B 站抓取代码沿用其实现；未经原作者审阅。使用前请自行确认目标站点的服务条款与当地法律。

## 依赖

| 依赖 | 说明 |
|---|---|
| Python ≥ 3.10 | 插件本体；自动探测 `bili-vision-venv` / `ytdlp-vision-venv` / DSH 自带 python |
| `ffmpeg` / `ffprobe` | 抽帧、封装。需自行安装并让插件找得到（`BILI_VISION_FFMPEG` 等 env 或 PATH） |
| `yt-dlp` | **包内自带** `vendor/yt-dlp-py.zip`（zipapp，约 3MB），无需手动装 |
| faster-whisper ≥ 1.1 | 无字幕视频的本地转写；首次自动下模型 |
| rapidocr_onnxruntime | 可选，画面文字识别 |
| requests / numpy / Pillow / av | 见 `requirements.txt` |

> 不需要 `yt-dlp.exe`。Windows 上 PyInstaller 打包的单文件在受限环境里会报 `Failed to create parent directory structure`，所以本插件用 zipapp + Python 解释器跑。

```powershell
python -m pip install -r requirements.txt
```

---

## 工具

### `ytdlp_vision`

| 参数 | 类型 | 说明 |
|---|---|---|
| `target` | string，必填 | BV 号、B 站链接、b23.tv 短链、任意 yt-dlp 支持的 URL、播放列表/合集链接，或本机视频文件路径 |
| `action` | `inspect`（默认）/ `plan` / `text` / `frames` / `run` | 见下 |
| `ask` | string | 你的问题，用于选帧相关度打分 |
| `policy` | `auto` / `always` / `text` | `text` 只取文本证据，跳过所有画面处理 |
| `maxVision` | 1–36，默认 12 | 最多返回多少帧（会被 `attachments.imageLimits.maxImagesPerMessage` 夹住） |
| `gridSize` | 1 / 4 / 9，默认 4 | 每张图拼几帧；`1` 看细节，`9` 看动作 |
| `start` / `end` | 秒 | 只看某段时间 |
| `maxTextTokens` | 2000–64000，默认 12000 | 文本预算；超出会明确标记省略 |
| `ocr` | boolean，默认 true | 对选中帧做 OCR |
| `refresh` | boolean | 绕过缓存重算 |
| `sessionData` | string | 覆盖 B 站 SESSDATA（一般用 env） |
| `playlist` | boolean | 强制把 target 当播放列表；带 `&list=` 的单个视频链接默认只看当前视频 |
| `index` | 1–9999 | 播放列表里的第几条，选中后按单条走完整分析 |
| `limit` | 1–100，默认 10 | `action=text` 批量取字幕时的条数上限 |

`action` 的区别：

- `inspect`（推荐）：文本 + 全片覆盖 + 问题相关帧一起给，证据仍占当前模型 token，但没有额外 API 调用。
- `text`：只要字幕/转写，不下载视频，最快最省。对播放列表用 `text` 会返回前 `limit` 条的字幕摘要。
- `plan`：只算预算和选帧计划，不抽帧。对播放列表只返回条目清单。
- `frames`：只抽帧，不做转录。
- `run`：额外调用独立的视觉 API（需在 config 里配），成本另算。

### 播放列表 / 合集

链接带 `/playlist?list=`、`/@频道/videos`、`space.bilibili.com/…/lists`、`/sets/` 这类特征时自动识别成列表（`space.bilibili.com` 的 B 站合集也支持）。清单缓存 24 小时，所以第二次取第 N 条是秒开的。

```
# 先看有什么
ytdlp_vision({ target: "https://www.youtube.com/@频道/videos", action: "plan" })

# 分析第 3 条（完整抽帧 + 字幕）
ytdlp_vision({ target: "...", index: 3 })

# 整列讲什么：批量拿前 5 条字幕
ytdlp_vision({ target: "...", action: "text", limit: 5 })
```

单个视频链接里带 `&list=` 时默认只看当前视频（多数人的意图），要整列处理传 `playlist: true`。

### 本地视频文件

`target` 直接给本机路径即可——绝对路径、相对路径、带引号、`file://` 都认，扩展名支持 mp4 / mkv / webm / mov / flv / ts / m4v / avi / wmv / mpg / mpeg / ogv / 3gp / m2ts / mts。

- 不下载、不联网：ffprobe 读时长和分辨率，抽帧直接读原文件，音轨用 PyAV 从容器里解（不用先转音频）。
- 旁边有同名 `.srt` / `.vtt` / `.json3` 字幕会自动加载，省掉 ASR。
- 缓存目录按「文件名 + 路径哈希」隔离，同一个文件重复分析命中缓存。

```
ytdlp_vision({ target: "D:/recordings/meeting.mp4", action: "text" })
ytdlp_vision({ target: "C:/videos/demo.mkv", ask: "演示了哪几步操作", start: 60, end: 180 })
```

### `ytdlp_summary`

等价于 `ytdlp_vision` + `action: "text"`，纯文本摘要入口。

此外提供一个**可视化的 cookie 配置页面**（侧栏「视频 Cookie」），见下一节。

---

## Cookie 配置页面

登录墙、年龄限制、会员视频需要 cookie。插件自带一个同源页面，**点两下就能拿到 cookie**，不用改环境变量、不用手搓 Netscape 文件、不用去 F12 里翻。

打开方式：侧栏图标「视频 Cookie」，或直接访问 `http://<GUI 地址>/ytdlp-vision-panel/`（只在 loopback 上应答）。

### 自动抓取（推荐）

1. 点「+ 生成新的 Cookies」
2. 选一个站点快捷按钮（会自动填好登录页），或者自己贴任意网址
3. 点「开始」——本机浏览器会打开那个页面
4. 在里面正常登录
5. **识别到登录态就自动关窗并保存**；识别不到（冷门站点）就自己点「保存并关闭」

保存的是**该站点域下的全部 cookie**，不做白名单裁剪，所以冷门站点的鉴权字段也不会漏。拿到的连带 cookie（`buvid3`、`_uuid`、`bili_ticket` 之类）原样留着，下次抓取时一并带上，风控更稳。

**为什么能自动判定**：每个预设声明了关键的登录 cookie（比如 B 站要 `SESSDATA`，X 要 `auth_token`）。抓取时每 1.2 秒读一次浏览器里的 cookie 集合，关键项出现即认为登录完成。没有声明关键项的站点（自定义域名）不会自动关，交给「保存并关闭」按钮——**这个按钮在所有站点上都有**，包括会自动保存的那些，保证任何情况都能手动收尾。

**原理**：插件以独立 profile 启动你本机的 Chrome/Edge（`--remote-debugging-port=0`，端口随机），通过 CDP 的 `Network.getAllCookies` 读 cookie，读完 `taskkill /T /F` 关掉整棵进程树。用的是独立 profile（`~/.dsh/ytdlp-vision/browser-profile`），不会碰你日常浏览器的数据；代价是首次要登录一次，之后 profile 里记着登录态，再抓就是点一下的事。

查找浏览器的顺序：`YTDLP_VISION_BROWSER` 环境变量 → Windows 上的 Chrome / Edge / Brave → Linux/macOS 常见路径。找不到浏览器时页面上会直接说，自动抓取按钮变灰，手动填仍然可用。

### 三种方式并存

| 方式 | 适合 | 数据去向 |
|---|---|---|
| 自动抓取 | 绝大多数情况 | 全部 cookie 写进 `cookies.json` + `cookies.txt` |
| 手动填写 | 不想开浏览器、只有一两串 cookie | 同上，只写你填的字段 |
| 浏览器直读 | 不想把 cookie 落盘 | 不保存，yt-dlp 现场用 `--cookies-from-browser` |

手动填写：把 `SESSDATA=xxx; bili_jct=yyy` 或整行 Netscape 粘贴进来，自动拆字段。

### 预置站点

B 站、YouTube、X/Twitter、抖音、TikTok、Twitch、Instagram、Facebook、Vimeo、AcFun、小红书、微博、Reddit、niconico、Dailymotion。

预设只影响三件事：快捷按钮的登录页、自动判定的关键 cookie、默认域名范围。**填了不认识的网址也能用**——插件会从 hostname 推一个自定义站点出来（带公共后缀处理，`video.example.co.uk` → `example.co.uk`）。

### 存储与权限

- 配置：`~/.dsh/ytdlp-vision/cookies.json`（权限 0600）
- 生成物：同目录 `cookies.txt`（0600，含 `# Netscape HTTP Cookie File` 头，过期时间写死远期）
- 浏览器 profile：`~/.dsh/ytdlp-vision/browser-profile/`（首次抓取时创建）
- 页面只返回**脱敏视图**（`abcd…wxyz`），明文值永远不离开本地进程
- HTTP 面：只认 loopback 源地址；所有 API 要求自定义头 `x-ytdlp-vision`（跨站页面带不上它，也不实现预检）
- 优先级：面板配置 > `BILI_SESSDATA` 环境变量 > 无

**B 站走官方 API，其余走 yt-dlp**：面板里 B 站的 cookie 直接拼成请求头给 `api.bilibili.com`；其他站点写进 `cookies.txt` 交给 yt-dlp。选了「浏览器直读」时 yt-dlp 优先用 `--cookies-from-browser`，B 站仍然用面板里的值。

> cookie 等同于账号登录凭证。不要把 `cookies.json` / `cookies.txt` / `browser-profile` 提交到仓库、发到聊天里或截图外传。页面上的值都是脱敏的，但文件本身是明文。

---

## yt-dlp 自动更新

插件包里自带一份 yt-dlp（`vendor/yt-dlp-py.zip`，当前 2026.10.26）。每次 DSH 启动 0.8 秒后，后台静默跑一次 `update.py`：

1. 读 `https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest`
2. tag 与本地一致 → 直接退出
3. 有新版 → 断点续传下载 → 用 `SHA2-256SUMS` 校验 → 原子替换到 `~/.dsh/ytdlp-vision/yt-dlp-py.zip`
4. 任何失败（网络、校验、权限）只写日志，不打扰启动、不影响插件可用

运行时查找顺序：`~/.dsh/ytdlp-vision/yt-dlp-py.zip`（更新过的）→ 包内 `vendor/yt-dlp-py.zip` → PATH 里的 `yt-dlp`。

| 配置 | 说明 |
|---|---|
| `updateOnBoot: false` | 关掉启动自更新 |
| `updateIntervalHours: 24` | 最短检查间隔，默认 0（每次启动都查） |
| `YTDLP_VISION_PROXY` | 下载走的代理；不设则读 `HTTPS_PROXY` / `ALL_PROXY` |
| `YTDLP_VISION_HOME` | 更新产物与状态目录，默认 `~/.dsh/ytdlp-vision` |

手动触发：

```powershell
python update.py --force          # 强制查一次
python scripts/fetch-ytdlp.py     # 直接把最新版拉进 vendor/
```

日志：`~/.dsh/ytdlp-vision/update.log`（保留最近 200 行），状态：同目录 `state.json`。

---

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `YTDLP_VISION_CACHE` | `~/.dsh/ytdlp-vision-cache` | 缓存根目录 |
| `YTDLP_VISION_HOME` | `~/.dsh/ytdlp-vision` | cookie 配置、`cookies.txt`、yt-dlp 更新产物的目录 |
| `YTDLP_VISION_PROXY` | 空 | 自更新下载用的代理；空则读 `HTTPS_PROXY` / `ALL_PROXY` |
| `YTDLP_VISION_BROWSER` | 自动探测 | 自动抓 cookie 用的浏览器可执行文件路径（Chrome / Edge / Brave） |
| `YTDLP_VISION_PYTHON` | 自动探测 | 指定解释器 |
| `YTDLP_VISION_ASR_MODEL` | `small` | faster-whisper 模型（`base` 约 14× 实时，`small` 约 3×） |
| `YTDLP_VISION_ASR_DEVICE` | `cpu` | 有 N 卡可设 `cuda` |
| `YTDLP_VISION_ASR_COMPUTE` | `int8` | 计算精度 |
| `YTDLP_VISION_MAX_PARALLEL` | `2` | 同时分析的任务数上限（1–16） |
| `YTDLP_VISION_MAX_ASR_SECONDS` | `14400` | 超过这个时长的音轨跳过 ASR，改用字幕/画面 |
| `YTDLP_VISION_MAX_DURATION_SECONDS` | `21600` | 超过只提示「建议分段」，不阻断 |
| `YTDLP_VISION_MAX_MEDIA_GB` | `8` | 单个媒体文件下载上限 |
| `YTDLP_VISION_MIN_FREE_GB` | `1` | 磁盘余量低于这个值就拒绝下载 |
| `YTDLP_VISION_CACHE_MAX_GB` | `5` | `cache-clean` 的容量上限 |
| `YTDLP_VISION_CACHE_TTL_DAYS` | `30` | `cache-clean` 的过期天数 |
| `YTDLP_VISION_FFMPEG_TIMEOUT` | `900` | 单个视频流式解码（`frame_scores`）的看门狗秒数；超时杀 ffmpeg 并报错，避免永久挂住 |
| `BILI_VISION_SESSDATA` | 空 | B 站登录态，1080P 与 CC 字幕需要 |
| `BILI_VISION_FFMPEG` / `..._FFPROBE` | PATH | 显式指定 ffmpeg 路径 |

旧的 `BILI_VISION_*` 变量仍被读取（新名前缀 `YTDLP_VISION_*` 优先），方便从 bili-vision 平滑迁移。

---

## 缓存

路径 `<cache>/v3/<平台_id>/p<页>/<分P或源标识>/`：

- `meta.json` — 元信息（B 站 24 小时有效；yt-dlp 源每次重取）
- `subtitle.json` / `asr_<sig>.json` — 字幕或转写（`<sig>` 含音频文件大小与 mtime，换音轨不会串）
- `video_<height>.mp4` — 抽帧用视频
- `frames_<digest>.json`、`grid_*.jpg` — 选帧与合成图
- `units.json` — 最终证据单元

查看与清理：

```powershell
python vision.py cache-stats                          # 总量、各版本、占用最大的条目
python vision.py cache-clean --dry-run                # 只报告，不删
python vision.py cache-clean --max-cache-gb 3 --ttl-days 14
python vision.py cache-clean --keep-newest 2          # 最常用/最新的 2 条不参与容量清理
python vision.py clean <平台_id>                      # 清掉某个视频的全部缓存
```

清理前会抢 `video_lock` 的同一把锁，正在分析中的条目会跳过并报「正在使用」，不会误删。`cache-clean` 也会顺手删掉旧 `CACHE_VERSION` 目录（v1/v2 → v3 迁移）。

---

## 已知限制

- 登录墙内容（B 站充电视频、YouTube 会员）需要 cookie：用「视频 Cookie」页面填，或设 `BILI_VISION_SESSDATA`。
- **Vimeo 现在要求登录才能解析**（yt-dlp 报 `The web client only works when logged-in`）。这是站点策略，不是插件问题；在 Cookie 面板给 vimeo.com 配 cookie 后可解。
- yt-dlp 从 B 站抓会 412，所以 B 站永远走官方 API；这意味着 B 站之外的国内站点（如部分短视频平台）能否用取决于 yt-dlp 当日支持情况。
- 平台可用性会变：站点改版、加验证、封 IP 都可能让某个站临时不可用。插件只做「拿到什么就如实报什么」，不会假装成功。
- `run` 模式要额外配独立视觉 API，不配就只用当前模型。
- ASR 在 CPU 上慢（`small` 约 3× 实时），长视频建议先看有没有字幕。

---

## 开发

```powershell
node smoke.mjs              # 离线冒烟：schema、参数校验、错误传播
node tests/plugin.test.mjs  # 单文件跑单测（沙箱下 node --test 会 spawn EPERM）
node tests/store.test.mjs   # cookie 存储层
python -m unittest discover -s tests -p "test_*.py" -v
python -B scripts/check-release.py   # 版本/CHANGELOG/vendor 资产一致性
```

静态检查（只查真会出错的问题，不查风格；规则见 `.ruff.toml` 与 `eslint.config.mjs`）：

```powershell
ruff check .        # Python：pyflakes + bugbear + 语法级错误
eslint .            # Node：未定义/未使用变量、可疑写法
```

两个工具都没随仓库分发，按需装（`pipx install ruff`、`npm i -g eslint`），或用 `npx --yes eslint@10 .`。

CI（`.github/workflows/ci.yml`）在 Windows + Linux 双平台跑上面这些，外加 `lint` job、`pip-audit` 依赖审计和 `npm pack` 内容核对；`.github/dependabot.yml` 每周检查依赖版本。全部测试离线，不需要真实 Cookie 或网络。

---

## 致谢与许可

- 本插件由 [bili-vision](https://github.com/icyaaaww/dsh-bili-vision)（MIT, © icyaaaww）改造扩展而来，B 站抓取与抽帧管线沿用其实现。
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)（Unlicense）提供多平台抓取。
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（MIT）、[RapidOCR](https://github.com/RapidAI/RapidOCR)（Apache-2.0）。

MIT License，见 `LICENSE`。
