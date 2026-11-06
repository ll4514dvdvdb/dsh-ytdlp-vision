# 0.7.1 变更报告（0.7.0 发布后的实测修复）

本文件记录 0.7.0 发布之后、用真实环境验证时发现的问题、根因、修复方式和实测证据。
只写实际验证过的结论；没有验证的一律标「未验证」。

## 一、为什么会发现这些问题

0.7.0 的改进全部依赖离线单元测试（假 `requests`、假 `subprocess`）。发布后第一件事是让 GitHub Actions 真跑一遍，同时在本机用真实网络、真实 gpg、真实 Pillow 版本做验证。三个真实问题都是这么暴露出来的：

| 验证手段 | 暴露的问题 |
|---|---|
| GitHub Actions 首跑（run #11） | CI 缺 `requests`/`numpy`；`pip-audit` 报 Pillow 21 条漏洞 |
| 真实网络跑 `run_update()` | `release-assets.githubusercontent.com` 不在白名单 → 更新必定失败 |
| 真实 gpg（GnuPG 2.4.9 + MSYS 版） | 验签在 Windows 上从未成功过 |
| 真实 Pillow 13.0.0 | （无问题，确认升级安全） |

## 二、自动更新（`update.py`）

### 1. GitHub release 资产换了域名（高）

- **现象**：真实调用时抛 `ValueError: 拒绝非可信主机：release-assets.githubusercontent.com`。
- **实测重定向链**：`https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/SHA2-256SUMS`
  → `302` → `https://release-assets.githubusercontent.com/github-production-release-asset/...`
  → `200`。
- **根因**：`RELEASE_HOSTS` 只有 `github.com` 和 `objects.githubusercontent.com`。逐跳校验本身是对的，是白名单没跟上 GitHub 的域名迁移。
- **修复**：`RELEASE_HOSTS = ("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")`。
- **回归测试**：`tests/test_update.py::test_redirect_to_release_assets_host_is_followed`（302 到新域名后正常完成替换）。
- **影响面**：只放宽白名单，不放宽协议（仍强制 https）、不放宽凭据检查。

### 2. GPG 验签在 Windows 上从来没成功过（高）

- **现象**：真实机器上 `verify_signature()` 返回 `skipped: gpg 执行失败（CalledProcessError）`。
- **真实错误**（逐步定位）：

  ```
  # 第一次：带 --keyring 绝对路径
  gpg: invalid key resource URL 'C:\\Users\\...\\gnupg\\pubring.kbx'
  gpg: keyblock resource '(null)': General error
  gpg: no writable keyring found: Not found
  import_rc=2

  # 第二次：去掉 --keyring，仍用绝对 GNUPGHOME
  gpg: keyblock resource '/c/.../workspace/C:\\Users\\...\\gnupg/pubring.kbx': No such file or directory
  gpg: no writable keyring found: Not found
  ```

- **根因**：Git for Windows 自带的是 **MSYS 版 gpg**，它把 `C:\...` 当成相对 POSIX 路径、把 `--keyring C:\...` 当成资源 URL 解析。Gpg4win 的原生 gpg 接受 Windows 绝对路径，所以这个问题只在装 Git 的机器上出现。
- **修复**：在临时目录内用**相对文件名 + `cwd`**，`GNUPGHOME="gnupg"`（相对名），并去掉多余的 `--no-default-keyring --keyring`（隔离本来就由独立 `GNUPGHOME` 保证）。
- **失败可诊断**：新增 `_stderr_tail()`，`failed:` / `skipped:` 都带上 gpg 的 stderr 末尾（压成单行、截 300 字符）。
- **实测证据**（真实网络 + 真实 gpg 2.4.9）：

  ```
  sums_digest: e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3
  sums_bytes: 1595
  verify_real_attempt1: ok
  verify_tampered: failed: 签名校验不通过（gpg 1）：...
      gpg: using RSA key AC0CBBE6848D6A873464AF4E57CF65933B5A7581
      gpg: BAD signature from "Simon Sawicki (yt-dlp signing key) <contact@grub4k.xyz>"
  ```

  即：真签名通过、篡改一位数字后拒绝。
- **回归测试**：`tests/test_update.py::SignatureTests` 5 项（假 `subprocess.run`，不依赖本机装没装 gpg）。

### 3. 临时目录在受限环境里建不出来（中）

- **现象**：`tempfile.mkdtemp()` 建出来的目录，往里写第一个文件就 `PermissionError [Errno 13]`；`icacls` 都读不了那个目录。
- **根因**：`mkdtemp` 按 `0o700` 建目录，在带文件系统过滤驱动/沙箱的环境里会得到一个连创建者都写不进去的目录。普通 `Path.mkdir()`（默认模式）建的目录完全正常。
- **修复**：改为 `HOME / f"gpg-{os.getpid()}-{time.time_ns()}"` + `mkdir()`，`finally` 里 `shutil.rmtree(ignore_errors=True)`；建目录失败返回 `skipped: 建不了临时目录（…）`。
- **顺带的同类修复**：`(home/"gnupg").mkdir(mode=0o700)` 在 Windows 上会触发 chmod，受限环境直接 `WinError 5`；改成不带 mode，只在 `os.name != "nt"` 时 `os.chmod`。

