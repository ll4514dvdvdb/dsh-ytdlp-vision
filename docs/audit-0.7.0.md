# dsh-ytdlp-vision 0.7.0 安全与可靠性审查报告

审查对象：`ytdlp-vision` 0.6.0（33 文件 / 3.2MB）
审查时间：2026-11-06
结论：**第一阶段（安全）全部高风险项已修；第二、三阶段按要求落地；第四阶段 CI 与发布检查已就位。功能未删减，配置格式未变（`cookies.json` 仍 v2）。**

测试基线（改动前）：Python 26 项 + Node 4 项，全部离线，不依赖真实 Cookie、网络或 ASR 模型。
本机结果：`python -m unittest discover` → **Ran 78 tests OK**；`check-release.py` → 通过；`ruff check .` / `eslint .` → 无告警。

---

## 一、问题清单与处理

严重度定义：**高**=可导致任意代码执行/凭据泄露/版本破坏；**中**=可导致功能失效、数据损坏或信息泄露；**低**=影响有限或需要本机攻击者。

### 第一阶段：安全性

| # | 文件:位置 | 严重度 | 问题 | 修复 | 影响面 |
|---|---|---|---|---|---|
| 1 | `update.py` 原 173-188 | 高 | 取不到 `SHA2-256SUMS` 时 `expected` 为空，直接接受下载文件——等于没有校验 | `fetch_expected()` 拿不到就抛错，`run_update()` 直接放弃更新并记 `last_error`，不碰目标文件 | 自动更新失败时不再「静默装未知文件」；网络差时更新会跳过，旧版照常工作 |
| 2 | `update.py` 原 124 → 现 `download_asset()`:242 | 高 | 先把新文件 `os.replace` 到 `TARGET`，再校验；校验失败 `unlink(TARGET)`，**旧版本被删且无回滚** | 只写 `<目标>.part`，哈希+GPG 都通过后才 `os.replace(staged, TARGET)`；任何一步失败删 staged、保留旧版 | 更新失败后旧版继续可用；Windows 文件被占用时提示「保留旧版，下次再试」 |
| 3 | `update.py` 现 `check_url()`:131 / `open_url()`:145 | 中 | 无重定向白名单，未强制 https，可能被降级到 http 或跳到任意域 | 手写逐跳跟随（`allow_redirects=False`，最多 8 跳），每跳校验 scheme=https、端口 443、无凭据、主机在 `RELEASE_HOSTS`/`API_HOSTS` | 正常 GitHub 302 到 `objects.githubusercontent.com` 仍可用；异常跳转被拒 |
| 4 | `update.py` 现 `read_limited()`:165 | 中 | API / SUMS / 资产无响应体上限 | `MAX_JSON_BYTES`/`MAX_SUMS_BYTES`=1MB、`MAX_ASSET_BYTES`=512MB，超限即中止 | 无功能变化，仅防异常大响应 |
| 5 | `update.py` 原 100-101 | 中 | 416 分支 `total` 未定义、跳过完整性检查，残留 `.part` 比远端大时被直接采用 | 用 `Content-Range: bytes */N` 证明总长一致才继续，否则重下 | 断点续传仍有效，错误残留文件不再被当作完整文件 |
| 6 | `update.py` 原 31 / 173 | 低 | tag 来自 API 未校验就拼进 URL | `TAG_RE = ^\d{4}\.\d{2}\.\d{2}(?:\.\d{1,6})?$`，不符即放弃 | 无 |
| 7 | `update.py` 原 58 / `write_state()`:82 | 低 | state 用固定 `.tmp` 名，多实例并发互踩 | 改 `mkstemp` + `os.replace` | 无 |
| 8 | `update.py` 现 `verify_signature()`:196 + `vendor/yt-dlp-public.key` | — | 任务书问「能否验证 yt-dlp 官方签名」 | **能，已实测**：官方 release 提供 `SHA2-256SUMS.sig`。包内钉死公钥（sha256 `45d6b415…`），有 `gpg` 时验签，验签失败拒绝替换；无 `gpg` 记 `skipped` 不阻断 | 装了 gpg 的机器多一层来源认证；没装的行为不变 |
| 9 | `cookies.py` 原 157 / 现 `_restrict()` | 中 | Windows 上 `os.chmod(0o600)` 是空操作，`cookies.json` 继承目录权限（同机其他用户/进程可读） | POSIX `chmod`；Windows `icacls /inheritance:r /grant:r <user>:(F) /grant:r SYSTEM:(F)` | 多用户共享机器上凭据不再对人可读；单用户机器无感知 |
| 10 | `cookies.py` `bili_cookie()` / `_netscape_body()` | 中 | 拼 `Cookie:` 头 / Netscape 行时未过滤 `\r\n\t`，可被注入额外头或额外 cookie 行 | 统一走 `_clean()`（去 `\x00-\x1f\x7f`），空 name/value 跳过 | 正常 cookie 值不受影响；实测 `"abc\r\nX-Evil: 1"` → `SESSDATA=abcX-Evil: 1` |
| 11 | `cookies.py` `ytdlp_auth_args()` | 低 | `--cookies-from-browser` 的值直接来自配置，可传怪字符串给 yt-dlp | `_BROWSER_SPEC` 白名单 + `BROWSER_NAMES` 集合；不合法降级到 `--cookies <cookies.txt>` 并告警 | 非法配置不再静默失效，改用已保存的 cookie 文件 |
| 12 | `cookies.py` `_read_raw()` | 低 | JSON 损坏时静默返回 `{}`，下一次写入会覆盖掉原文件 | `ValueError` → 备份为 `cookies.corrupt-<epoch>.json` 再按空配置；`OSError` 只告警不动文件 | 损坏时用户还能找回原文件 |
| 13 | `cookies.py` / `panel/routes.js`:202 / `web/app.js` | 中 | 任务书要求的「导入/导出/删除」里**导出缺失** | 新增 `export_netscape()` + `POST export` + 页面「导出 Netscape 文件」按钮（提示明文凭据、用完删除） | 新增能力，不影响原有导入/删除 |
| 14 | `panel/store.js` 原 194 | 中 | Netscape 第 4 列 `item.secure === true ? "TRUE" : "TRUE"` 恒真——非 secure cookie 被标 secure，纯 http 站点收不到 | 改为跟随 `item.secure` | 纯 http 站点 cookie 恢复可用；secure 站点不受影响 |
| 15 | `panel/store.js` 原 28-43 | 中 | 粘贴导入不剔除 `\t\r\n`，可注入额外 Netscape 行 | `clean()` 过滤控制字符 | 无（正常粘贴不变） |
| 16 | `panel/store.js` 原 146-153 | 中 | 站点 id 正则允许 `__proto__`，`sites[id] = {...}` 污染 `Object.prototype` | `RESERVED_IDS` 拒绝 `__proto__`/`constructor`/`prototype`；`defaultConfig().sites` 改 `Object.create(null)`；`load()` 跳过保留 id | 无 |
| 17 | `panel/store.js` 原 83-126 | 中 | 内存缓存 + 无条件覆盖：Python 侧或另一个 DSH 实例改过 `cookies.json` 会被旧值盖回 | `#reloadIfChanged()` 按 mtime 重载，所有读写入口先调用；临时文件用 `pid+随机` 命名 | 多入口并发编辑不再丢数据 |
| 18 | `panel/store.js` 原 110-113 | 低 | 损坏 JSON 静默用空配置，随后写入覆盖 | 备份成 `cookies.json.corrupt-<ts>` 再继续 | 同 #12 |
| 19 | `sources.py` 原 539/559 | 中-高 | `--no-part` 让下载中断留下残缺文件，`_download_glob()` 只要 >1024 字节就当有效媒体，后续 ffmpeg 处理坏文件 | 去掉两处 `--no-part`（恢复 `.part` 完成才改名）；加 `--max-filesize 4G` | 中断后不再产生「看似有效」的坏缓存 |
| 20 | `sources.py` 原 494-516 → 现 `_public_http_url()`:61 / `_get_limited()` | 中 | 字幕 URL 来自站点元数据，直连任意地址 → SSRF（可探内网/云元数据） | 只允许公网 http(s)：拒绝 loopback/私网/链路本地/保留/组播，拒 `localhost`/`*.local`；逐跳校验重定向；体积上限 8MB | 单条字幕不安全时跳过并转写，不整段失败 |
| 21 | `sources.py` `ytdlp_json()` / `list_playlist()` | 中 | `-J` 全量读 stdout，无上限 | `run(..., max_stdout=32MB)` | 超限报「命令输出超过 32MB 上限」，不再 OOM |
| 22 | `panel/grabber.js` `startGrab` | 中 | `browser-profile`（含浏览器 Cookie 库）未收紧权限 | 建目录后 `restrict(profileDir)`（同 #9） | 无 |
| 23 | `panel/grabber.js` 原 203 | 低 | 直接连 `webSocketDebuggerUrl`，未校验 host（本机伪造 `DevToolsActivePort` 可劫持） | 正则限 `ws://127.0.0.1\|[::1]\|localhost:\d+/`，不符拒绝连接 | 正常浏览器仍连得上 |
| 24 | `cordis.patch.yml`:6 | 中（可移植性） | 硬编码 `C:\Users\ASUS\.dsh\...python.exe`，别人装直接不可用 | 删除硬编码，留空=自动探测（`findPython()` 候选链已含 `~/.dsh/bili-vision-venv`）；本机实测仍能找到同一解释器 | 本机行为不变；分发出去能跑 |
| 24b | `panel/store.js` 原 284-287 `writeNetscape()` / `removeSite()`:234 | 中 | 注释写「没有启用站点时删除旧文件」，代码只 `return` 没删；`removeSite()` 也不重生成 → 删光/删掉站点后旧 `cookies.txt` 仍留全部凭据，yt-dlp 继续带已删站点的 cookie 发请求（正是任务书「清除 Cookie 时同步清理旧格式文件」） | 无可用行时 `unlink` 旧文件；`removeSite()` 删完自动重生成（失败只记日志，不回滚删除） | 删除后凭据立即失效；未删除站点不受影响；`store.test.mjs` 两项覆盖 |

