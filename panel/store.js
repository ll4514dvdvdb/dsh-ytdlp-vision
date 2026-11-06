// Cookie 配置的持久化层：面板写、Python 读。
//
// 文件固定在 `<dsh home>/ytdlp-vision/cookies.json`，和 Python 侧 cookies.py 共用同一份
// 格式，所以两边谁先改都不会打架。值属于凭据，这里只往外发脱敏视图（masked），
// 明文永远不出这个模块（导出功能是用户显式点击才返回一次）。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BROWSER_CHOICES, SITE_PRESETS, findPreset } from "./sites.js";

export { BROWSER_CHOICES, SITE_PRESETS };
export { restrict };

// 会破坏 Netscape 行结构 / Cookie 头的控制字符
const CONTROL = /[\u0000-\u001f\u007f]/g;
// 这些 id 会污染对象原型，绝不允许当成站点名
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

export function visionHome() {
	const base = process.env.YTDLP_VISION_HOME || process.env.BILI_VISION_HOME;
	return base ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "ytdlp-vision");
}

function defaultConfig() {
	return { version: 2, sites: Object.create(null), browser: { from: "off", name: "edge" }, extra: "" };
}

function mask(value) {
	if (typeof value !== "string" || value.length === 0) return "";
	if (value.length <= 10) return `${value.slice(0, 2)}****${value.slice(-2)}`;
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function clean(text) {
	return typeof text === "string" ? text.replace(CONTROL, "").trim() : "";
}

function normalizeCookies(list) {
	if (!Array.isArray(list)) return [];
	const out = [];
	for (const item of list) {
		const name = clean(item?.name);
		const value = clean(item?.value);
		if (name.length === 0 || value.length === 0) continue;
		const cookie = { name: name.slice(0, 200), value: value.slice(0, 8192) };
		const domain = clean(item?.domain);
		const path = clean(item?.path);
		if (domain) cookie.domain = domain.slice(0, 200);
		if (path) cookie.path = path.slice(0, 200);
		if (item?.secure === true) cookie.secure = true;
		if (item?.httpOnly === true) cookie.httpOnly = true;
		out.push(cookie);
	}
	return out;
}

function normalizeDomains(entry, fallback) {
	const list = Array.isArray(entry?.domains) ? entry.domains : [];
	const merged = [...list, typeof entry?.domain === "string" ? entry.domain : "", ...(fallback ?? [])]
		.map((item) => clean(item))
		.filter((item) => item.length > 0);
	return [...new Set(merged)];
}

/** 单站点：合并 cookies（同名同域覆盖，空值删除）。 */
function mergeCookies(existing, incoming) {
	const map = new Map();
	for (const item of existing ?? []) map.set(`${item.domain ?? ""}\u0000${item.name}`, item);
	for (const item of normalizeCookies(incoming)) {
		const key = `${item.domain ?? ""}\u0000${item.name}`;
		if (item.value === "-") map.delete(key);
		else map.set(key, item);
	}
	return [...map.values()];
}

/** Windows 上把文件的 ACL 收紧到「当前用户 + SYSTEM」，其余平台 chmod 0600。 */
function restrict(path) {
	if (process.platform !== "nt") {
		// 目录要 x 位才能进入，0o600 会让属主自己也打不开
		let mode = 0o600;
		try { if (statSync(path).isDirectory()) mode = 0o700; } catch { /* 文件可能还没建好 */ }
		chmod(path, mode).catch(() => {});
		return;
	}
	const user = process.env.USERNAME;
	if (!user) return;
	try {
		const child = spawn("icacls", [path, "/inheritance:r", "/grant:r", `${user}:(F)`, "/grant:r", "SYSTEM:(F)"], {
			windowsHide: true,
			stdio: "ignore",
			timeout: 20000
		});
		child.on("error", () => {});
	} catch {
		// 收紧失败不影响可用性
	}
}

function uniqueSuffix() {
	return `${process.pid}-${randomBytes(3).toString("hex")}`;
}

export class CookieStore {
	#path;
	#value = defaultConfig();
	#loaded = false;
	#mtime = null;
	#lastWrite = null;

	constructor(options = {}) {
		this.#path = options.path ?? join(visionHome(), "cookies.json");
	}

	get path() {
		return this.#path;
	}

	get cookieFilePath() {
		return join(dirname(this.#path), "cookies.txt");
	}

	/** 磁盘上的文件被外部（另一个面板实例 / 手工编辑）改过时重新载入，避免覆盖别人的改动。 */
	async #reloadIfChanged() {
		let mtime = null;
		try {
			mtime = (await stat(this.#path)).mtimeMs;
		} catch {
			mtime = null;
		}
		if (mtime !== this.#mtime) {
			this.#loaded = false;
			this.#mtime = mtime;
		}
	}

	async load() {
		if (this.#loaded) return this.#value;
		this.#loaded = true;
		let raw = null;
		try {
			raw = await readFile(this.#path, "utf8");
		} catch {
			// 首次运行：没有文件就是空配置
		}
		const value = defaultConfig();
		if (raw !== null) {
			let parsed = null;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// 损坏时不能静默覆盖：备份一份再从空配置开始
				const backup = `${this.#path}.corrupt-${Date.now()}`;
				await rename(this.#path, backup).catch(() => {});
			}
			if (parsed && typeof parsed === "object") {
				for (const [id, entry] of Object.entries(parsed.sites ?? {})) {
					if (RESERVED_IDS.has(id) || entry === null || typeof entry !== "object") continue;
					const preset = findPreset(id);
					value.sites[id] = {
						enabled: entry.enabled === true,
						label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : (preset?.label ?? id),
						domains: normalizeDomains(entry, preset?.domains ?? []),
						source: entry.source === "grab" ? "grab" : "manual",
						updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : null,
						cookies: normalizeCookies(entry.cookies)
					};
				}
				value.browser = {
					from: BROWSER_CHOICES.includes(parsed.browser?.from) ? parsed.browser.from : "off",
					name: String(parsed.browser?.name ?? "edge")
				};
				value.extra = typeof parsed.extra === "string" ? parsed.extra : "";
			}
		}
		this.#value = value;
		try {
			this.#mtime = (await stat(this.#path)).mtimeMs;
		} catch {
			this.#mtime = null;
		}
		return this.#value;
	}

	async #persist() {
		await mkdir(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.${uniqueSuffix()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.#value, null, "\t")}\n`, { mode: 0o600 });
		restrict(temporary);
		await rename(temporary, this.#path);
		restrict(this.#path);
		try {
			this.#mtime = (await stat(this.#path)).mtimeMs;
		} catch {
			this.#mtime = null;
		}
	}

	async patchSite(id, patch) {
		await this.#reloadIfChanged();
		await this.load();
		const siteId = String(id ?? "").trim();
		if (siteId.length === 0 || !/^[a-z0-9._-]{1,40}$/i.test(siteId)) throw new Error("站点 id 不合法");
		if (RESERVED_IDS.has(siteId.toLowerCase())) throw new Error("站点 id 不合法");
		const preset = findPreset(siteId);
		const current = this.#value.sites[siteId] ?? {
			enabled: false,
			label: preset?.label ?? siteId,
			domains: preset?.domains ?? [],
			source: "manual",
			updatedAt: null,
			cookies: []
		};
		const incoming = normalizeCookies(patch?.cookies);
		const domains = normalizeDomains(
			{ domains: Array.isArray(patch?.domains) ? patch.domains : undefined, domain: patch?.domain },
			current.domains.length > 0 ? current.domains : (preset?.domains ?? [])
		);
		this.#value.sites[siteId] = {
			enabled: patch?.enabled === undefined ? current.enabled : patch.enabled === true,
			label: typeof patch?.label === "string" && patch.label.trim() ? patch.label.trim().slice(0, 60) : current.label,
			domains,
			source: patch?.source === "grab" ? "grab" : patch?.source === "manual" ? "manual" : current.source,
			updatedAt: incoming.length > 0 ? Date.now() : current.updatedAt,
			cookies: patch?.replace === true ? incoming : mergeCookies(current.cookies, patch?.cookies)
		};
		await this.#persist();
		return this.state();
	}

	async removeSite(id) {
		await this.#reloadIfChanged();
		await this.load();
		delete this.#value.sites[String(id ?? "")];
		await this.#persist();
		// 删完站点立刻重生成 cookies.txt：否则文件里还留着刚删掉的站点的凭据，
		// 直到用户手动点「同步」为止。生成失败只记日志，不回滚已完成的删除。
		await this.writeNetscape().catch(() => {});
		return this.state();
	}

	async patchBrowser(patch) {
		await this.#reloadIfChanged();
		await this.load();
		const from = String(patch?.from ?? this.#value.browser.from);
		if (!BROWSER_CHOICES.includes(from)) throw new Error(`不支持的浏览器：${from}`);
		const name = String(patch?.name ?? this.#value.browser.name);
		if (!/^[a-z_]{3,20}(?::[^:\r\n\t]{1,80})?$/i.test(name)) throw new Error("浏览器名不合法");
		this.#value.browser = { from, name };
		await this.#persist();
		return this.state();
	}

	async patchExtra(text) {
		await this.#reloadIfChanged();
		await this.load();
		if (typeof text !== "string") throw new Error("extra 必须是文本");
		if (text.length > 64 * 1024) throw new Error("extra 太长（上限 64KB）");
		this.#value.extra = text;
		await this.#persist();
		return this.state();
	}

	/** 生成给 yt-dlp 用的 Netscape 文件；没有启用站点时删除旧文件。 */
	async writeNetscape() {
		await this.#reloadIfChanged();
		await this.load();
		const lines = ["# Netscape HTTP Cookie File", "# generated by ytdlp-vision; do not edit by hand", ""];
		for (const [id, site] of Object.entries(this.#value.sites)) {
			if (!site.enabled || site.cookies.length === 0) continue;
			const fallback = site.domains[0] ?? findPreset(id)?.domains?.[0] ?? "";
			for (const item of site.cookies) {
				const domain = item.domain ?? fallback;
				if (!domain) continue;
				const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
				// 第 4 列是 secure 标记；恒填 TRUE 会让纯 http 的站点收不到 cookie
				lines.push([domain, includeSub, item.path ?? "/", item.secure === true ? "TRUE" : "FALSE", "4070908800", item.name, item.value].join("\t"));
			}
		}
		const extra = this.#value.extra.trim();
		if (extra.length > 0) lines.push(...extra.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#")));
		const body = `${lines.join("\n")}\n`;
		const hasRows = body.split("\n").some((line) => line.length > 0 && !line.startsWith("#"));
		if (!hasRows) {
			// 没有启用站点时必须把旧文件删掉：否则用户「删光了 cookie」之后，
			// yt-dlp 还在用上一轮生成的 cookies.txt 带着已删除站点的凭据发请求。
			await unlink(this.cookieFilePath).catch(() => {});
			this.#lastWrite = { path: this.cookieFilePath, rows: 0, at: Date.now() };
			return this.#lastWrite;
		}
		await mkdir(dirname(this.#path), { recursive: true });
		const temporary = `${this.cookieFilePath}.${uniqueSuffix()}.tmp`;
		await writeFile(temporary, body, { mode: 0o600 });
		restrict(temporary);
		await rename(temporary, this.cookieFilePath);
		restrict(this.cookieFilePath);
		const rows = body.split("\n").filter((line) => line.length > 0 && !line.startsWith("#")).length;
		this.#lastWrite = { path: this.cookieFilePath, rows, at: Date.now() };
		return this.#lastWrite;
	}

	/** 导出成 Netscape 文本：只在用户显式点「导出」时调用，明文会经由 HTTP 响应返回一次。 */
	async exportNetscape() {
		await this.#reloadIfChanged();
		await this.load();
		const lines = ["# Netscape HTTP Cookie File", "# exported by ytdlp-vision", ""];
		for (const [id, site] of Object.entries(this.#value.sites)) {
			if (!site.enabled || site.cookies.length === 0) continue;
			const fallback = site.domains[0] ?? findPreset(id)?.domains?.[0] ?? "";
			for (const item of site.cookies) {
				const domain = item.domain ?? fallback;
				if (!domain) continue;
				lines.push([domain, domain.startsWith(".") ? "TRUE" : "FALSE", item.path ?? "/", item.secure === true ? "TRUE" : "FALSE", "4070908800", item.name, item.value].join("\t"));
			}
		}
		return { text: `${lines.join("\n")}\n`, rows: lines.length - 3 };
	}

	/** 脱敏视图：页面只拿到名字与掩码，值要重填或重新抓取才会覆盖。 */
	async state() {
		await this.#reloadIfChanged();
		await this.load();
		const sites = [];
		for (const preset of SITE_PRESETS) {
			const saved = this.#value.sites[preset.id];
			sites.push({
				id: preset.id,
				label: preset.label,
				note: preset.note,
				loginUrl: preset.loginUrl,
				domains: saved?.domains?.length ? saved.domains : preset.domains,
				preset: true,
				enabled: saved?.enabled === true,
				source: saved?.source ?? "manual",
				updatedAt: saved?.updatedAt ?? null,
				total: saved?.cookies?.length ?? 0,
				keys: preset.keys,
				need: preset.need,
				cookies: (saved?.cookies ?? []).map((item) => ({ name: item.name, masked: mask(item.value), filled: true, domain: item.domain ?? "" }))
			});
		}
		for (const [id, saved] of Object.entries(this.#value.sites)) {
			if (findPreset(id) !== undefined) continue;
			sites.push({
				id,
				label: saved.label || id,
				note: "自定义站点",
				loginUrl: `https://${(saved.domains[0] ?? "").replace(/^\./, "")}`,
				domains: saved.domains,
				preset: false,
				enabled: saved.enabled,
				source: saved.source,
				updatedAt: saved.updatedAt,
				total: saved.cookies.length,
				keys: saved.cookies.map((item) => item.name).slice(0, 8),
				need: { all: [], any: [] },
				cookies: saved.cookies.map((item) => ({ name: item.name, masked: mask(item.value), filled: true, domain: item.domain ?? "" }))
			});
		}
		let cookieFile = { exists: false, bytes: 0, path: this.cookieFilePath };
		try {
			const info = await stat(this.cookieFilePath);
			cookieFile = { exists: true, bytes: info.size, path: this.cookieFilePath };
		} catch {
			// 还没生成过文件
		}
		const withCookies = sites.filter((site) => site.total > 0);
		return {
			configPath: this.#path,
			cookieFile,
			browser: this.#value.browser,
			sites: sites.filter((site) => site.preset || site.total > 0),
			stats: { sites: withCookies.length, cookies: withCookies.reduce((sum, site) => sum + site.total, 0) },
			extra: { filled: this.#value.extra.trim().length > 0, lines: this.#value.extra.trim() ? this.#value.extra.trim().split(/\r?\n/).length : 0 },
			authority: this.#value.browser.from !== "off" ? `browser:${this.#value.browser.name}` : cookieFile.exists ? "cookies.txt" : "none"
		};
	}
}

export { mask };
