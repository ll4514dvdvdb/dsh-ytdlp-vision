# dsh-ytdlp-vision 0.7.0 变更报告：修了什么

版本：0.6.0 → 0.7.0
日期：2026-11-06
规模：**18 个已有文件改动（+1206 / −209 行），新增 10 个文件**
测试：Python **78 项通过**，Node **17 项通过**（另有 2 项受本机沙箱/依赖限制，见 §13）；`ruff check .` 与 `eslint .` 均无告警。

> 本文是「逐文件改动明细」，回答"修了什么"。
> 配套的 [audit-0.7.0.md](audit-0.7.0.md) 是「问题清单」，回答"发现了什么、为什么这样修、影响哪些功能"。
> 两份文档引用同一批行号，可对照阅读。

---

## 1. `update.py` —— yt-dlp 自更新（改动最大，368 行变更）

改造前：校验失败会把已装好的二进制删掉；取不到校验和就直接装；重定向不设防。

| 位置 | 改了什么 | 验证 |
|---|---|---|
| `update.py:38` | 新增 `STAGED = HOME / "yt-dlp-py.zip.new"`。下载只写暂存路径，**任何情况下不直接写 `TARGET`** | `test_hash_mismatch_keeps_old_binary_and_cleans_staging` |
| `update.py:39` | 新增 `PUBKEY = ROOT/"vendor"/"yt-dlp-public.key"` | `scripts/check-release.py` 第 5 项（公钥哈希与 `PUBKEY_SHA256` 一致） |
| `update.py:52-53` | 新增 `TAG_RE`（`^\d{4}\.\d{2}\.\d{2}(?:\.\d{1,6})?$`）与 `SHA_RE`（`^[0-9a-f]{64}$`），tag 与摘要都先验格式 | `test_bad_tag_rejected_before_download` |
| `update.py:54-58` | 新增上限：`MAX_REDIRECTS=8`、`MAX_JSON_BYTES=1MB`、`MAX_SUMS_BYTES=1MB`、`MAX_ASSET_BYTES=512MB`、`MAX_LOG_LINES=200` | — |
| `update.py:124` `host_allowed()` | 主机白名单判定：`host == item` 或 `host.endswith("."+item)`，防 `github.com.evil.com` 这类后缀伪装 | `test_foreign_host_rejected` |
| `update.py:131` `check_url()` | 只放行 **https + 443 端口 + 无 userinfo**，否则 `ValueError` | `test_non_https_url_rejected` |
| `update.py:145` `open_url()` | `allow_redirects=False` 手动逐跳跟随，**每一跳都过 `check_url`**，超过 8 跳中止 | `test_redirect_to_untrusted_host_rejected`、`test_redirect_chain_inside_allowlist_is_followed` |
| `update.py:165` `read_limited()` | 响应体超限抛错，不再无限读 | — |
| `update.py:180` `fetch_expected()` | 返回 `(digest, sums_bytes)`；**拿不到 SUMS 或找不到 `yt-dlp` 条目就抛错**（原实现此时 `expected=None` 直接放行） | `test_missing_sums_aborts_and_keeps_old_binary`、`test_sums_without_asset_entry_aborts` |
| `update.py:196` `verify_signature()` | 新增 GPG 可选验签：钉死公钥哈希 `45d6b415…`（与包内 `vendor/yt-dlp-public.key` 比对），有 `gpg` 时用临时 `GNUPGHOME` + `--no-default-keyring` 导入并 `--verify`，返回 `ok` / `failed: …` / `skipped: …` | 无独立单测：本机无 gpg，只走 `skipped` 分支；`failed` 分支靠代码审阅 + 调用处断言（`sig.startswith("failed")` → 删暂存并 `raise`） |
| `update.py:242` `download_asset()` | 写 `<dest>.part`；416 分支用 `Content-Range: bytes */N` 证明总长一致才接受，否则重下；`cap = min(MAX_ASSET_BYTES, total)` | `test_truncated_download_never_replaces_target` |
| `update.py:302` `verify_existing()` | 用 state 里的 sha256 校验当前 `TARGET`，不符就清 tag/sha 强制重下（防本机二进制被替换后仍被信任） | `test_tampered_local_binary_is_replaced` |
| `update.py:314` `run_update()` | 顺序固定：tag 校验 → SUMS（失败即返回，不碰二进制）→ 测试/哈希校验 → 验签（`failed` 则删暂存并抛错）→ `os.replace(staged, TARGET)`。`os.replace` 失败（Windows 占用）时提示「保留旧版，下次再试」 | 全部 11 项 |
| `update.py:82` `write_state()` | 固定 `.tmp` 名改 `mkstemp` + `os.replace`，多实例不再互踩 | — |
| — | 删除死代码 `local_version()` | — |

