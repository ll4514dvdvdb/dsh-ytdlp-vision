// 自动抓 cookie：开一个带独立 profile 的 Chrome/Edge，让用户在里面登录，
// 后台通过 DevTools 协议读 cookie，认到登录态就自动收工。
//
// 选独立 profile 而不是共用用户日常浏览器，是因为要读写它的 cookie 存储必须独占，
// 且不能因为读凭据把用户的主浏览器搅乱。代价是第一次要登录一次；之后这个 profile
// 会记住登录态，再点「生成」往往两秒就能收工。
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { domainMatches, findPreset, siteFromUrl } from "./sites.js";
import { restrict, visionHome } from "./store.js";
import { wsConnect } from "./ws.js";

const POLL_MS = 1200;
const LAUNCH_TIMEOUT_MS = 25000;
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

const WINDOWS_CANDIDATES = [
	["chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
	["chrome", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"],
	["chrome", "C:\\Users\\Public\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"],
	["edge", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"],
	["edge", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"],
	["brave", "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"]
];

const POSIX_CANDIDATES = [
	["chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
	["chrome", "/usr/bin/google-chrome"],
	["chrome", "/usr/bin/google-chrome-stable"],
	["chromium", "/usr/bin/chromium"],
	["chromium", "/usr/bin/chromium-browser"],
	["edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
	["edge", "/usr/bin/microsoft-edge"]
];

/** 找一个能带的浏览器；找不到返回 null（面板会提示改用手动方式）。 */
export function findBrowser() {
	const configured = process.env.YTDLP_VISION_BROWSER;
	if (configured && existsSync(configured)) return { exe: configured, label: "custom" };
	const list = process.platform === "win32" ? WINDOWS_CANDIDATES : POSIX_CANDIDATES;
	for (const [label, exe] of list) {
		if (existsSync(exe)) return { exe, label };
	}
	return null;
}

function browserProfileDir() {
	return join(visionHome(), "browser-profile");
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs = 4000) {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

/** 等 DevToolsActivePort 出现并读出端口。 */
async function waitForPort(profileDir, deadline) {
	const file = join(profileDir, "DevToolsActivePort");
	for (;;) {
		if (Date.now() > deadline) throw new Error("浏览器启动超时：没有拿到调试端口");
		try {
			const text = await readFile(file, "utf8");
			const port = Number(text.split(/\r?\n/)[0]);
			if (Number.isInteger(port) && port > 0) return port;
		} catch {
			// 文件还没写出来
		}
		await sleep(250);
	}
}

function killTree(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform === "win32") {
		execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// 已经退出
		}
	}
}

function pickCookies(list, domains) {
	const out = [];
	for (const item of list ?? []) {
		const name = String(item?.name ?? "");
		const value = String(item?.value ?? "");
		if (name.length === 0) continue;
		if (!domainMatches(item?.domain, domains)) continue;
		out.push({ name, value, domain: String(item?.domain ?? ""), path: String(item?.path ?? "/"), secure: item?.secure === true, httpOnly: item?.httpOnly === true });
	}
	out.sort((a, b) => (a.name === b.name ? (a.domain < b.domain ? -1 : 1) : a.name < b.name ? -1 : 1));
	return out;
}

export class Grabber {
	#session = null;
	#onSaved;

	constructor({ onSaved } = {}) {
		this.#onSaved = onSaved ?? (async () => {});
	}

	get active() {
		if (this.#session === null) return null;
		const { id, status, siteId, url } = this.#session;
		return { id, status, siteId, url };
	}

	state() {
		const session = this.#session;
		if (session === null) return { status: "idle" };
		return {
			id: session.id,
			status: session.status,
			siteId: session.siteId,
			siteLabel: session.site.label,
			url: session.url,
			message: session.message,
			startedAt: session.startedAt,
			cookies: {
				count: session.cookies.length,
				names: session.cookies.map((item) => item.name).slice(0, 60),
				satisfied: session.satisfied,
				expected: [...(session.site.need?.all ?? []), ...(session.site.need?.any ?? [])],
				auto: (session.site.need?.all ?? []).length + (session.site.need?.any ?? []).length > 0
			}
		};
	}

	async start({ url, siteId }) {
		if (this.#session !== null) throw new Error("已经有一个抓取窗口在跑，先关掉它");
		const target = String(url ?? "").trim();
		const detected = siteFromUrl(target);
		if (detected === null) throw new Error("URL 不合法，要带 http:// 或 https://");
		const site = { ...detected };
		if (siteId) {
			const preset = findPreset(siteId);
			if (preset !== undefined) Object.assign(site, preset);
		}
		const browser = findBrowser();
		if (browser === null) {
			throw new Error("本机没有找到 Chrome / Edge，无法自动抓取；请改用手动粘贴，或设置 YTDLP_VISION_BROWSER 指向浏览器可执行文件");
		}
		const profileDir = browserProfileDir();
		await mkdir(profileDir, { recursive: true });
		// 这个目录里有浏览器的 Cookie 库，权限收紧到只有当前用户 + SYSTEM 能读
		restrict(profileDir);
		// 无头只用于自动化测试：看不到界面就没法在里面登录，正式使用必须是有头。
		const headless = /^(1|true|yes)$/i.test(String(process.env.YTDLP_VISION_HEADLESS ?? ""));
		const args = [
			"--remote-debugging-port=0",
			"--remote-allow-origins=*",
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-features=Translate,MediaRouter",
			...(headless ? ["--headless=new"] : ["--window-size=1200,900", "--window-position=60,60"]),
			"about:blank"
		];
		const child = spawn(browser.exe, args, { stdio: "ignore", detached: process.platform !== "win32", windowsHide: false });
		const session = {
			id: `g${Date.now().toString(36)}`,
			status: "launching",
			message: "正在启动浏览器…",
			siteId: site.id,
			site,
			url: target,
			startedAt: Date.now(),
			cookies: [],
			satisfied: false,
			closed: false,
			child,
			ws: null,
			sessionId: null,
			port: 0,
			timer: null,
			pending: new Map(),
			seq: 0
		};
		this.#session = session;
		child.on("exit", () => {
			session.closed = true;
			if (session.status === "waiting" || session.status === "launching") {
				session.status = "closed";
				session.message = "浏览器已关闭（未自动完成，可再次点生成）";
			}
		});
		const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
		try {
			session.port = await waitForPort(profileDir, deadline);
			const version = await fetchJson(`http://127.0.0.1:${session.port}/json/version`);
			const wsUrl = String(version.webSocketDebuggerUrl ?? "");
			// DevToolsActivePort 文件在用户目录里，别的进程能改写它；只连本机回环地址
			if (!/^ws:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d+\//.test(wsUrl)) {
				throw new Error("DevTools 返回了非本机调试地址，已拒绝连接（可能是端口被其它程序占用）");
			}
			session.ws = await wsConnect(wsUrl, { timeoutMs: 8000 });
			const ws = session.ws;
			ws.onMessage((text) => {
				let message;
				try {
					message = JSON.parse(text);
				} catch {
					return;
				}
				const pending = session.pending?.get(message.id);
				if (pending === undefined) return;
				session.pending.delete(message.id);
				if (message.error) pending.reject(new Error(message.error.message));
				else pending.resolve(message.result);
			});
			ws.onClose(() => {
				session.closed = true;
			});
			// 打开目标页：新标签页优先，避免 about:blank 的 session 失效。
			await this.#command(session, "Target.createTarget", { url: target }).catch(() => {});
			session.status = "waiting";
			session.message = "等你在浏览器里登录…";
			session.timer = setInterval(() => {
				this.#poll(session).catch((error) => {
					session.message = String(error?.message ?? error);
				});
			}, POLL_MS);
			session.timeout = setTimeout(() => {
				this.#finalize(session, "超时自动保存").catch(() => {});
			}, SESSION_TIMEOUT_MS);
			this.#poll(session).catch(() => {});
		} catch (error) {
			this.#teardown(session);
			this.#session = null;
			throw error;
		}
		return this.state();
	}

	#command(session, method, params = {}, sessionId = session.sessionId) {
		const ws = session.ws;
		if (ws === null) return Promise.reject(new Error("浏览器没有连上"));
		const id = (session.seq += 1);
		const payload = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				session.pending.delete(id);
				reject(new Error(`CDP 超时：${method}`));
			}, 8000);
			session.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				}
			});
			try {
				ws.send(JSON.stringify(payload));
			} catch (error) {
				clearTimeout(timer);
				session.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async #ensureSession(session) {
		if (session.sessionId !== null) return session.sessionId;
		const { targetInfos } = await this.#command(session, "Target.getTargets", {}, null);
		const pages = (targetInfos ?? []).filter((item) => item.type === "page");
		const page = pages.find((item) => item.url.startsWith("http")) ?? pages[0];
		if (page === undefined) throw new Error("浏览器里没有可用页面");
		const attached = await this.#command(session, "Target.attachToTarget", { targetId: page.targetId, flatten: true }, null);
		session.sessionId = attached.sessionId;
		return session.sessionId;
	}

	async #readCookies(session) {
		await this.#ensureSession(session);
		let result;
		try {
			result = await this.#command(session, "Network.getAllCookies");
		} catch {
			result = await this.#command(session, "Storage.getCookies");
		}
		return result?.cookies ?? [];
	}

	async #poll(session) {
		if (session.closed || this.#session !== session) return;
		if (session.status !== "waiting") return;
		if (Date.now() - session.startedAt > SESSION_TIMEOUT_MS) return;
		let raw;
		try {
			raw = await this.#readCookies(session);
		} catch {
			// 页面正在跳转 / session 失效：丢掉 attach，下一轮重建。
			session.sessionId = null;
			return;
		}
		const picked = pickCookies(raw, session.site.domains);
		session.cookies = picked;
		const names = new Set(picked.map((item) => item.name));
		const need = [...(session.site.need?.all ?? []), ...(session.site.need?.any ?? [])];
		const allOk = (session.site.need?.all ?? []).every((name) => names.has(name));
		const anyOk = (session.site.need?.any ?? []).length === 0 || (session.site.need?.any ?? []).some((name) => names.has(name));
		session.satisfied = need.length > 0 && allOk && anyOk;
		if (session.satisfied) {
			session.message = "已识别到登录态，正在保存…";
			await this.#finalize(session, "自动识别登录态");
		} else {
			session.message = picked.length === 0 ? "等你在浏览器里登录…（还没读到该站点的 cookie）" : `已读到 ${picked.length} 个 cookie，等关键项…`;
		}
	}

	async #finalize(session, reason) {
		if (session.status === "done" || session.closed) {
			if (session.status !== "done") {
				session.status = "closed";
			}
			return this.state();
		}
		session.status = "saving";
		session.message = reason;
		clearInterval(session.timer);
		clearTimeout(session.timeout);
		// 保存前再抓一次，避免最后一轮轮询和这次之间用户刚点完登录。
		try {
			const raw = await this.#readCookies(session);
			const picked = pickCookies(raw, session.site.domains);
			if (picked.length > 0) session.cookies = picked;
		} catch {
			// 用上一轮结果
		}
		const saved = session.cookies;
		session.status = "done";
		session.message = saved.length === 0 ? "没有读到任何 cookie" : `${reason}：保存 ${saved.length} 个 cookie`;
		this.#teardown(session);
		this.#session = null;
		if (saved.length > 0) {
			await this.#onSaved({
				siteId: session.site.id,
				label: session.site.label,
				domain: session.site.domains[0] ?? "",
				cookies: saved,
				reason
			}).catch(() => {});
		}
		session.finishedAt = Date.now();
		return {
			siteId: session.site.id,
			saved: saved.length,
			message: session.message
		};
	}

	async finish() {
		const session = this.#session;
		if (session === null) throw new Error("没有正在运行的抓取");
		return this.#finalize(session, "手动保存");
	}

	async cancel() {
		const session = this.#session;
		if (session === null) return { ok: true };
		const count = session.cookies.length;
		this.#teardown(session);
		session.status = "cancelled";
		session.message = "已取消，没有保存";
		this.#session = null;
		return { cancelled: true, discarded: count };
	}

	#teardown(session) {
		clearInterval(session.timer);
		clearTimeout(session.timeout);
		try {
			session.ws?.close();
		} catch {
			// 已经断了
		}
		session.ws = null;
		killTree(session.child?.pid ?? 0);
	}
}

export { POLL_MS };
