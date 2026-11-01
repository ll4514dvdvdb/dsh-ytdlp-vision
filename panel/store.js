// Cookie 配置的持久化层：面板写、Python 读。
//
// 文件固定在 `<dsh home>/ytdlp-vision/cookies.json`，和 Python 侧 cookies.py 共用同一份
// 格式，所以两边谁先改都不会打架。值属于凭据，这里只往外发脱敏视图（masked），
// 明文永远不出这个模块。
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 常用站点的表单预设：只影响页面显示，存储仍然按 id 自由扩展。 */
export const SITE_PRESETS = [
	{
		id: "bilibili",
		label: "哔哩哔哩",
		domain: ".bilibili.com",
		note: "SESSDATA 必填；bili_jct / buvid3 一并填更稳（1080P 与 CC 字幕都要登录态）。",
		keys: ["SESSDATA", "bili_jct", "buvid3", "DedeUserID"]
	},
	{
		id: "youtube",
		label: "YouTube",
		domain: ".youtube.com",
		note: "会员/年龄限制视频才需要。最少给 SID + HSID + SSID + APISID + SAPISID。",
		keys: ["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "LOGIN_INFO"]
	},
	{
		id: "twitter",
		label: "X / Twitter",
		domain: ".x.com",
		note: "登录后才有的视频（敏感内容、订阅账号）需要 auth_token 和 ct0。",
		keys: ["auth_token", "ct0"]
	},
	{
		id: "vimeo",
		label: "Vimeo",
		domain: ".vimeo.com",
		note: "付费或密码视频才需要。",
		keys: ["vimeo", "is_logged_in"]
	},
	{
		id: "douyin",
		label: "抖音",
		domain: ".douyin.com",
		note: "部分作品要 sessionid；不填也能抓公开视频。",
		keys: ["sessionid", "sessionid_ss", "ttwid", "msToken"]
	}
];

export const BROWSER_CHOICES = ["off", "edge", "chrome", "chromium", "firefox", "brave", "safari"];

export function visionHome() {
	const base = process.env.YTDLP_VISION_HOME || process.env.BILI_VISION_HOME;
	return base ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "ytdlp-vision");
}

function defaultConfig() {
	return { version: 1, sites: {}, browser: { from: "off", name: "edge" }, extra: "" };
}