**行为变化（对用户可见）**：网络差取不到 SUMS 时，更新会跳过并写 `last_error`，而不是装一个未校验的文件。这是有意的取舍。

---

## 2. `scripts/fetch-ytdlp.py` —— 维护期拉取 yt-dlp

同样的「先覆盖再校验」缺陷，同样修法：

- `download_with_resume(url, dest, proxies)` → `download_to_part(url, part, proxies, retries=8)`：只写 `.part`，失败 `unlink`，**没有引入 `os.replace`**。
- 新增 `fetch_sums(tag, proxies)`：拿不到 `SystemExit`。
- `main()`：`--tag` 分支也走 `fetch_sums`（原来这里 `sums=""`，等于没校验）；`expected` 为空或与实测 sha 不等都删 part 并退出；只在全部通过后 `os.replace(part, dest)`（`fetch-ytdlp.py:162`）再写 `VERSION.json`（`fetch-ytdlp.py:164`）。

---

## 3. `cookies.py` —— Cookie 读写（186 → 约 310 行）

| 位置 | 改了什么 | 验证 |
|---|---|---|
| `cookies.py:40` | `BROWSER_NAMES` 白名单（brave/chrome/chromium/edge/firefox/opera/opera_gx/safari/vivaldi/whale） | — |
| `cookies.py:42` | `_BROWSER_SPEC`：`^[a-z_]+(?::[^:\r\n\t]{1,80})?$`，`--cookies-from-browser` 的值必须匹配 | `test_bad_browser_name_falls_back` |
| `cookies.py:43,55` | `_CONTROL` + `_clean()`：剔除 `\x00-\x1f\x7f`。**所有**写 Cookie 头/Netscape 行的地方都过它 | `test_control_characters_are_stripped`、`test_netscape_rows_stay_seven_columns` |
| `cookies.py:60` `_restrict()` | POSIX `chmod 0o600`；**Windows 用 `icacls /inheritance:r /grant:r <user>:(F) /grant:r SYSTEM:(F)`**（原 `os.chmod` 在 Windows 是空操作） | `test_restrict_drops_inherited_aces`（Windows-only，断言输出不含 `Everyone`/`BUILTIN\Users`） |
| `cookies.py:237-245` 之上 `_browser_spec()` | 同上（被 `ytdlp_auth_args` 与 `store.js` 的 `patchBrowser` 共用同一形状） | — |
| `cookies.py:88` `_read_raw()` | 区分三种失败：`FileNotFoundError`→空配置；`ValueError`→备份成 `cookies.corrupt-<epoch>.json` 再空配置；`OSError`→**只告警不动文件**（防止把被占用的正常文件当损坏移走） | `test_corrupt_config_is_backed_up` |
| `cookies.py:161` `bili_cookie()` | name/value 都过 `_clean()`，空值跳过。实测 `"abc\r\nX-Evil: 1"` → `SESSDATA=abcX-Evil: 1` | 同上 |
| `cookies.py:200` `export_netscape()` | **新增**导出 API（任务书要求的「导入/导出/删除」里唯一缺的一环） | 由 `store.test.mjs` 覆盖 |
| `cookies.py:205` `netscape_path()` | 写临时文件后 `_restrict(tmp)`，`os.replace` 后再 `_restrict(target)` | — |
| `cookies.py:237-245` `ytdlp_auth_args()` | 浏览器名不合法就告警并降级到 `--cookies <cookies.txt>`，不再把怪字符串塞给 yt-dlp | `test_illegal_browser_name_falls_back`、`test_legal_browser_name_is_whitelisted`、`test_browser_profile_suffix_allowed` |

