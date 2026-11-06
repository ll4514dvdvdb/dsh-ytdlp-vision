/** ytdlp-vision: 多平台视频证据（B 站走官方 API，其余交给 yt-dlp），可选独立 API 分析。 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

const HERE = dirname(fileURLToPath(import.meta.url))
const VISION_PY = join(HERE, 'vision.py')
const UPDATE_PY = join(HERE, 'update.py')
export const name = 'ytdlp-vision'
export const inject = ['tools']

// Cookie 面板：数据层给 Python 侧共用同一份 cookies.json。
import { createPanelRoute } from './panel/routes.js'
import { CookieStore } from './panel/store.js'
import { Grabber } from './panel/grabber.js'

// Register native JSON Schema directly. No dependency discovery or identity fallback.
const output = {
  schema: {
    type: 'object', required: ['text', 'images'], additionalProperties: false,
    properties: { text: { type: 'string' }, images: { type: 'array', items: { type: 'object' } } },
  },
  render: (_args, value) => [
    { type: 'text', text: value.text },
    ...value.images.map(attachment => ({ type: 'image', attachment })),
  ],
}
const result = (text, images = []) => ({ text, images })

function dshHomes() {
  return [...new Set([process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean))]
}

export function findPython(configured = '') {
  const exe = process.platform === 'win32' ? 'python.exe' : 'python3'
  const candidates = [configured, process.env.YTDLP_VISION_PYTHON, process.env.BILI_VISION_PYTHON]
  for (const home of dshHomes()) {
    // bili-vision 的 venv 里已经装好 whisper/OCR 依赖，优先复用，避免重复下载模型
    for (const venv of ['bili-vision-venv', 'ytdlp-vision-venv']) {
      candidates.push(join(home, venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
    }
    const rt = join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python')
    candidates.push(join(rt, exe), join(rt, 'bin', exe))
  }
  candidates.push(exe, 'python')
  for (const candidate of candidates.filter(Boolean)) {
    if ((candidate.includes('/') || candidate.includes('\\')) && !existsSync(candidate)) continue
    const check = spawnSync(candidate, ['-c', 'import sys; sys.exit(sys.version_info < (3,10))'], {
      windowsHide: true, timeout: 5000, stdio: 'ignore',
    })
    if (!check.error && check.status === 0) return candidate
  }
  throw new Error('ytdlp-vision 需要 Python 3.10+；请设置 YTDLP_VISION_PYTHON 指向可用解释器')
}

// 并发上限：多个视频同时抽帧/转写会把机器打满，且 ffmpeg + whisper 都很吃内存。
// 默认同时跑 2 个；可用 YTDLP_VISION_MAX_PARALLEL 调整（1 表示完全串行）。
const MAX_PARALLEL = Math.max(1, Math.min(16, Number(process.env.YTDLP_VISION_MAX_PARALLEL) || 2))
let activeJobs = 0
const waitingJobs = []

function acquireSlot(signal) {
  if (activeJobs < MAX_PARALLEL) { activeJobs += 1; return Promise.resolve() }
  return new Promise((resolve, reject) => {
    const grant = () => { signal?.removeEventListener('abort', onAbort); resolve() }
    const onAbort = () => {
      const index = waitingJobs.indexOf(grant)
      if (index >= 0) waitingJobs.splice(index, 1)
      reject(signal.reason ?? new Error('已取消'))
    }
    waitingJobs.push(grant)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function releaseSlot() {
  const next = waitingJobs.shift()
  if (next) next()            // 名额直接转交，activeJobs 不变
  else activeJobs = Math.max(0, activeJobs - 1)
}

export function runPy(python, args, { timeoutMs = 30 * 60 * 1000, signal, env = {}, onLog } = {}) {
  // 同步检查，保持「已取消就不再启动子进程」的契约（调用方可直接 assert.throws）
  signal?.throwIfAborted()
  return acquireSlot(signal).then(() => new Promise((resolvePromise, reject) => {
    let released = false
    const release = () => { if (!released) { released = true; releaseSlot() } }
    let child
    try {
      child = spawn(python, [VISION_PY, ...args], {
        cwd: HERE, windowsHide: true, detached: process.platform !== 'win32',
        env: { ...process.env, ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      release()
      reject(error)
      return
    }
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8')
    let out = '', err = '', pending = '', failure, stopped = false
    const stop = reason => {
      if (stopped) return
      stopped = true; failure = reason
      if (!child.pid) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
        killer.on('exit', code => { if (code !== 0) child.kill() })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
    }
    const abort = () => stop(signal.reason ?? new Error('已取消'))
    const timer = setTimeout(() => stop(new Error('视频处理超时；可缩小时间范围或使用更快的 ASR 模型')), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.stdout.on('data', b => {
      out += stdout.write(b)
      if (out.length > 8 * 1024 * 1024) stop(new Error('工具输出过大；请缩小时间范围'))
    })
    child.stderr.on('data', b => {
      const value = stderr.write(b); err = (err + value).slice(-16000); pending += value
      const lines = pending.split(/\r?\n/); pending = lines.pop()
      for (const line of lines) { if (line.trim()) onLog?.(line) }
    })
    child.on('error', e => { cleanup(); release(); reject(e) })
    child.on('close', code => {
      cleanup(); release(); out += stdout.end(); err += stderr.end()
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`视频处理失败 exit=${code}\n${err.slice(-2500)}`))
      else resolvePromise({ out, err })
    })
  }))
}

/** 每次启动在后台把 yt-dlp 更新到最新；失败静默，绝不阻塞 DSH 启动。 */
function startUpdater(config = {}) {
  if (config.updateOnBoot === false) return
  let python
  try { python = findPython(config.python) } catch { return }
  const hours = Number.isFinite(config.updateIntervalHours) ? config.updateIntervalHours : 0
  try {
    const child = spawn(python, [UPDATE_PY, '--quiet', '--min-interval', String(hours)], {
      cwd: HERE, windowsHide: true, detached: true, stdio: 'ignore',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    child.on('error', () => {})
    child.unref()
  } catch { /* 更新器起不来不影响使用 */ }
}

function service(ctx, name) { return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name] }

async function imageRoute(ctx, exec) {
  const attachments = service(ctx, 'attachments')
  if (!attachments?.saveImages) throw new Error('DSH 未挂载图片附件服务；可以使用 action=text，或配置 API 后使用 action=run。')
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  const llm = service(ctx, 'llm')
  if (!llm || provider === undefined || model === undefined) {
    throw new Error('无法核实当前 DSH 模型的图片能力；请使用支持图片的模型，或先用 action=text。')
  }
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  if (!info.inputModalities?.includes('image')) throw new Error(`当前模型 ${model} 不支持图片；请切换视觉模型或使用 policy=text。`)
  return attachments
}

const properties = {
  action: { type: 'string', enum: ['inspect', 'plan', 'text', 'frames', 'run'], description: '默认 inspect：把真实画面和文本交给当前 DSH 模型；plan 本地预算；run 额外调用独立 API。' },
  target: { type: 'string', minLength: 1, description: '视频链接、播放列表/合集链接，或本机视频文件路径：B 站 BV 号/链接（支持 ?p=2）、YouTube、X/Twitter、Vimeo、抖音等 yt-dlp 支持的站点，以及 .mp4/.mkv/.webm/.mov 等本地文件' },
  playlist: { type: 'boolean', description: '强制把 target 当播放列表。带 &list= 的单个视频链接默认只看当前视频，想整列处理时置 true' },
  index: { type: 'integer', minimum: 1, maximum: 9999, description: '播放列表里的第几条（从 1 开始）。给了就按那一条单独分析' },
  limit: { type: 'integer', minimum: 1, maximum: 100, description: 'action=text 批量取播放列表字幕时的条数上限，默认 10' },
  ask: { type: 'string', description: '当前问题，用于相关画面选择；应传入用户实际问题' },
  sessionData: { type: 'string', description: '可选 B 站 SESSDATA（仅 B 站有效），推荐配置 BILI_SESSDATA 环境变量' },
  policy: { type: 'string', enum: ['auto', 'always', 'text'], description: 'auto 全片覆盖+问题相关帧；always 全片均匀覆盖；text 跳过视频和视觉处理' },
  maxVision: { type: 'integer', minimum: 1, maximum: 36, description: '最多返回的帧数，默认 12。增加能补充证据，也会增加模型输入成本' },
  gridSize: { type: 'integer', enum: [1, 4, 9], description: '每图帧数。默认4；指定时间范围默认1方便看细节；9适合只看大致动作' },
  start: { type: 'number', minimum: 0, description: '只分析此时间之后的内容（秒），配合 end 细看关键片段' },
  end: { type: 'number', minimum: 0, description: '分析截止时间（秒）' },
  maxTextTokens: { type: 'integer', minimum: 2000, maximum: 64000, description: '文本上下文预算估算，默认12000；超出会明确标记省略，按时间追问可取全' },
  ocr: { type: 'boolean', description: '默认 true，仅识别选中的画面，并缓存结果' },
  refresh: { type: 'boolean', description: '重新计算选帧、图片及 OCR，绕过答案缓存' },
}

function validate(args, spec) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象')
  if (typeof args.target !== 'string' || !args.target.trim()) throw new Error('target 不能为空')
  for (const [key, value] of Object.entries(args)) {
    const rule = spec[key]
    if (!rule) throw new Error(`未知参数 ${key}`)
    const typeOK = rule.type === 'integer' ? Number.isInteger(value) : typeof value === rule.type
    if (!typeOK || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`${key} 类型错误`)
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`${key} 不在支持的选项内`)
    if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum) throw new Error(`${key} 超出范围`)
  }
  if (args.start !== undefined && args.end !== undefined && args.start >= args.end) throw new Error('start 必须小于 end')
}