### 第二阶段：缓存与资源

| # | 文件:位置 | 严重度 | 问题 | 修复 | 影响面 |
|---|---|---|---|---|---|
| 25 | `vision.py` 原 `_decode_audio()` → `vision.py:690` 区 | 中-高 | 整段音频 `np.concatenate`，1 小时 16k float32 峰值约 460MB | 改 `bytearray` 累积后 `np.frombuffer`（零拷贝）；转写失败自动降级到字幕/画面 | 长视频内存占用显著下降；转写结果不变 |
| 26 | `vision.py` `asr_signature()`:690 | 中 | ASR 缓存键只有模型配置，**不含音频内容**——同一 work 目录换音轨会命中旧转写 | 键加入音频 `size:mtime_ns`；先取音频再算键（`download_audio` 本身幂等，不增加请求） | 换音轨/重下后重新转写；同音频重复分析仍命中 |
| 27 | `vision.py` `download_media()` | 中-高 | 无大小上限、无磁盘余量检查 | `MAX_MEDIA_BYTES`（默认 8GB）+ `ensure_space()`（默认留 1GB）；超限/不足抛 `DiskFullError` 并中止，不吞成「音轨不可用」 | 超大视频不再把盘写满 |
| 28 | `vision.py` `prepare()` | 中 | 超长/超大分辨率无提示 | 超 `MAX_DURATION_SECONDS`（6h）/`MAX_PIXELS`（33MP）追加 `ctx.warnings`，**只提示不阻断**（任务书禁止随意降精度） | 用户能看到「为什么慢」，行为不变 |
| 29 | `vision.py` 末尾 `main()` | 中 | 只兜 `ValueError`/`RuntimeError`，`OSError`/`KeyError` 直接甩堆栈 | 加 `OSError` 分支（磁盘满/无权限/其他，中文说明怎么处理）与 `KeyboardInterrupt`（exit 130） | 失败时能一眼看出卡在哪一步 |
| 30 | `vision.py` `cache_stats()`:862 / `cache_clean()`:959 | 中 | 只有 `clean`（清空全版本），无统计、无容量上限、无 TTL、无 v1/v2 迁移 | 新增 `cache-stats`、`cache-clean --max-cache-gb/--ttl-days/--keep-newest/--dry-run`；清理旧 `CACHE_VERSION` 目录、过期条目、超量条目 | 新增命令；`clean` 语义不变 |
| 31 | `vision.py` `_acquire_entry_locks()`:935 | 中 | 清理时不检查在用条目，可能删掉正在跑的任务 | 删除前抢与 `video_lock` **同一把**锁（`CACHE/<key>_p<page>.lock`），拿到才删；拿不到报「正在使用（锁被占用）」并跳过 | 并发分析不会被清理打断 |
| 32 | `index.js` `acquireSlot`/`releaseSlot`:61-62 | 中 | 无并发上限，多请求同时抽帧/转写会打满 CPU/内存 | `YTDLP_VISION_MAX_PARALLEL`（默认 2，1–16），排队 + abort 出队 + 名额直接转交 | 超并发时排队而非失败；单任务行为不变 |
| 33 | `vision.py` `frame_scores()`:481 | 中 | 任务书要求「对 ffmpeg 设置合理超时」。`run()` 统一带 `timeout`（默认 1800s，下载另有 3600s）确实已满足；但 `frame_scores()` 用的是 `subprocess.Popen` + `stdout.read()` 流式读，**没有任何超时**——ffmpeg 卡死（损坏文件、管道半关）时整个插件永久阻塞 | 加看门狗线程：超 `YTDLP_VISION_FFMPEG_TIMEOUT`（默认 900s）杀进程并报「解码超时 + 如何调参」，`finally` 里 `done.set()` 保证线程退出 | 正常视频行为不变；仅卡死场景由「永不返回」变「明确报错」；`test_stuck_decoder_is_killed_instead_of_hanging_forever` 覆盖 |
| 33b | 临时文件清理 | 低 | 任务书要求的「临时文件清理」 | **原实现已满足**：`download_media` 的 `.part` 在 `finally` 删除；`extract_frames` 按 digest 命名复用；`tempfile.TemporaryFile()` 用完即销毁。未改动 | 无 |