---

## 4. `panel/store.js` —— 面板数据层（274 → 约 330 行）

| 位置 | 改了什么 | 验证 |
|---|---|---|
| `store.js:18` | `CONTROL` 正则 + `clean()`（`:37`），`normalizeCookies()` 用它过滤 | `store.test.mjs`「导入时剔除控制字符，不产生额外行」 |
| `store.js:20` | `RESERVED_IDS = {__proto__, constructor, prototype}`；`patchSite` 拒绝；`defaultConfig().sites` 改 `Object.create(null)`；`load()` 跳过保留 id | 「__proto__ 之类的站点 id 被拒绝」（断言 `{}.polluted === undefined`） |
| `store.js:81` `restrict()` | 同 cookies.py 的 ACL 逻辑；目录 `0o700` / 文件 `0o600`（目录用 600 会缺 x 位进不去） | — |
| `store.js:103` `uniqueSuffix()` | `${pid}-${6位随机hex}`，替换固定 `.tmp` 名 | — |
| `store.js:127` `#reloadIfChanged()` | 按 mtime 判断是否重读；`patchSite/removeSite/patchBrowser/patchExtra/writeNetscape/exportNetscape/state` 入口全部先调它 → 外部（Python 或另一 DSH 实例）改写不再被内存旧值覆盖 | 「外部改写后不会被内存里的旧值覆盖」 |
| `store.js:188` `#persist()` | 临时名唯一 + 写前写后各 `restrict` 一次 + 写后更新 `#mtime` | — |
| `store.js:300` `exportNetscape()` | 新增，返回 `{text, rows}`，只在用户点导出时调用 | 「state 只返回脱敏值」 |
| `writeNetscape()` 第 4 列 | **原代码 `item.secure === true ? "TRUE" : "TRUE"` 恒真**，非 secure cookie 被标 secure，纯 http 站点收不到 → 改为跟随 `item.secure` | 「netscape 的 secure 列跟随 cookie，而不是恒 TRUE」 |
| `load()` | JSON 损坏备份成 `cookies.json.corrupt-<ts>` 再用空配置（原来静默覆盖） | 「损坏的 cookies.json 会被备份，而不是静默覆盖」 |
| `writeNetscape()` / `removeSite()` | **注释写着「没有启用站点时删除旧文件」，代码其实直接 `return` 没删** → 站点删光后旧的 `cookies.txt` 还留着全部凭据，yt-dlp 继续带着已删站点的 cookie 发请求。现在无可用行时 `unlink` 旧文件；`removeSite()` 删完自动重生成 | 「删光所有站点后 cookies.txt 被删除，不留凭据」「删除一个站点后 cookies.txt 不再包含它的凭据」 |
| `patchBrowser()` | 浏览器名加 `/^[a-z_]{3,20}(?::[^:\r\n\t]{1,80})?$/i` 校验 | — |

---

## 5. Cookie 面板的三个 JS + 前端

| 文件:位置 | 改了什么 |
|---|---|
| `panel/routes.js:202` | 新增 `"POST export"`，返回 `{text, rows, name}`；`rows===0` 时报「没有已启用的 cookie 可导出」 |
| `panel/grabber.js:161` | `restrict(profileDir)`——`browser-profile` 里有浏览器的 Cookie 库，原来只继承默认权限 |
| `panel/grabber.js:209` | DevTools WebSocket 地址加白名单 `^ws://(127.0.0.1\|[::1]\|localhost):\d+/`，不符抛「已拒绝连接（可能是端口被其它程序占用）」 |
| `web/index.html:125` | 新增「导出 Netscape 文件」按钮 + 明文凭据提示 |
| `web/app.js:443-445` | 导出监听：Blob + `a.download` + 5s 后 `revokeObjectURL`，toast 提示「文件含凭据，用完请删除」 |
| `web/app.js:283/296/434` | **修既有 bug**：`api()` 只在传 body 时才发 POST，但 `grab/finish`、`grab/cancel`、`sync` 三个调用都没传 body → 前端一直 404。补 `{}` |

