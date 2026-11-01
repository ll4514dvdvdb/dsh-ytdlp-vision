import assert from "node:assert/strict";
import { test } from "node:test";

import { BROWSER_CHOICES, SITE_PRESETS, domainMatches, findPreset, isSatisfied, siteFromUrl } from "../panel/sites.js";

test("站点预设健全", () => {
	assert.ok(SITE_PRESETS.length >= 15, `预设太少：${SITE_PRESETS.length}`);
	const ids = new Set();
	for (const site of SITE_PRESETS) {
		assert.ok(site.id && site.label && site.loginUrl, `缺字段：${site.id}`);
		assert.ok(Array.isArray(site.domains) && site.domains.length > 0, `${site.id} 没有 domains`);
		assert.ok(!ids.has(site.id), `id 重复：${site.id}`);
		ids.add(site.id);
		assert.match(site.loginUrl, /^https:\/\//, `${site.id} 的 loginUrl 不是 https`);
	}
	assert.deepEqual(BROWSER_CHOICES.slice(0, 2), ["off", "edge"]);
	assert.equal(findPreset("bilibili")?.label, "哔哩哔哩");
	assert.equal(findPreset("不存在"), undefined);
});

test("domainMatches 双向后缀", () => {
	const bili = [".bilibili.com"];
	assert.equal(domainMatches(".bilibili.com", bili), true);
	assert.equal(domainMatches("bilibili.com", bili), true);
	assert.equal(domainMatches("www.bilibili.com", bili), true);
	assert.equal(domainMatches("api.bilibili.com", bili), true);
	assert.equal(domainMatches(".evilbilibili.com", bili), false);
	assert.equal(domainMatches("youtube.com", bili), false);
	assert.equal(domainMatches("", bili), false);
	assert.equal(domainMatches(".bilibili.com", []), false);
});

test("siteFromUrl 认预设、猜不到就造 custom", () => {
	assert.equal(siteFromUrl("https://www.bilibili.com")?.id, "bilibili");
	assert.equal(siteFromUrl("https://www.youtube.com/watch?v=x")?.id, "youtube");
	assert.equal(siteFromUrl("https://x.com/home")?.id, "twitter");
	const custom = siteFromUrl("https://video.example.co.uk/watch/1");
	assert.ok(custom, "应该现造一个 custom");
	assert.equal(custom.id, "example-co-uk");
	assert.deepEqual(custom.domains, [".example.co.uk"]);
	assert.deepEqual(custom.need, { all: [], any: [] });
	assert.equal(siteFromUrl("ftp://example.com"), null);
	assert.equal(siteFromUrl("不是链接"), null);
});

test("isSatisfied 只认关键项，空 need 永远 false", () => {
	const bili = findPreset("bilibili");
	assert.equal(isSatisfied(bili, ["SESSDATA", "buvid3"]), true);
	assert.equal(isSatisfied(bili, ["buvid3", "bili_jct"]), false);
	assert.equal(isSatisfied(bili, new Set(["SESSDATA"])), true);

	const custom = { need: { all: [], any: [] } };
	assert.equal(isSatisfied(custom, ["SESSDATA", "auth_token"]), false);

	const anyOnly = { need: { all: [], any: ["a", "b"] } };
	assert.equal(isSatisfied(anyOnly, ["b"]), true);
	assert.equal(isSatisfied(anyOnly, ["c"]), false);

	const both = { need: { all: ["a"], any: ["b", "c"] } };
	assert.equal(isSatisfied(both, ["a", "c"]), true);
	assert.equal(isSatisfied(both, ["a"]), false);
});
