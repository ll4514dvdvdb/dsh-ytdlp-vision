// 面板前端：读 store 的脱敏视图、按站点存 cookie、生成 cookies.txt。
// 全部原生 DOM，没有构建步骤——它就是 iframe 里的一个普通页面。
const ENDPOINT = "/ytdlp-vision-panel/api/";

let state = null;

async function api(path, { method = "GET", body } = {}) {
	const init = { method, headers: { "x-ytdlp-vision": "1" } };
	if (body !== undefined) {
		init.headers["content-type"] = "application/json";
		init.body = JSON.stringify(body);
	}
	const response = await fetch(ENDPOINT + path, init);
	const payload = await response.json().catch(() => ({ ok: false, error: "响应不是 JSON" }));
	if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
	return payload;
}

function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else if (key.startsWith("data-")) node.setAttribute(key, value);
		else if (key in node) node[key] = value;
		else node.setAttribute(key, value);
	}
	for (const child of children.flat()) {
		if (child === null || child === undefined) continue;
		node.append(typeof child === "string" ? document.createTextNode(child) : child);
	}
	return node;
}

let toastTimer = 0;
function toast(message, bad = false) {
	const node = document.getElementById("toast");
	node.textContent = message;
	node.hidden = false;
	node.classList.toggle("bad", bad);
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		node.hidden = true;
	}, bad ? 5200 : 2600);
}

function setStatus(card, message, kind = "") {
	const node = card.querySelector(".site-status");
	if (!node) return;
	node.textContent = message;
	node.className = `site-status${kind ? ` ${kind}` : ""}`;
}

/** 把一段文本拆成 cookie 名值对：兼容 `a=b; c=d` 和 Netscape 制表符行。 */
function parseCookies(text) {
	const out = [];
	for (const rawLine of String(text).split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.includes("\t")) {
			const parts = line.split("\t");
			if (parts.length >= 7) out.push({ name: parts[5].trim(), value: parts[6].trim() });
			continue;
		}
		for (const part of line.split(";")) {
			const index = part.indexOf("=");
			if (index <= 0) continue;
			const name = part.slice(0, index).trim();
			const value = part.slice(index + 1).trim();
			if (name && value) out.push({ name, value });
		}
	}
	return out.filter((item) => item.name && item.value);
}

function renderSite(site) {
	const card = el("div", { class: `site${site.enabled ? " active" : ""}`, "data-site": site.id });

	const toggle = el("input", { type: "checkbox", checked: site.enabled === true });
	toggle.addEventListener("change", async () => {
		card.classList.toggle("active", toggle.checked);
		try {
			const payload = await api("site", { method: "POST", body: { id: site.id, enabled: toggle.checked } });
			state = { ...state, ...payload.state };
			toast(`${site.label}：${toggle.checked ? "已启用" : "已停用"}`);
		} catch (error) {
			toggle.checked = !toggle.checked;
			toast(String(error.message ?? error), true);
		}
	});

	card.append(
		el(
			"div",
			{ class: "site-head" },
			el("div", { class: "site-title" }, el("strong", { text: site.label }), el("span", { class: "domain", text: site.domain || "—" })),
			el("label", { class: "switch" }, toggle, el("span", { text: site.enabled ? "启用中" : "未启用" }))
		)
	);

	if (site.note) card.append(el("p", { class: "site-note", text: site.note }));

	const grid = el("div", { class: "kv" });
	for (const cookie of site.cookies) {
		const input = el("input", {
			type: "password",
			"data-cookie-name": cookie.name,
			placeholder: cookie.filled ? cookie.masked : "未填写",
			autocomplete: "off",
			spellcheck: "false"
		});
		if (cookie.filled) input.classList.add("filled");
		grid.append(el("label", { text: cookie.name }), input);
	}
	if (site.cookies.length === 0) grid.append(el("label", { text: "—" }), el("span", { class: "muted", text: "还没有字段，先把整串粘贴进来解析" }));
	card.append(grid);

	const save = el("button", { type: "button", text: "保存" });
	save.addEventListener("click", async () => {
		const cookies = [];
		for (const input of card.querySelectorAll("input[data-cookie-name]")) {
			const value = input.value.trim();
			if (value === "") continue;
			cookies.push({ name: input.dataset.cookieName, value });
		}
		if (cookies.length === 0 && site.preset) {
			setStatus(card, "没有新值可存；输入框留空表示不修改", "bad");
			return;
		}
		try {
			save.disabled = true;
			const payload = await api("site", { method: "POST", body: { id: site.id, enabled: true, cookies } });
			state = { ...state, ...payload.state };
			renderAll();
			toast(`${site.label} 已保存（${cookies.length} 个字段）`);
		} catch (error) {
			setStatus(card, String(error.message ?? error), "bad");
		} finally {
			save.disabled = false;
		}
	});

	const test = el("button", { type: "button", class: "ghost", text: "验证登录" });
	test.addEventListener("click", async () => {
		try {
			test.disabled = true;
			setStatus(card, "正在验证…");
			const payload = await api("test", { method: "POST", body: { id: site.id } });
			const result = payload.result ?? {};
			setStatus(card, result.detail || result.error || "无结果", result.ok === true ? "ok" : result.ok === false ? "bad" : "");
		} catch (error) {
			setStatus(card, String(error.message ?? error), "bad");
		} finally {
			test.disabled = false;
		}
	});

	const clear = el("button", { type: "button", class: "danger", text: "清空" });
	clear.addEventListener("click", async () => {
		if (!confirm(`清空 ${site.label} 的全部 cookie？此操作不可撤销。`)) return;
		try {
			const payload = await api("site/remove", { method: "POST", body: { id: site.id } });
			state = { ...state, ...payload.state };
			renderAll();
			toast(`${site.label} 已清空`);
		} catch (error) {
			toast(String(error.message ?? error), true);
		}
	});

	const foot = el("div", { class: "site-foot" }, save, test, clear, el("span", { class: "site-status" }));
	if (!site.preset) foot.classList.add("custom");
	card.append(foot);
	return card;
}