---

## 6. `sources.py` —— yt-dlp 封装（关键安全面）

| 位置 | 改了什么 | 验证 |
|---|---|---|
| `sources.py:59-63` | 新增 `MAX_JSON_BYTES = 32MB`、`MAX_SUBTITLE_BYTES = 8MB`、`MAX_DOWNLOAD_FILESIZE = "4G"` | — |
| `sources.py:66` `_public_http_url()` | 只允许公网 http(s)：scheme 限死、拒 `localhost`/`*.localhost`/`*.local`，`ipaddress` 判定 private/loopback/link_local/reserved/multicast/unspecified 一律拒。实测 `169.254.169.254`、`127.0.0.1`、`10.0.0.5`、`[::1]`、`sub.local`、`file:///C:/x` 全部 False | `test_metadata_cloud_endpoint_is_rejected` |
| `sources.py:85` `run()` | 新增 `max_stdout` 参数，先判 returncode（保留错误尾 1200 字节）再判输出体积，超限抛「命令输出超过 32MB 上限」 | — |
| `sources.py:526` `fetch_subtitle_ytdlp()` | 改用 `_get_limited()`，单条字幕不安全时 **跳过并继续**（交给转写），不整段失败 | `test_non_public_subtitle_host_is_skipped` |
| `sources.py:551` `_get_limited()` | 逐跳 `allow_redirects=False` + 每跳 `_public_http_url` 校验；**先看 `content-length` 声明值**超限直接拒（不再先下载）；流式累计超限抛「字幕体积超过 8MB 上限」；读完后校验 `total != declared` 报「下载不完整」 | `test_oversized_subtitle_is_rejected` |
| `sources.py:606,625` | 两处 `--no-part` **删除**（恢复 yt-dlp 默认 `.part` 完成才改名）+ 新增 `--max-filesize 4G` | 由下载测试覆盖 |
| `sources.py:233,330` | `list_playlist()` / `ytdlp_json()` 的 `run()` 加 `max_stdout=MAX_JSON_BYTES` | — |

---

## 7. `vision.py` —— 主流程（+413 行）