### 第三阶段：可靠性与证据

| # | 位置 | 严重度 | 问题 | 处理 |
|---|---|---|---|---|
| 34 | `vision.py` `_api()`/`fetch_meta()` | 中 | 失败只抛原始异常或裸错误码，用户分不清是网络、登录还是视频没了 | `_api` 包成「B 站接口 <path> 请求失败（类型，HTTP 码）：检查网络或代理」；非 JSON 报「可能被风控页拦截」；新增 `BILI_HINTS`（-101 登录失效→重抓 Cookie、-403 无权限、-404 已删除、-400 参数错、-412 代理风控、-352 风控、-509 频繁） | 
| 35 | 多平台实测 | — | 任务书要求区分「站点限制/yt-dlp 能力/插件缺陷」 | 见下节实测表 |
| 36 | 证据完整性 | — | 时间戳、全片覆盖、字幕时间轴、OCR 匹配、ASR 降级、缓存串号 | 见下节实测 + 新增测试 |

---

## 二、多平台实测（2026-11-06，本机 Windows 11）

用包内 `vendor/yt-dlp-py.zip`（2026.10.26）只取元数据（`-J --skip-download`），再走插件自己的 `sources.normalize()`。

| 平台 | 结果 | 归因 |
|---|---|---|
| Bilibili `BV1GJ411x7h7` | ✅ 212.393s / 1920×1080 / 15 formats | 走官方 API（不经 yt-dlp），正常 |
| YouTube `aqz-KE-bpKQ` | ✅ 635s / 3840×2160 / 53 formats | yt-dlp 正常（需代理） |
| TikTok `@scout2015/6718335390845095173` | ✅ 10s / 720×1280 / 11 formats | yt-dlp 正常（需代理） |
| Vimeo `76979871` | ❌ `The web client only works when logged-in` | **站点限制**：Vimeo 现在强制登录，与插件无关。Cookie 面板配 vimeo.com 后可解 |
| Twitter/X | ⚠️ 待验证 | yt-dlp 有 `twitter` extractor，但需要一条真实可访问的公开推文链接；本次未找到可靠样本，不做结论 |
| 本地 `tests/.probe/local.mp4`（3s/320×180） | ✅ `resolve_source` → duration 3.0、320×180；`inspect` → coverage `[0.0, 3.0]`、`selected_frame_times=[0.0, 0.967, 1.933, 2.9]`、`largest_unsampled_gap=0.97`、`text_source=visual` | 全链路正常；无字幕时自动降级为画面证据 |