function renderAll() {
	document.getElementById("path-inline").textContent = state.configPath ?? "~/.dsh/ytdlp-vision/cookies.json";

	const authority = state.authority ?? "none";
	const authorityText = {
		none: "还没有任何 cookie 配置（B 站按未登录处理）",
		"cookies.txt": "yt-dlp 使用 cookies.txt（由本页生成）",
		browser: `yt-dlp 使用浏览器直读：${state.browser?.name ?? ""}`
	}[authority.startsWith("browser:") ? "browser" : authority] ?? authority;
	document.getElementById("authority-line").textContent = authorityText;

	const pill = document.getElementById("file-pill");
	const file = state.cookieFile ?? {};
	if (file.exists) {
		pill.textContent = `cookies.txt · ${file.bytes} B`;
		pill.className = "pill ok";
	} else {
		pill.textContent = "尚未生成 cookies.txt";
		pill.className = "pill";
	}

	const host = document.getElementById("sites");
	host.replaceChildren(...state.sites.map(renderSite));

	const select = document.getElementById("paste-site");
	const current = select.value;
	select.replaceChildren(
		...state.sites.map((site) => {
			const option = el("option", { value: site.id, text: site.label });
			if (site.id === current) option.selected = true;
			return option;
		})
	);

	document.getElementById("browser-from").value = state.browser?.from ?? "off";
	document.getElementById("sync-hint").textContent = file.exists ? `${file.path}` : "生成后 yt-dlp 会自动带上 --cookies";
}

async function load() {
	try {
		const payload = await api("state");
		state = payload;
		renderAll();
	} catch (error) {
		document.getElementById("authority-line").textContent = `读取失败：${error.message ?? error}`;
		document.getElementById("authority-line").style.color = "var(--bad)";
	}
}

document.getElementById("btn-refresh").addEventListener("click", () => load());

document.getElementById("btn-parse").addEventListener("click", async () => {
	const siteId = document.getElementById("paste-site").value;
	const text = document.getElementById("paste-input").value;
	const result = document.getElementById("paste-result");
	const cookies = parseCookies(text);
	if (cookies.length === 0) {
		result.textContent = "没解析出任何 name=value，检查一下格式。";
		return;
	}
	try {
		const payload = await api("site", { method: "POST", body: { id: siteId, enabled: true, cookies } });
		state = { ...state, ...payload.state };
		renderAll();
		result.textContent = `已写入 ${cookies.length} 个字段：${cookies.map((item) => item.name).join(", ")}`;
		document.getElementById("paste-input").value = "";
	} catch (error) {
		result.textContent = `保存失败：${error.message ?? error}`;
	}
});

document.getElementById("btn-browser").addEventListener("click", async () => {
	const from = document.getElementById("browser-from").value;
	try {
		const payload = await api("browser", { method: "POST", body: { from, name: from } });
		state = { ...state, ...payload.state };
		renderAll();
		toast(from === "off" ? "已关闭浏览器直读" : `已改用浏览器直读：${from}`);
	} catch (error) {
		toast(String(error.message ?? error), true);
	}
});

document.getElementById("btn-extra").addEventListener("click", async () => {
	const text = document.getElementById("extra-input").value;
	try {
		const payload = await api("extra", { method: "POST", body: { text } });
		state = { ...state, ...payload.state };
		renderAll();
		toast(text.trim() ? "额外行已保存" : "额外行已清空");
	} catch (error) {
		toast(String(error.message ?? error), true);
	}
});

document.getElementById("btn-sync").addEventListener("click", async () => {
	try {
		const payload = await api("sync", { method: "POST" });
		state = { ...state, ...payload.state };
		renderAll();
		const rows = payload.file?.rows ?? 0;
		toast(rows > 0 ? `已生成 cookies.txt（${rows} 行）` : "没有启用任何站点，未生成文件");
	} catch (error) {
		toast(String(error.message ?? error), true);
	}
});

document.getElementById("btn-custom").addEventListener("click", async () => {
	const id = document.getElementById("custom-id").value.trim();
	const domain = document.getElementById("custom-domain").value.trim();
	if (!/^[a-z0-9._-]{1,40}$/i.test(id)) {
		toast("id 只能用字母、数字、点、下划线、连字符（1-40 字符）", true);
		return;
	}
	try {
		const payload = await api("site", { method: "POST", body: { id, domain, enabled: true, cookies: [] } });
		state = { ...state, ...payload.state };
		renderAll();
		document.getElementById("custom-id").value = "";
		document.getElementById("custom-domain").value = "";
		toast(`已添加站点 ${id}`);
	} catch (error) {
		toast(String(error.message ?? error), true);
	}
});

load();
