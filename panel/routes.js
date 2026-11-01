// 面板的 HTTP 面：一个 `webServer` 前缀路由同时提供静态页面和 JSON API。
//
// 与 DSH GUI 同源，iframe 不需要 CORS、不需要第二个端口、URL 里也不带 token。
// 防护沿用 clash-proxy 的做法：只认 loopback，且 API 要求自定义请求头（跨站页面
// 无法在不触发预检的情况下带上它，而这条路由不实现预检）。
import { promises as fs } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const PREFIX = "/ytdlp-vision-panel";

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".json": "application/json; charset=utf-8",
	".ico": "image/x-icon"
};

function isLoopbackRequest(req) {
	const host = String(req.headers.host ?? "").toLowerCase();
	const name = host.replace(/:\d+$/, "");
	return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

function sendJson(res, status, payload) {
	if (res.headersSent) return;
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
}

function sendText(res, status, text) {
	if (res.headersSent) return;
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
	res.end(text);
}

function readBody(req, limit = 256 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				resolve({});
			}
		});
		req.on("error", reject);
	});
}

async function serveStatic(res, pathname) {
	const relative = pathname.replace(PREFIX, "").replace(/^\/+/, "") || "index.html";
	const target = normalize(join(WEB_ROOT, relative));
	const root = WEB_ROOT.endsWith(sep) ? WEB_ROOT : `${WEB_ROOT}${sep}`;
	if (!target.startsWith(root) && target !== join(WEB_ROOT, "index.html")) {
		sendText(res, 403, "forbidden");
		return;
	}
	let body;
	try {
		body = await fs.readFile(target);
	} catch {
		if (extname(relative).length > 0) {
			sendText(res, 404, "not found");
			return;
		}
		body = await fs.readFile(join(WEB_ROOT, "index.html"));
	}
	res.writeHead(200, {
		"content-type": MIME[extname(target)] ?? "application/octet-stream",
		"content-length": body.length,
		"cache-control": "no-store"
	});
	res.end(body);
}

/** B 站登录态探测：优先直连，被风控(412)时再走系统代理。 */
async function probeBilibili(sessdata) {
	if (!sessdata) return { ok: false, error: "还没填 SESSDATA" };
	const attempt = async (options) => {
		const response = await fetch("https://api.bilibili.com/x/web-interface/nav", {
			...options,
			headers: {
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
				referer: "https://www.bilibili.com/",
				cookie: `SESSDATA=${sessdata}`
			},
			signal: AbortSignal.timeout(12000)
		});
		return { status: response.status, body: await response.json().catch(() => null) };
	};
	let result;
	try {
		result = await attempt({});
	} catch (error) {
		result = { status: 0, body: null, error: String(error?.message ?? error) };
	}
	if (result.status === 412 || result.status === 0) {
		// 风控页或连不上：交给系统代理再试一次（Node 默认读取 HTTP(S)_PROXY 需要 dispatcher，这里直接给出提示）。
		return { ok: false, status: result.status, error: result.error ?? "B 站直连被风控(412)；请关掉全局代理后重试，或用代理直连 B 站" };
	}
	const body = result.body;
	if (!body || body.code !== 0) {
		return { ok: false, status: result.status, error: body ? `接口返回 ${body.code} ${body.message ?? ""}`.trim() : "响应不是 JSON" };
	}
	const data = body.data ?? {};
	return {
		ok: data.isLogin === true,
		status: result.status,
		detail: data.isLogin === true ? `已登录：${data.uname ?? "?"}（等级 ${data.level ?? "?"}）` : "SESSDATA 无效或已过期（isLogin=false）"
	};
}

export function createPanelRoute(store) {
	const api = {
		"GET state": async () => store.state(),

		"POST site": async (body) => {
			await store.patchSite(body.id, { enabled: body.enabled, domain: body.domain, cookies: body.cookies });
			await store.writeNetscape();
			return { state: await store.state() };
		},

		"POST site/remove": async (body) => {
			await store.removeSite(body.id);
			await store.writeNetscape();
			return { state: await store.state() };
		},

		"POST browser": async (body) => {
			await store.patchBrowser({ from: body.from, name: body.name });
			return { state: await store.state() };
		},

		"POST extra": async (body) => {
			await store.patchExtra(body.text);
			await store.writeNetscape();
			return { state: await store.state() };
		},

		"POST sync": async () => ({ state: await store.state(), file: await store.writeNetscape() }),

		"POST test": async (body) => {
			const id = String(body.id ?? "");
			if (id === "bilibili") {
				const config = await store.load();
				const sess = (config.sites.bilibili?.cookies ?? []).find((item) => item.name === "SESSDATA");
				const result = await probeBilibili(sess?.value ?? "");
				return { result };
			}
			return { result: { ok: null, detail: "该站点没有内置校验；保存后由 yt-dlp 在抓取时使用。" } };
		}
	};

	async function handle(req, res) {
		if (!isLoopbackRequest(req)) {
			sendText(res, 403, "该面板只在 loopback 上应答");
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const pathname = url.pathname.startsWith(PREFIX) ? url.pathname : PREFIX + url.pathname;
		if (!pathname.startsWith(`${PREFIX}/api/`)) {
			await serveStatic(res, pathname);
			return;
		}
		if (req.headers["x-ytdlp-vision"] === undefined) {
			sendJson(res, 403, { error: "缺少 x-ytdlp-vision 请求头" });
			return;
		}
		const endpoint = pathname.slice(`${PREFIX}/api/`.length);
		const key = `${(req.method ?? "GET").toUpperCase()} ${endpoint}`;
		const handler = api[key];
		if (handler === undefined) {
			sendJson(res, 404, { error: `未知接口 ${key}` });
			return;
		}
		try {
			const body = key.startsWith("POST ") ? await readBody(req) : {};
			sendJson(res, 200, { ok: true, ...(await handler(body)) });
		} catch (error) {
			sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	return { kind: "prefix", path: PREFIX, handler: handle };
}

export { PREFIX, WEB_ROOT };