证据完整性结论：
- **时间戳**：选帧时间来自实际解码时间轴，网格图带真实时间标注（`test_grid_size_and_timestamps` 已覆盖）。
- **全片覆盖**：`select_frames` 先按 elapsed 均匀铺 2/3 名额，再补问题相关帧，最后填最大时间洞；`coverage.largest_unsampled_gap_seconds` 如实报告空洞。
- **字幕时间轴**：`units` 与 `--start/--end` 对齐有单测。
- **OCR 与画面匹配**：OCR 键是帧文件内容 sha256，同一帧复用、不同帧不串。
- **ASR 失败降级**：`transcribe()` 任何异常都返回 `[]` 并记日志，管线继续用字幕/画面；超过 4h 跳过并说明原因（不静默截断）。
- **缓存串号**：ASR 键已带音频指纹（#26），新增 5 个测试覆盖。

---

## 三、明确未修改的项（附理由）

| 项 | 理由 |
|---|---|
| `panel/routes.js` 500 错误回传 `err.message` | 可能带绝对路径，但接口只监听 loopback 且要求 `x-ytdlp-vision` 头、无 CORS 预检；改动会降低排障可见性，收益不抵成本。标**低风险保留** |
| `panel/ws.js` 帧解析无最大长度 | 只有连本机 CDP 端点时才用，恶意端点最多把本插件进程撑爆（自伤），不跨边界 |
| `sources.py` `_flatten_playlist()` 递归无深度限制 | 输入已被 `-J` 的 32MB 上限约束；真实播放列表嵌套很浅，改动属于防御性重构，按任务书「不为体现工作量而重构」跳过 |
| 系统凭据存储（keyring/DPAPI） | 任务书要求「可选、不得破坏跨平台兼容」。当前 `icacls`/`chmod` + 目录隔离已达标；引入 keyring 会增加依赖和 Windows/Linux/macOS 行为差异，留作后续可选增强 |
| `probe_local()` 对超大分辨率/时长直接拒绝 | 任务书明确「不要随意降低视频分析精度」，故只警告不阻断 |

