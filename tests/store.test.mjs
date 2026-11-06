// CookieStore 的安全/一致性回归测试（离线，不碰真实 cookie）。
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CookieStore } from "../panel/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let seq = 0;

async function freshStore() {
	seq += 1;
	const dir = join(HERE, ".tmp-store", `case-${process.pid}-${seq}`);
	await mkdir(dir, { recursive: true });
	return { dir, store: new CookieStore({ path: join(dir, "cookies.json") }) };
}

test("netscape 的 secure 列跟随 cookie，而不是恒 TRUE", async () => {
	const { dir, store } = await freshStore();
	try {
		await store.patchSite("bilibili", {
			enabled: true,
			cookies: [
				{ name: "SESSDATA", value: "abc" },
				{ name: "secure_one", value: "xyz", secure: true }
			]
		});
		await store.writeNetscape();
		const body = await readFile(join(dir, "cookies.txt"), "utf8");
		const rows = body.split("\n").filter((line) => line && !line.startsWith("#"));
		assert.equal(rows.length, 2);
		for (const row of rows) assert.equal(row.split("\t").length, 7, `列数不对：${row}`);
		const byName = Object.fromEntries(rows.map((row) => {
			const cols = row.split("\t");
			return [cols[5], cols[3]];
		}));
		assert.equal(byName.SESSDATA, "FALSE");
		assert.equal(byName.secure_one, "TRUE");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("导入时剔除控制字符，不产生额外行", async () => {
	const { dir, store } = await freshStore();
	try {
		await store.patchSite("bilibili", {
			enabled: true,
			cookies: [{ name: "SESSDATA", value: "abc\r\n.evil.com\tTRUE\t/\tTRUE\t1\tn\tv" }]
		});
		await store.writeNetscape();
		const rows = (await readFile(join(dir, "cookies.txt"), "utf8"))
			.split("\n").filter((line) => line && !line.startsWith("#"));
		assert.equal(rows.length, 1);
		const cols = rows[0].split("\t");
		assert.equal(cols.length, 7);
		// 注入内容只能留在值里，不能变成新的域/行
		assert.equal(cols[0], ".bilibili.com");
		assert.equal(cols[5], "SESSDATA");
		assert.ok(!rows[0].startsWith(".evil.com"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("__proto__ 之类的站点 id 被拒绝", async () => {
	const { dir, store } = await freshStore();
	try {
		await assert.rejects(() => store.patchSite("__proto__", { enabled: true }), /不合法/);
		assert.equal({}.polluted, undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("损坏的 cookies.json 会被备份，而不是静默覆盖", async () => {
	const { dir, store } = await freshStore();
	try {
		await writeFile(join(dir, "cookies.json"), "{oops", "utf8");
		const state = await store.state();
		assert.equal(state.stats.sites, 0);
		const files = await readdir(dir);
		assert.ok(files.some((name) => name.startsWith("cookies.json.corrupt-")), files.join(","));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("外部改写后不会被内存里的旧值覆盖", async () => {
	const { dir, store } = await freshStore();
	try {
		const path = join(dir, "cookies.json");
		await store.patchSite("bilibili", { enabled: true, cookies: [{ name: "a", value: "1" }] });
		// 模拟另一个面板实例写入新站点
		const disk = JSON.parse(await readFile(path, "utf8"));
		disk.sites.youtube = { enabled: true, label: "YouTube", domains: [".youtube.com"], cookies: [{ name: "SID", value: "z" }] };
		await writeFile(path, `${JSON.stringify(disk, null, "\t")}\n`, "utf8");
		// 本实例再改一个不相关的站点，外部写入必须保留
		await store.patchSite("vimeo", { enabled: true, cookies: [{ name: "v", value: "2" }] });
		const after = JSON.parse(await readFile(path, "utf8"));
		assert.ok(after.sites.youtube, "外部新增的站点被覆盖了");
		assert.ok(after.sites.vimeo);
		assert.ok(after.sites.bilibili);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("state 只返回脱敏值", async () => {
	const { dir, store } = await freshStore();
	try {
		await store.patchSite("bilibili", { enabled: true, cookies: [{ name: "SESSDATA", value: "SECRET-VALUE-123" }] });
		const state = await store.state();
		const text = JSON.stringify(state);
		assert.ok(!text.includes("SECRET-VALUE-123"), "state 泄漏了明文 cookie");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("删光所有站点后 cookies.txt 被删除，不留凭据", async () => {
	const { dir, store } = await freshStore();
	try {
		const cookieFile = join(dir, "cookies.txt");
		await store.patchSite("bilibili", { enabled: true, cookies: [{ name: "SESSDATA", value: "abc" }] });
		await store.writeNetscape();
		assert.ok((await readdir(dir)).includes("cookies.txt"), "前置条件：cookies.txt 存在");

		await store.removeSite("bilibili");
		// removeSite 会自动重生成；无可用行时必须删掉旧文件
		assert.ok(!(await readdir(dir)).includes("cookies.txt"), "站点删光后 cookies.txt 还在");
		await assert.rejects(() => readFile(cookieFile, "utf8"), /ENOENT/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("删除一个站点后 cookies.txt 不再包含它的凭据", async () => {
	const { dir, store } = await freshStore();
	try {
		await store.patchSite("bilibili", { enabled: true, cookies: [{ name: "SESSDATA", value: "bili-secret" }] });
		await store.patchSite("youtube", { enabled: true, cookies: [{ name: "SID", value: "yt-secret" }] });
		await store.writeNetscape();
		const before = await readFile(join(dir, "cookies.txt"), "utf8");
		assert.ok(before.includes("bili-secret") && before.includes("yt-secret"));

		await store.removeSite("bilibili");
		const after = await readFile(join(dir, "cookies.txt"), "utf8");
		assert.ok(!after.includes("bili-secret"), "被删站点的 cookie 仍留在 cookies.txt");
		assert.ok(!after.includes(".bilibili.com"), "被删站点的域仍留在 cookies.txt");
		assert.ok(after.includes("yt-secret"), "未删站点的 cookie 被误删");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
