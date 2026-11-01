(function () {
	"use strict";

	const ENDPOINT = "/ytdlp-vision-panel/api/";
	const HEADER = { "x-ytdlp-vision": "1" };

	const el = (id) => document.getElementById(id);
	const $authority = el("authority-line");
	const $filePill = el("file-pill");
	const $siteList = el("site-list");
	const $siteStats = el("site-stats");
	const $grabAvailability = el("grab-availability");
	const $grabCard = el("grab-status");
	const $grabSite = el("grab-site");
	const $grabUrl = el("grab-url");
	const $grabCount = el("grab-count");
	const $grabMessage = el("grab-message");
	const $grabNames = el("grab-names");
	const $modal = el("modal");
	const $modalUrl = el("modal-url");
	const $modalPresets = el("modal-presets");
	const $modalNote = el("modal-note");
	const $toast = el("toast");

	let state = null;
	let presets = [];
	let grab = { status: "idle" };
	let pollTimer = null;
	let lastGrabStatus = "idle";

	async function api(path, body) {
		const options = { headers: { ...HEADER }, cache: "no-store" };
		if (body !== undefined) {
			options.method = "POST";
			options.headers["content-type"] = "application/json";
			options.body = JSON.stringify(body);
		}
		const response = await fetch(ENDPOINT + path, options);
		const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
		if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`);
		return payload;
	}

	let toastTimer = null;
	function toast(text, kind) {
		$toast.textContent = text;
		$toast.className = `toast ${kind ?? ""}`;
		$toast.hidden = false;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			$toast.hidden = true;
		}, 3200);
	}

	function fmtTime(ms) {
		if (!Number.isFinite(ms) || ms <= 0) return "";
		const date = new Date(ms);
		const pad = (n) => String(n).padStart(2, "0");
		return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}

	function escapeHtml(text) {
		return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
	}

	/* ---------- 渲染 ---------- */

	function renderTop() {
		const file = state?.cookieFile ?? {};
		$filePill.textContent = file.exists ? `cookies.txt · ${file.bytes} B` : "尚未生成 cookies.txt";
		$filePill.classList.toggle("ok", file.exists === true);
		const stats = state?.stats ?? { sites: 0, cookies: 0 };
		if (state?.browser?.from && state.browser.from !== "off") {
			$authority.textContent = `yt-dlp 使用浏览器直读：${state.browser.name}`;
		} else if (stats.cookies > 0) {
			$authority.textContent = `共 ${stats.cookies} 个 cookie，来自 ${stats.sites} 个站点`;
		} else {
			$authority.textContent = "还没有任何 cookie 配置（B 站按未登录处理）";
		}
		$siteStats.textContent = stats.cookies > 0 ? `${stats.sites} 个站点 · ${stats.cookies} 个 cookie` : "空";
		el("path-inline").textContent = state?.configPath ?? "…";
	}

	function cookieRow(item) {
		const domain = item.domain ? ` <span class="muted">${escapeHtml(item.domain)}</span>` : "";
		return `<li><code>${escapeHtml(item.name)}</code><span class="val">${escapeHtml(item.masked)}</span>${domain}</li>`;
	}

	function renderSites() {
		const all = state?.sites ?? [];
		// 未填又没启用的预设不占地方，否则一进页面就是十几行空站点。
		const sites = all.filter((site) => site.total > 0 || site.enabled || site.preset !== true);
		if (sites.length === 0) {
			$siteList.innerHTML = '<p class="empty">还没有保存任何站点。点上面的「生成新的 Cookies」开始。</p>';
			return;
		}
		$siteList.innerHTML = sites
			.map((site) => {
				const source = site.source === "grab" ? "自动抓取" : "手动";
				const stamp = fmtTime(site.updatedAt);
				const meta = [site.total > 0 ? `${site.total} 个` : "未填", source, stamp].filter(Boolean).join(" · ");
				const body =
					site.total === 0
						? '<p class="empty small">还没有值。点「生成」自动抓，或展开「手动填写」。</p>'
						: `<ul class="kv-list">${site.cookies.map(cookieRow).join("")}</ul>`;
				return `
				<div class="site" data-id="${escapeHtml(site.id)}">
					<div class="site-row">
						<div class="site-name">
							<strong>${escapeHtml(site.label)}</strong>
							<span class="muted">${escapeHtml((site.domains ?? []).join(" "))}</span>
							<span class="muted">${escapeHtml(meta)}</span>
						</div>
						<div class="site-actions">
							<label class="switch" title="是否写进 cookies.txt">
								<input type="checkbox" data-act="toggle" ${site.enabled ? "checked" : ""} />
								<span></span>
							</label>
							<button class="ghost small" type="button" data-act="test">验证登录</button>
							<button class="danger small" type="button" data-act="remove">删除</button>
						</div>
					</div>
					<details>
						<summary>${site.total > 0 ? `查看 ${site.total} 个 cookie` : "查看"}</summary>
						${body}
					</details>
				</div>`;
			})
			.join("");
	}

	function renderPasteSites() {
		const select = el("paste-site");
		const current = select.value;
		select.innerHTML = (state?.sites ?? [])
			.map((site) => `<option value="${escapeHtml(site.id)}">${escapeHtml(site.label)}</option>`)
			.join("");
		if (current) select.value = current;
	}

	async function load() {
		const payload = await api("state");
		state = payload.state;
		presets = payload.presets ?? [];
		grab = payload.grab ?? { status: "idle" };
		const availability = payload.browser ?? {};
		$grabAvailability.textContent = availability.ok
			? `将使用本机 ${availability.label}（独立 profile，首次需要登录一次）`
			: `${availability.reason ?? "浏览器不可用"}：自动抓取用不了，请用下面的手动填写。`;
		el("btn-grab").disabled = availability.ok !== true;
		renderTop();
		renderSites();
		renderPasteSites();
		el("browser-from").value = state?.browser?.from ?? "off";
		renderGrab();
	}

	/* ---------- 自动抓取 ---------- */

	function renderGrab() {
		const status = grab?.status ?? "idle";
		const active = ["launching", "waiting", "saving"].includes(status);
		const finished = ["done", "closed", "cancelled"].includes(status);
		$grabCard.hidden = !active && !finished;
		if ($grabCard.hidden) return;
		$grabSite.textContent = grab.siteLabel ?? grab.siteId ?? "等待登录…";
		$grabUrl.textContent = grab.url ?? "";
		const count = grab.cookies?.count ?? 0;
		$grabCount.textContent = `${count} 个 cookie`;
		$grabCount.classList.toggle("pulse", active);
		$grabMessage.textContent = grab.message ?? "";
		const names = grab.cookies?.names ?? [];
		$grabNames.innerHTML = names.map((name) => `<span class="chip">${escapeHtml(name)}</span>`).join("");
		el("btn-grab-save").disabled = !active;
		el("btn-grab-cancel").disabled = !active;
		const expected = grab.cookies?.expected ?? [];
		if (active && expected.length > 0 && grab.cookies?.auto) {
			const have = new Set(names);
			const missing = expected.filter((name) => !have.has(name));
			el("grab-tip").textContent = missing.length > 0 ? `还差：${missing.join(" / ")}` : "已识别到登录态";
		} else if (active && grab.cookies?.auto === false) {
			el("grab-tip").textContent = "该站点没有自动判定，登录后直接点「保存并关闭」";
		} else {
			el("grab-tip").textContent = "";
		}
	}

	async function pollGrab() {
		clearTimeout(pollTimer);
		try {
			const payload = await api("grab/status");
			grab = payload.grab ?? { status: "idle" };
		} catch (error) {
			pollTimer = setTimeout(pollGrab, 3000);
			return;
		}
		renderGrab();
		const status = grab.status;
		if (["launching", "waiting", "saving"].includes(status)) {
			pollTimer = setTimeout(pollGrab, 1200);
			return;
		}
		if (status !== lastGrabStatus) {
			lastGrabStatus = status;
			if (status === "done") toast(grab.message ?? "已保存", "ok");
			else if (status === "closed" || status === "cancelled") toast(grab.message ?? "已结束");
			await load().catch(() => {});
			setTimeout(() => {
				$grabCard.hidden = true;
			}, 2600);
		}
	}

	function openModal() {
		$modal.hidden = false;
		$modalUrl.value = "";
		$modalNote.textContent = "浏览器打开后请在里面登录；识别到登录态会自动关窗保存。";
		$modalUrl.focus();
		$modalPresets.innerHTML = presets
			.map(
				(item) =>
					`<button class="chip-btn" type="button" data-url="${escapeHtml(item.loginUrl)}">${escapeHtml(item.label)}</button>`
			)
			.join("");
	}

	function closeModal() {
		$modal.hidden = true;
	}

	async function startGrab(url) {
		closeModal();
		$grabCard.hidden = false;
		$grabSite.textContent = "正在启动浏览器…";
		$grabMessage.textContent = "浏览器窗口马上会出现";
		$grabCount.textContent = "0 个 cookie";
		$grabNames.innerHTML = "";
		el("btn-grab-save").disabled = true;
		el("btn-grab-cancel").disabled = true;
		try {
			const payload = await api("grab/start", { url });
			grab = payload.grab;
			lastGrabStatus = grab.status;
			renderGrab();
			pollGrab();
		} catch (error) {
			toast(String(error.message ?? error), "err");
			$grabCard.hidden = true;
		}
	}

	/* ---------- 事件 ---------- */

	el("btn-refresh").addEventListener("click", () => load().catch((error) => toast(String(error.message ?? error), "err")));
	el("btn-grab").addEventListener("click", openModal);
	el("btn-modal-cancel").addEventListener("click", () => {
		closeModal();
		$grabCard.hidden = true;
	});
	$modal.addEventListener("click", (event) => {
		if (event.target === $modal) closeModal();
	});
	$modalPresets.addEventListener("click", (event) => {
		const button = event.target.closest("button[data-url]");
		if (!button) return;
		$modalUrl.value = button.dataset.url;
		$modalNote.textContent = `已选 ${button.textContent}，登录后会自动识别；识别不到就点「保存并关闭」。`;
	});
	el("btn-modal-go").addEventListener("click", () => {
		const url = $modalUrl.value.trim();
		if (!/^https?:\/\//i.test(url)) {
			toast("URL 要以 http:// 或 https:// 开头", "err");
			return;
		}
		startGrab(url);
	});
	$modalUrl.addEventListener("keydown", (event) => {
		if (event.key === "Enter") el("btn-modal-go").click();
	});

	el("btn-grab-save").addEventListener("click", async () => {
		try {
			const payload = await api("grab/finish");
			grab = payload.grab;
			lastGrabStatus = "done";
			toast(payload.result?.message ?? "已保存", "ok");
			await load();
			$grabCard.hidden = true;
		} catch (error) {
			toast(String(error.message ?? error), "err");
		}
	});

	el("btn-grab-cancel").addEventListener("click", async () => {
		try {
			const payload = await api("grab/cancel");
			grab = payload.grab;
			lastGrabStatus = "cancelled";
			toast("已取消，没有保存");
			await load();
			$grabCard.hidden = true;
		} catch (error) {
			toast(String(error.message ?? error), "err");
		}
	});

	$siteList.addEventListener("click", async (event) => {
		const button = event.target.closest("button[data-act]");
		if (!button) return;
		const host = button.closest(".site");
		const id = host?.dataset.id;
		if (!id) return;
		const act = button.dataset.act;
		try {
			if (act === "remove") {
				if (!confirm(`删除 ${id} 的全部 cookie？`)) return;
				await api("site/remove", { id });
				toast("已删除");
			} else if (act === "test") {
				const payload = await api("test", { id });
				const result = payload.result ?? {};
				toast(result.detail ?? result.error ?? "已提交验证", result.ok === false ? "err" : "ok");
				return;
			}
			await load();
		} catch (error) {
			toast(String(error.message ?? error), "err");
		}
	});

	$siteList.addEventListener("change", async (event) => {
		const input = event.target.closest('input[data-act="toggle"]');
		if (!input) return;
		const id = input.closest(".site")?.dataset.id;
		if (!id) return;
		try {
			await api("site", { id, enabled: input.checked });
			await load();
		} catch (error) {
			toast(String(error.message ?? error), "err");
		}
	});

	el("btn-parse").addEventListener("click", async () => {
		const text = el("paste-input").value;
		const site = el("paste-site").value;
		const cookies = parseCookies(text);
		if (cookies.length === 0) {
			el("paste-result").textContent = "没有解析出任何 name=value";
			return;
		}
		try {
			await api("site", { id: site, cookies, enabled: true, source: "manual" });
			el("paste-result").textContent = `已写入 ${cookies.length} 个字段：${cookies.map((item) => item.name).join(", ")}`;
			el("paste-input").value = "";
			toast("已保存", "ok");
			await load();
		} catch (error) {
			el("paste-result").textContent = String(error.message ?? error);
		}
	});

	function parseCookies(text) {
		const out = [];
		const seen = new Set();
		for (const rawLine of String(text ?? "").split(/\r?\n/)) {
			const line = rawLine.trim();
			if (line.length === 0 || line.startsWith("#")) continue;
			if (line.includes("\t")) {
				const cells = line.split("\t");
				if (cells.length >= 7) {
					const name = cells[5].trim();
					const value = cells[6].trim();
					if (name && !seen.has(name)) {
						seen.add(name);
						out.push({ name, value, domain: cells[0] });
					}
					continue;
				}
			}
			for (const pair of line.split(";")) {
				const at = pair.indexOf("=");
				if (at <= 0) continue;
				const name = pair.slice(0, at).trim();
				const value = pair.slice(at + 1).trim();
				if (!name || seen.has(name)) continue;
				seen.add(name);
				out.push({ name, value });
			}
		}
		return out;
	}

	el("btn-browser").addEventListener("click", async () => {
		try {
			await api("browser", { from: el("browser-from").value });
			toast("已保存", "ok");
			await load();
		} catch (error) {
			toast(String(error.message ?? error), "err");
		}
	});

	el("btn-custom").addEventListener("click", async () => {
		const id = el("custom-id").value.trim();
		const domain = el("custom-domain").value.trim();
		if (!id || !domain) {
			toast("id 和域都要填", "err");
			return;
		}
		try {
			await api("site", { id, domains: [domain], enabled: true, source: "manual" });
			el("custom-id").value = "";
			el("custom-domain").value = "";
			toast("已添加", "ok");
			await load();
		} catch (error) {
			toast(String(error.message ?? error), "err");
		}
	});

	el("btn-extra").addEventListener("click", async () => {
		try {
			await api("extra", { text: el("extra-input").value });
			toast("已保存", "ok");
			await load();
		} catch (error) {
			toast(String(error.message ?? error), "err");
		}
	});

	el("btn-sync").addEventListener("click", async () => {
		try {
			const payload = await api("sync");
			el("sync-hint").textContent = `${payload.file.rows} 行 · ${new Date(payload.file.at).toLocaleTimeString()}`;
			toast("已生成 cookies.txt", "ok");
			await load();
		} catch (error) {
			toast(String(error.message ?? error), "err");
		}
	});

	load().catch((error) => {
		$authority.textContent = `读取失败：${error.message ?? error}`;
	});
})();