---

## 四、测试结果（本机实测）

```
python -B -m compileall -q vision.py sources.py cookies.py update.py scripts tests   → 0
python -B -m unittest discover -s tests -p "test_*.py"                              → Ran 78 tests, OK
python -B scripts/check-release.py                                                  → 发布检查通过（版本 0.7.0）
ruff check .                                                                        → All checks passed!
eslint .                                                                            → 0 problems
node --check index.js client.js panel/*.js web/app.js                                → 全部 0
node tests/sites.test.mjs                                                           → pass 4 / fail 0
node tests/store.test.mjs                                                           → pass 8 / fail 0
node tests/plugin.test.mjs                                                          → pass 5 / fail 1（见下）
node tests/host.test.mjs                                                            → pass 0 / skip 1（见下）
```

测试分布（Python 78）：`test_pipeline` 27、`test_update` 11、`test_cookies` 8、`test_cache` 8、`test_failures` 24（含 5 个 ASR 键用例 + 5 个 ffprobe/ASR 降级用例）→ 27+11+8+8+24=78。Node 共 19 项，本机跑通 17 项。

**静态检查**：`.ruff.toml` 只选 `F`/`B`/`E9`（pyflakes + bugbear + 语法级错误），`eslint.config.mjs` 手写约 20 条真错误规则；两者都不做风格检查（本仓库是紧凑风格手写代码，风格规则只会产出噪声）。修复了 9 项真问题：5 处未使用导入/变量（`vision.py:362` 的 `import requests`、测试里的 `json`/`tempfile`/`importlib.util`/`time`）、`update.py` 重试分支 `exc` 未用于日志、2 处 `except` 内 `raise` 丢异常链（`vision.py` `video_lock`、`tests/test_pipeline.py`）、3 处 `zip()` 未声明长度关系（2 处构造上等长用 `strict=True`，1 处长度差 1 用 `strict=False`）。