function mask(value) {
	if (typeof value !== "string" || value.length === 0) return "";
	if (value.length <= 10) return `${value.slice(0, 2)}****${value.slice(-2)}`;
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function normalizeCookies(list) {
	if (!Array.isArray(list)) return [];
	const out = [];
	for (const item of list) {
		const name = typeof item?.name === "string" ? item.name.trim() : "";
		const value = typeof item?.value === "string" ? item.value.trim() : "";
		if (name.length === 0 || value.length === 0) continue;
		out.push({ name, value });
	}
	return out;
}

/** 单站点：合并 cookies（同名覆盖，空值删除）。 */
function mergeCookies(existing, incoming) {
	const map = new Map((existing ?? []).map((item) => [item.name, item.value]));
	for (const item of normalizeCookies(incoming)) {
		if (item.value === "-") map.delete(item.name);
		else map.set(item.name, item.value);
	}
	return [...map.entries()].map(([name, value]) => ({ name, value }));
}

export class CookieStore {
	#path;
	#value = defaultConfig();
	#loaded = false;
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

	async load() {
		if (this.#loaded) return this.#value;
		this.#loaded = true;
		try {
			const parsed = JSON.parse(await readFile(this.#path, "utf8"));
			const sites = {};
			for (const [id, entry] of Object.entries(parsed?.sites ?? {})) {
				if (entry === null || typeof entry !== "object") continue;
				sites[id] = {
					enabled: entry.enabled === true,
					domain: typeof entry.domain === "string" ? entry.domain : "",
					cookies: normalizeCookies(entry.cookies)
				};
			}
			this.#value = {
				version: 1,
				sites,
				browser: {
					from: BROWSER_CHOICES.includes(parsed?.browser?.from) ? parsed.browser.from : "off",
					name: String(parsed?.browser?.name ?? "edge")
				},
				extra: typeof parsed?.extra === "string" ? parsed.extra : ""
			};
		} catch {
			// 首次运行或文件损坏：用空配置，页面上手动补。
		}
		return this.#value;
	}

	async #persist() {
		await mkdir(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.#value, null, "\t")}\n`, { mode: 0o600 });
		await rename(temporary, this.#path);
		try {
			await chmod(this.#path, 0o600);
		} catch {
			// Windows 上 chmod 只影响只读位，失败不影响可用性。
		}
	}

	async patchSite(id, patch) {
		await this.load();
		const siteId = String(id ?? "").trim();
		if (siteId.length === 0 || !/^[a-z0-9._-]{1,40}$/i.test(siteId)) throw new Error("站点 id 不合法");
		const preset = SITE_PRESETS.find((item) => item.id === siteId);
		const current = this.#value.sites[siteId] ?? { enabled: false, domain: preset?.domain ?? "", cookies: [] };
		const next = {
			enabled: patch?.enabled === undefined ? current.enabled : patch.enabled === true,
			domain: typeof patch?.domain === "string" && patch.domain.trim() ? patch.domain.trim() : current.domain,
			cookies: mergeCookies(current.cookies, patch?.cookies)
		};
		this.#value.sites[siteId] = next;
		await this.#persist();
		return this.state();
	}

	async removeSite(id) {
		await this.load();
		delete this.#value.sites[String(id ?? "")];
		await this.#persist();
		return this.state();
	}

	async patchBrowser(patch) {
		await this.load();
		const from = String(patch?.from ?? this.#value.browser.from);
		if (!BROWSER_CHOICES.includes(from)) throw new Error(`不支持的浏览器：${from}`);
		this.#value.browser = { from, name: String(patch?.name ?? this.#value.browser.name) };
		await this.#persist();
		return this.state();
	}

	async patchExtra(text) {
		await this.load();
		if (typeof text !== "string") throw new Error("extra 必须是文本");
		if (text.length > 64 * 1024) throw new Error("extra 太长（上限 64KB）");
		this.#value.extra = text;
		await this.#persist();
		return this.state();
	}

	/** 生成给 yt-dlp 用的 Netscape 文件；没有启用站点时删除旧文件。 */
	async writeNetscape() {
		await this.load();
		const lines = ["# Netscape HTTP Cookie File", "# generated by ytdlp-vision; do not edit by hand", ""];
		for (const [id, site] of Object.entries(this.#value.sites)) {
			if (!site.enabled || site.cookies.length === 0) continue;
			const domain = site.domain || SITE_PRESETS.find((item) => item.id === id)?.domain || "";
			if (!domain) continue;
			const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
			for (const item of site.cookies) lines.push([domain, includeSub, "/", "TRUE", "4070908800", item.name, item.value].join("\t"));
		}
		const extra = this.#value.extra.trim();
		if (extra.length > 0) lines.push(...extra.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#")));
		const body = `${lines.join("\n")}\n`;
		const hasRows = body.split("\n").some((line) => line.length > 0 && !line.startsWith("#"));
		if (!hasRows) {
			this.#lastWrite = { path: this.cookieFilePath, rows: 0, at: Date.now() };
			return { path: this.cookieFilePath, rows: 0, at: Date.now() };
		}
		await mkdir(dirname(this.#path), { recursive: true });
		const temporary = `${this.cookieFilePath}.tmp`;
		await writeFile(temporary, body, { mode: 0o600 });
		await rename(temporary, this.cookieFilePath);
		const rows = body.split("\n").filter((line) => line.length > 0 && !line.startsWith("#")).length;
		this.#lastWrite = { path: this.cookieFilePath, rows, at: Date.now() };
		return this.#lastWrite;
	}

	/** 脱敏视图：页面只拿到名字与掩码，值要重填才会覆盖。 */
	async state() {
		await this.load();
		const sites = SITE_PRESETS.map((preset) => {
			const saved = this.#value.sites[preset.id];
			const values = new Map((saved?.cookies ?? []).map((item) => [item.name, item.value]));
			return {
				id: preset.id,
				label: preset.label,
				note: preset.note,
				domain: saved?.domain || preset.domain,
				preset: true,
				enabled: saved?.enabled === true,
				cookies: preset.keys.map((name) => ({ name, masked: mask(values.get(name) ?? ""), filled: values.has(name) }))
			};
		});
		for (const [id, saved] of Object.entries(this.#value.sites)) {
			if (SITE_PRESETS.some((preset) => preset.id === id)) continue;
			sites.push({
				id,
				label: id,
				note: "自定义站点",
				domain: saved.domain,
				preset: false,
				enabled: saved.enabled,
				cookies: saved.cookies.map((item) => ({ name: item.name, masked: mask(item.value), filled: true }))
			});
		}
		let cookieFile = { exists: false, bytes: 0, path: this.cookieFilePath };
		try {
			const info = await stat(this.cookieFilePath);
			cookieFile = { exists: true, bytes: info.size, path: this.cookieFilePath };
		} catch {
			// 还没生成过文件
		}
		return {
			configPath: this.#path,
			cookieFile,
			browser: this.#value.browser,
			sites,
			extra: { filled: this.#value.extra.trim().length > 0, lines: this.#value.extra.trim() ? this.#value.extra.trim().split(/\r?\n/).length : 0 },
			authority: this.#value.browser.from !== "off" ? `browser:${this.#value.browser.name}` : cookieFile.exists ? "cookies.txt" : "none"
		};
	}
}

export { mask };