## 三、依赖与 CI

### 4. CI 缺 Python 依赖（高）

- **现象**：run #11 里 Windows 和 Linux 两个 Python 测试 job 都失败，`Ran 74 tests`，报 `ModuleNotFoundError: No module named 'numpy'`（`test_overlong_audio_is_skipped_not_truncated`）和 `No module named 'requests'`（3 项）。
- **根因**：`.github/workflows/ci.yml` 的安装步骤只有 `pip install Pillow`。
- **修复**：`pip install requests numpy Pillow`。
- **说明**：本地跑不出这个问题，因为本机 venv 里这些都装着——**这正是必须真跑 CI 的理由**。

### 5. `pip-audit` 报 Pillow 21 条漏洞（高）

- **现象**：`pip-audit -r requirements.txt --no-deps --strict` 失败，Pillow 12.3.0 有 21 条（`PYSEC-2026-4326/4327/4328/4334/4339/4340/4343…`、`CVE-2026-1123xx`、`GHSA-78g4-xqwv-q3g8`），Fix Versions 全部是 13.0.0。
- **根因**：`requirements.txt` 写的是 `Pillow>=10.1,<13`，把唯一的修复版本排除在外了。
- **修复**：`<13` → `<14`，并实测 13.0.0 兼容性（见下）。
- **未验证**：Pillow 14 尚未发布（未验证其兼容性，上界先留 `<14`）。

### 6. Pillow 13.0.0 兼容性实测

- 环境：`tests/.tools/pil13`（从清华镜像下载 `pillow-13.0.0-cp312-cp312-win_amd64.whl`，7,272,166 字节，解包），`PYTHONPATH` 前置。
- 结果：`PIL 13.0.0`，`python -B -m unittest tests.test_pipeline` → **27 项全部通过**。
- 覆盖到的 API：`Image.open`、`ImageOps.contain`、`Image.new`、`ImageDraw.Draw`、`ImageFont.load_default(size=16)`、`sheet.save(quality=90)`。

## 四、验证手段本身的经验

- **负向测试**（证明静态检查真的会拦人，而不是配了不用）：

  | 工具 | 探针 | 结果 |
  |---|---|---|
  | eslint | 重复 `const a` | `Parsing error: Identifier 'a' has already been declared`，exit 1 |
  | eslint | `console.log(unknownGlobalName)` | `'unknownGlobalName' is not defined  no-undef`，exit 1 |
  | eslint | `const unusedVar = 1` | `'unusedVar' is assigned a value but never used  no-unused-vars`，exit 1 |
  | ruff | `import os` 未使用 | `F401 ... imported but unused`，exit 1 |

  探针文件验证后立即删除，删除后 `ruff check .` 恢复 `All checks passed!`。

- **本机沙箱限制清单**（写下来是因为它们会反复骗人）：
  1. `pip install` 必失败（临时目录不可写），装包要用「requests 下载 whl + zipfile 解包」。
  2. `git push` 在 DSH 进程里必失败（`schannel: SEC_E_NO_CREDENTIALS`、`couldn't create signal pipe`），要在提权进程里跑。
  3. `gpg` 在 DSH 进程里跑不起来（同上 signal pipe），要提权。
  4. 提权后不要把 Git 的 `usr/bin` 前置到 PATH，msys DLL 会覆盖 python 的 OpenSSL 导致**静默退出、无任何输出**。
  5. `tempfile.mkdtemp()` 建的目录不可写（见上）。
  6. GitHub API 匿名限流 60 次/小时，连续验证会撞 `403`。

## 五、本轮没有验证的（明确标出）

- **Twitter/X**：仍然没有可稳定访问的公开测试样本，未验证。
- **macOS**：没有设备，未验证。
- **Pillow 14**：尚未发布，未验证。
- **CI 第二跑是否全绿**：提交后才会知道，结果会追加在本文件。
- **`gpg` 超时分支（90 秒）**：只有代码路径，没有构造真实超时。

## 六、复现命令

```bash
# 全量测试（Windows 上必须用装了 requests/numpy/Pillow 的解释器）
python -B -m unittest discover -s tests -p "test_*.py"
ruff check .
npx --yes eslint@10 .
python -B scripts/check-release.py
```

真实验签（需要 gpg + 网络，Windows 上要能跑 gpg 的权限）：

```python
import update
digest, sums = update.fetch_expected(requests, "2026.10.26", px)
print(update.verify_signature(requests, "2026.10.26", sums, px))   # 期望 ok
```