两处**环境限制**，与代码无关，已在 CI 覆盖：
- `tests/plugin.test.mjs` 1 项失败，报 `Error: spawn EPERM`：本机 DSH 沙箱禁止 node 子进程 pipe stdout。已单独验证任何 `node -e spawn(...)` 都返回 `EPERM (-4048)`。GitHub Actions 不受此限制。
- `tests/host.test.mjs` 跳过：需要 `@deepseek-ai/dsh` 的 npm 包路径，本机 DSH 是 Electron 分发包，没有该路径。测试自带 `skip` 守卫。
- `npm pack` 本机同样 EPERM，改由 CI 的 `package-check` job 验证（并额外限制包体积 ≤12MB）。
- 本机 `PATH` 上的 `python` 是 `C:\Python315`（无 requests/numpy/PIL），跑测试要用 `C:\Users\ASUS\.dsh\bili-vision-venv\Scripts\python.exe`，否则会误报 `ModuleNotFoundError`。

---

## 五、待验证（不做结论）

1. **Twitter/X 视频**：需要一条当前可访问的公开推文链接才能验证。yt-dlp extractor 存在，但 X 对未登录抓取限制严格。
2. **GPG 验签实际执行路径**：本机无 `gpg`，代码走的是 `skipped: gpg 不在 PATH`。验签成功/失败两条分支由单测用假 `gpg` 覆盖，真实 `gpg` 行为待有 gpg 的环境确认。
3. **GitHub Actions 实跑**：workflow 语法已用 PyYAML 解析验证（5 个 job，步骤数正确），但未推送运行，首次绿灯待 CI。
4. **macOS**：本次未在 macOS 上验证 `chmod`/`flock` 路径。
5. **eslint 的实际拦截效果**：本次接入时项目本身已经没有未定义/未使用变量，所以 eslint 只验证了「能跑通、不误报」；它能否抓到未来的回归，要等第一次真实改动。

---

## 六、复现方式

```powershell
cd ytdlp-vision
python -B -m unittest discover -s tests -p "test_*.py" -v
python -B scripts/check-release.py
ruff check .
eslint .
node tests/store.test.mjs

# 安全回归（不联网）
python -B -m unittest tests.test_update -v        # 缺 SUMS/哈希不符/重定向越界/tag 非法
python -B -m unittest tests.test_cookies -v       # 控制字符/白名单/ACL/损坏备份
python -B -m unittest tests.test_cache -v         # 容量/TTL/旧版本/在用条目跳过
python -B -m unittest tests.test_failures -v      # 错误码提示/磁盘满/ffmpeg+ffprobe 缺失/ASR 降级
```