| 位置 | 改了什么 | 验证 |
|---|---|---|
| `vision.py:60-69` | 新增 8 个可配置上限常量：`MAX_DURATION_SECONDS`(6h)、`MAX_PIXELS`(33MP≈8K)、`MAX_ASR_SECONDS`(4h)、`CACHE_MAX_BYTES`(5GB)、`CACHE_TTL_DAYS`(30)、`MIN_FREE_BYTES`(1GB)、`MAX_MEDIA_BYTES`(8GB)、**`FFMPEG_STREAM_TIMEOUT`(15min)** | — |
| `vision.py:481` `frame_scores()` | 流式解码循环原先没有超时：ffmpeg 卡死（损坏文件、管道半关）时 `stdout.read()` 永久阻塞，整个插件挂住。加看门狗线程，超 `FFMPEG_STREAM_TIMEOUT` 杀进程并报「解码超时 + 怎么调参」 | `test_stuck_decoder_is_killed_instead_of_hanging_forever` |
| `vision.py:406` `DiskFullError` | 新增独立异常类——磁盘满要能被上层认出是「磁盘」而不是「音轨不可用」 | `test_disk_full_is_a_distinct_error` |
| `vision.py:410` `ensure_space()` | 下载前检查分区余量，不足抛带中文说明的 `DiskFullError`；`shutil` 报错时放过（拿不到就不拦） | 同上 |
| `vision.py:423` `download_media()` | 加 `ensure_space`；`Content-Length` 或累计写入超 `MAX_MEDIA_BYTES` 即中止 | — |
| `vision.py:393/452` | `download_audio`/`download_video` 的 `except` 链前置 `except DiskFullError: raise`，不再把磁盘满吞成「音轨不可用」 | — |
| `vision.py:607` `_decode_audio()` | `chunks=[] + np.concatenate` → `bytearray` 累积 + `np.frombuffer`（零拷贝）。1 小时音频峰值从约 460MB 降到接近音频本身大小 | 无独立单测；由本地视频全链路实测（`inspect` 正常出帧/出图）间接验证 |
| `vision.py:632` `transcribe()` | 超 `MAX_ASR_SECONDS` 记日志「跳过 ASR，可用 --start/--end 分段」并返回 `[]`（**不静默截断**）；模型调用整体包 try，失败降级到字幕/画面 | 同上（降级路径由 `build_units` 的 subtitle>asr>visual 骨架 + 本地视频无字幕实测覆盖） |
| `vision.py:690` `asr_signature()` | 从 `prepare()` 内联逻辑抽出。键 = 模型配置 + **音频 `size:mtime_ns`**。原来键不含音频内容，换音轨会命中旧转写 | `AsrCacheKeyTests` 5 项 |
| `vision.py:844-1040` | 新增缓存体系：`_dir_size()`、`cache_stats()`（总量/版本/最大 10 项/上限）、`_lock_handle`/`_unlock_handle`/`_acquire_entry_locks`（**抢与 `video_lock` 同一把锁**）、`cache_clean()`（旧版本 → TTL → 超量，`--dry-run` 只报告） | `test_cache.py` 8 项 |
| `vision.py:298` `_api()` | 失败信息改为「B 站接口 <path> 请求失败（类型，HTTP 码）：检查网络或代理」；非 JSON 报「可能被风控页拦截」 | `test_network_error_names_the_stage`、`test_html_instead_of_json_is_reported`、`test_http_status_error_includes_status` |
| `vision.py:326` `BILI_HINTS` | 新增错误码提示表：-101 登录失效→重抓 Cookie、-403 无权限、-404 已删除、-400 参数错、-412 代理风控、-352 风控、-509 频繁 | `test_unknown_video_code_has_hint`、`test_expired_cookie_points_to_panel` |
| `vision.py:1044` `prepare()` | 超时长/超大分辨率追加 `ctx.warnings`（**只提示不阻断**，任务书禁止随意降精度）；调用 `asr_signature(audio)` | — |
| `vision.py:1468` `parser()` | `choices` 加 `cache-stats`/`cache-clean`；新增 `--max-cache-gb`/`--ttl-days`/`--keep-newest`/`--dry-run` | CLI 实测 |
| `vision.py:1538` `main()` | 新增 `OSError` 分支（磁盘满 / 无权限 / 其他，各有中文处置建议）+ `KeyboardInterrupt`（exit 130）。原来只兜 `ValueError`/`RuntimeError` | — |

---

## 8. `index.js` —— 宿主并发控制

- `index.js:62` 新增 `MAX_PARALLEL`（`YTDLP_VISION_MAX_PARALLEL`，默认 2，夹在 1–16）。
- `index.js:66` `acquireSlot(signal)`：未满直接占；满了排队，支持 abort 出队。
- `index.js:81` `releaseSlot()`：**名额直接转交给队首**（`activeJobs` 不变），不浪费一次调度。
- `runPy` 保持**同步抛出**语义（既有测试 `assert.throws(() => runPy(...))` 依赖它），用 `.then()` 包住排队而不是改 `async`。
- `spawn` 用 try/catch 包住，`child.on('error')` 与 `close` 都 `cleanup(); release()`，异常不会泄漏名额。

---

## 9. `cordis.patch.yml` —— 去掉硬编码路径