// DSH accepts a deliberately small JSON Schema subset; ranges are enforced above.
function schemaProperties(spec) {
  return Object.fromEntries(Object.entries(spec).map(([key, rule]) => {
    const { minimum, maximum, minLength, ...supported } = rule
    return [key, supported]
  }))
}

function cacheRoot() {
  return process.env.YTDLP_VISION_CACHE || process.env.BILI_VISION_CACHE
    || join(homedir(), '.dsh', 'ytdlp-vision-cache')
}

export function apply(ctx, config = {}) {
  // Delay Python lookup until invocation so missing dependencies do not break DSH boot.
  let python
  const timeoutMs = config.timeoutMs ?? 30 * 60 * 1000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs 必须为正数')
  // yt-dlp 自更新：后台跑，失败静默
  setTimeout(() => startUpdater(config), 800)
  const invoke = async (args, exec = {}) => {
    validate(args, properties)
    const action = args.action ?? 'inspect'
    const policy = args.policy ?? config.defaultPolicy ?? 'auto'
    let attachments
    if (action === 'inspect' && policy !== 'text') attachments = await imageRoute(ctx, exec)
    const grid = args.gridSize ?? (args.start !== undefined || args.end !== undefined ? 1 : 4)
    const cap = attachments?.imageLimits?.maxImagesPerMessage
    if (cap && (args.maxVision ?? 12) > cap * grid) args = { ...args, maxVision: cap * grid }
    python ??= findPython(config.python)
    const argv = [action, args.target.trim(), '--vision-policy', policy]
    const options = { ask: '--ask', maxVision: '--max-vision', gridSize: '--grid-size', start: '--start', end: '--end', maxTextTokens: '--max-text-tokens', index: '--index', limit: '--limit' }
    for (const [key, flag] of Object.entries(options)) if (args[key] !== undefined) argv.push(flag, String(args[key]))
    if (args.playlist) argv.push('--playlist')
    if (args.ocr === false) argv.push('--no-ocr')
    if (args.refresh) argv.push('--refresh')
    // Credentials stay out of the process command line.
    const env = args.sessionData ? { BILI_SESSDATA: args.sessionData } : {}
    const response = await runPy(python, argv, { timeoutMs, signal: exec.signal, env })
    exec.signal?.throwIfAborted()
    if (action !== 'inspect') return result(response.out.trim() + (action === 'text' && response.err ? `\n\n[处理说明]\n${response.err.slice(-1200)}` : ''))
    const evidence = JSON.parse(response.out)
    if (!evidence.images.length) return result(evidence.text)
    const root = await realpath(cacheRoot())
    const inputs = []
    for (const item of evidence.images) {
      const path = await realpath(item.path)
      const rel = relative(root, path)
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('图片不在视频缓存目录中')
      inputs.push({ data: await readFile(path), mediaType: 'image/jpeg', name: basename(path) })
    }
    exec.signal?.throwIfAborted()
    const refs = await attachments.saveImages(inputs)
    exec.signal?.throwIfAborted()
    return result(evidence.text, [...refs])
  }
  ctx.tools.register({
    name: 'ytdlp_vision',
    description: '理解视频（B 站、YouTube、X/Twitter、Vimeo、抖音等 yt-dlp 支持的站点）。优先 action=inspect（默认）：把带实际时间戳的画面、字幕/转写、OCR交给当前对话模型，无额外独立API调用，但证据仍占当前模型token。先整体看；细节不足时用 start/end + gridSize=1 补看。仅需口播可用 policy=text。不要把采样当成完整观看。action=run 会额外使用配置的独立API。',
    parameters: { type: 'object', properties: schemaProperties(properties), required: ['target'], additionalProperties: false },
    output, timeoutMs, execute: invoke,
  })
  const summaryProps = { target: properties.target, sessionData: properties.sessionData }
  ctx.tools.register({
    name: 'ytdlp_summary',
    description: '获取视频字幕或本地转写供当前对话模型总结；不下载视频、不抽帧、不另调模型。不能回答画面相关问题。',
    parameters: { type: 'object', properties: schemaProperties(summaryProps), required: ['target'], additionalProperties: false },
    output, timeoutMs,
    async execute(args, exec) {
      validate(args, summaryProps)
      return invoke({ ...args, action: 'text', policy: 'text' }, exec)
    },
  })

  // Cookie 面板：同源页面 /ytdlp-vision-panel/，数据层与 Python 侧共用同一份 cookies.json。
  // 属于可选能力：精简宿主或单测环境没有 ctx.inject 时跳过，核心工具照常可用。
  if (typeof ctx.inject === 'function') {
    const store = new CookieStore()
    // 抓到登录态后整站覆盖：自动抓取拿到的就是该站点此刻的完整 cookie 集。
    const grabber = new Grabber({
      onSaved: async ({ siteId, label, domain, cookies, reason }) => {
        await store.patchSite(siteId, {
          enabled: true,
          label,
          domains: domain ? [domain] : undefined,
          cookies,
          replace: true,
          source: 'grab'
        })
        await store.writeNetscape()
        ctx.logger?.info?.(`[ytdlp-vision] 自动抓取完成：${label} ${cookies.length} 个 cookie（${reason}）`)
      }
    })
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => {
        const dispose = sctx.webServer.register(createPanelRoute(store, grabber))
        return () => dispose?.()
      }, 'ytdlp-vision: cookie panel')
    })
  }
}