删掉 `python: 'C:\Users\ASUS\.dsh\bili-vision-venv\Scripts\python.exe'`（别人装直接不可用），改为注释说明「留空 = 自动探测」。本机实测 `findPython()` 仍能找到同一解释器（候选链含 `~/.dsh/bili-vision-venv`，`Test-Path` 为 True）。

---

## 10. 发布配套

| 文件 | 改了什么 |
|---|---|
| `package.json` | version `0.6.0`→`0.7.0`；`files` 增 `vendor/yt-dlp-public.key`（**不加则 npm 打包漏公钥，验签永远 skipped**）；`test` 加 `tests/store.test.mjs`；新增 `test:node`、`lint`（`eslint .`）、`lint:py`（`ruff check .`）、`check:release` |
| `requirements.txt` | `av>=12` → `av>=12,<17`（原缺上界） |
| `README.md:50` | 下载链接 `v0.4.0/ytdlp-vision-0.4.0.zip` → `v0.7.0/...`（**这就是任务书里说的版本不一致**）；环境变量表补 7 个新变量；缓存章节改写；已知限制加 Vimeo 需登录；开发章节补新命令与 lint 说明 |
| `CHANGELOG.md` | 新增 `## 0.7.0 — 2026-11-06`，按六组归类（自动更新 / Cookie / 命令执行与网络 / 资源与缓存 / 可诊断性 / 发布与测试） |
| `scripts/check-release.py` | **新增**。6 项发布前检查：README 版本链接、CHANGELOG 最新条目、`files` 覆盖 17 个必需文件、`VERSION.json` 与 zip 的 sha256 一致、公钥与 `update.py` 的 `PUBKEY_SHA256` 一致、requirements 每行带 `<` 上界。首跑就抓出上面 3 个问题 |
| `.ruff.toml` | **新增**。静态检查配置：`select = ["F", "B", "E9"]`（pyflakes + bugbear + 语法级错误），显式排除 `tests/.tools`、`tests/.tmp-*`、`vendor`。刻意不选 E/W 风格规则，避免噪声淹掉真问题 |
| `eslint.config.mjs` | **新增**。flat config，手写规则（`no-undef` / `no-unused-vars` / `no-dupe-keys` / `no-unreachable` / `no-await-in-loop` 关闭 / `no-unsafe-optional-chaining` 等约 20 条），**不 `import "@eslint/js"`**——这样 eslint 装在 `tests/.tools/node_modules`、项目根还是 npx 临时目录，行为一致 |
| `.github/workflows/ci.yml` | **新增**，5 个 job：`python-tests`（ubuntu+windows × py3.12）、`node-tests`（ubuntu+windows × node20）、`lint`（ruff + eslint）、`dependency-audit`（`pip-audit --no-deps --strict`）、`package-check`（release 检查 + `npm pack` 断言 9 个关键文件 + 体积 ≤12MB） |
| `.github/dependabot.yml` | **新增**。pip / npm / github-actions 每周一并检查依赖版本（yt-dlp 不在内，它走 `update.py` 的自更新） |
| `.gitignore` | 增 `tests/.tools/`、`tests/.pip-tmp/`、`tests/.npm-cache/`、`node_modules/`、`.tools/`，避免本地 lint 工具链与临时目录被提交 |

---

## 11. 新增测试（5 个文件，59 项）

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `tests/test_update.py` | 11 | 缺 SUMS 中止、哈希不符保留旧版、截断不替换目标、非 https 拒绝、外域拒绝、重定向越界拒绝、非法 tag 提前拒、白名单内跳转放行、无更新不碰二进制、本机二进制被篡改后重下 |
| `tests/test_cookies.py` | 8 | 控制字符合并、Netscape 恒 7 列、非法浏览器名降级、`Edge`→`edge`、profile 后缀允许、损坏备份、空配置无凭据、icacls 断继承（Windows-only） |
| `tests/test_cache.py` | 8 | 总量/版本统计、空缓存、旧版本清理、dry-run 不删、TTL 清理、容量上限保留最新、**在用条目跳过**、不安全名字永不删 |
| `tests/test_failures.py` | 24 | 错误码提示、Cookie 失效指向面板、阶段定位、HTML 非 JSON、HTTP 412、磁盘满独立异常、**ffprobe 不存在**、ffprobe 错误传播、损坏 JSON、原子写、云元数据端点拒绝 + ASR 键 5 项 + **ASR 三条降级路径（无 faster-whisper / 模型加载失败 / 转写失败）与超长音频跳过** |
| `tests/store.test.mjs` | 8 | secure 列跟随、控制字符不增行、`__proto__` 被拒、损坏备份、外部改写不丢、`state()` 无明文、**删光站点后 cookies.txt 被删**、**删单站点后文件不再含其凭据** |

另修正 `tests/test_pipeline.py` 的临时目录策略（`tempfile.TemporaryDirectory` 在本机沙箱收尾报 `PermissionError: [WinError 5]`，改 `tests/.tmp-pipeline/` + `shutil.rmtree(ignore_errors=True)`），已加进 `.gitignore` 的 `.tmp-*/`；并新增 `test_stuck_decoder_is_killed_instead_of_hanging_forever`（ffmpeg 卡死时看门狗杀进程并报错，而不是永久挂住）。

---

## 12. 明确**没有**改的

1. `panel/routes.js` 500 回传 `err.message`（可能含绝对路径）—— 只监听 loopback + 要求 `x-ytdlp-vision` 头 + 无 CORS 预检，改了降低排障可见性。
2. `panel/ws.js` 帧解析无长度上限 —— 只连本机 CDP，恶意端点最多撑爆自己进程。
3. `sources.py:_flatten_playlist()` 递归无深度限制 —— 输入已被 32MB 输出上限约束，真实播放列表很浅。
4. 系统凭据存储（keyring/DPAPI）—— 任务书要求可选且不得破坏跨平台；`icacls`+目录隔离已达标。
5. `probe_local()` 超大分辨率不阻断 —— 任务书明确禁止随意降精度，改为只警告。

---

## 13. 测试结果（本机实测，非估算）

```
compileall vision.py sources.py cookies.py update.py scripts tests   exit 0
python -B -m unittest discover -s tests -p "test_*.py"               Ran 78 tests in 2.481s  OK
python -B scripts/check-release.py                                   发布检查通过（版本 0.7.0）  exit 0
ruff check .                                                         All checks passed!  exit 0
eslint .                                                             exit 0（0 problems）
node --check index.js client.js panel/*.js web/app.js                 全部 exit 0
node tests/sites.test.mjs                                            pass 4  fail 0
node tests/store.test.mjs                                            pass 8  fail 0
node tests/plugin.test.mjs                                           pass 5  fail 1（环境限制）
node tests/host.test.mjs                                             skip 1（环境限制）
git diff --stat                                                      18 files, +1206 / −209（本轮 lint/测试补充另计）
```

两处环境限制，**不是代码问题**，已在 CI 覆盖：
- `plugin.test.mjs` 1 项报 `Error: spawn EPERM`：本机 DSH 沙箱禁止 node 子进程 pipe stdout。已单独验证任何 `node -e spawn(...)` 都返回 `EPERM (-4048)`。
- `host.test.mjs` 跳过：需要 `@deepseek-ai/dsh` 的 npm 包路径，本机是 Electron 分发包。测试自带 `skip` 守卫。

Python 测试必须用带依赖的解释器跑（本机 `C:\Python315` 没有 requests/numpy/PIL，直接 `python -m unittest` 会误报）：
`C:\Users\ASUS\.dsh\bili-vision-venv\Scripts\python.exe -B -m unittest discover`。

待验证项（不做结论）：Twitter/X 实际抓取、真实 `gpg` 验签路径（本机无 gpg）、GitHub Actions 首次运行、macOS 的 `chmod`/`flock`。
