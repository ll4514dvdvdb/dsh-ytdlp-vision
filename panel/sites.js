// 站点清单：页面展示、自动抓取判定、Netscape 域名都从这一份定义里来。
//
// need.all   —— 全部出现才算登录成功
// need.any   —— 出现任意一个就算登录成功（all 与 any 同时给时两者都要满足）
// 两者都为空 = 无法自动判定，只保留手动「保存并关闭」。
// keys 只是页面上的推荐字段，真正落盘的是抓到的全部 cookie。

export const SITE_PRESETS = [
	{
		id: "bilibili",
		label: "哔哩哔哩",
		domains: [".bilibili.com"],
		loginUrl: "https://www.bilibili.com",
		need: { all: ["SESSDATA"], any: [] },
		keys: ["SESSDATA", "bili_jct", "buvid3", "DedeUserID"],
		note: "SESSDATA 必填；bili_jct / buvid3 一并填更稳（1080P 与 CC 字幕都要登录态）。"
	},
	{
		id: "youtube",
		label: "YouTube",
		domains: [".youtube.com"],
		loginUrl: "https://www.youtube.com",
		need: { all: [], any: ["SID", "SAPISID", "__Secure-3PSID", "SSID"] },
		keys: ["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "LOGIN_INFO"],
		note: "会员/年龄限制视频才需要。最少给 SID + HSID + SSID + APISID + SAPISID。"
	},
	{
		id: "twitter",
		label: "X / Twitter",
		domains: [".x.com", ".twitter.com"],
		loginUrl: "https://x.com",
		need: { all: ["auth_token"], any: [] },
		keys: ["auth_token", "ct0"],
		note: "登录后才有的视频（敏感内容、订阅账号）需要 auth_token 和 ct0。"
	},
	{
		id: "douyin",
		label: "抖音",
		domains: [".douyin.com"],
		loginUrl: "https://www.douyin.com",
		need: { all: [], any: ["sessionid", "sessionid_ss"] },
		keys: ["sessionid", "sessionid_ss", "ttwid", "odin_tt", "msToken"],
		note: "部分作品要 sessionid；不填也能抓公开视频。"
	},
	{
		id: "tiktok",
		label: "TikTok",
		domains: [".tiktok.com"],
		loginUrl: "https://www.tiktok.com",
		need: { all: [], any: ["sessionid", "sid_tt"] },
		keys: ["sessionid", "sid_tt", "msToken", "tt_webid"],
		note: "地区限制或私密视频才需要。"
	},
	{
		id: "twitch",
		label: "Twitch",
		domains: [".twitch.tv"],
		loginUrl: "https://www.twitch.tv",
		need: { all: ["auth-token"], any: [] },
		keys: ["auth-token", "persistent"],
		note: "订阅频道、被拒的 VOD 才需要；auth-token 值以 %22 包裹是正常的。"
	},
	{
		id: "instagram",
		label: "Instagram",
		domains: [".instagram.com"],
		loginUrl: "https://www.instagram.com",
		need: { all: [], any: ["sessionid", "ds_user_id"] },
		keys: ["sessionid", "ds_user_id", "csrftoken"],
		note: "非公开账号、登录后可见内容才需要。"
	},
	{
		id: "facebook",
		label: "Facebook",
		domains: [".facebook.com"],
		loginUrl: "https://www.facebook.com",
		need: { all: ["c_user"], any: [] },
		keys: ["c_user", "xs"],
		note: "私密视频与年龄限制内容才需要。"
	},
	{
		id: "vimeo",
		label: "Vimeo",
		domains: [".vimeo.com"],
		loginUrl: "https://vimeo.com",
		need: { all: ["vimeo"], any: [] },
		keys: ["vimeo", "is_logged_in"],
		note: "付费或密码视频才需要。"
	},
	{
		id: "acfun",
		label: "AcFun",
		domains: [".acfun.cn"],
		loginUrl: "https://www.acfun.cn",
		need: { all: [], any: ["acPasstoken", "acPlatform"] },
		keys: ["acPasstoken", "acPlatform", "auth_key"],
		note: "高清晰度与部分会员视频需要。"
	},
	{
		id: "xiaohongshu",
		label: "小红书",
		domains: [".xiaohongshu.com"],
		loginUrl: "https://www.xiaohongshu.com",
		need: { all: [], any: ["web_session", "a1"] },
		keys: ["web_session", "a1", "webId"],
		note: "未登录时大量笔记拿不到视频直链。"
	},
	{
		id: "weibo",
		label: "微博",
		domains: [".weibo.com", ".weibo.cn"],
		loginUrl: "https://weibo.com",
		need: { all: ["SUB"], any: [] },
		keys: ["SUB", "SUBP"],
		note: "登录后可见的视频才需要。"
	},
	{
		id: "reddit",
		label: "Reddit",
		domains: [".reddit.com"],
		loginUrl: "https://www.reddit.com",
		need: { all: [], any: ["reddit_session", "token_v2"] },
		keys: ["reddit_session", "token_v2"],
		note: "NSFW / 私有 sub 才需要。"
	},
	{
		id: "niconico",
		label: "niconico",
		domains: [".nicovideo.jp"],
		loginUrl: "https://www.nicovideo.jp",
		need: { all: ["user_session"], any: [] },
		keys: ["user_session"],
		note: "付费会员画质与部分受限视频需要。"
	},
	{
		id: "dailymotion",
		label: "Dailymotion",
		domains: [".dailymotion.com"],
		loginUrl: "https://www.dailymotion.com",
		need: { all: [], any: ["auth"] },
		keys: ["auth", "sid"],
		note: "私有与地区限制视频才需要。"
	}
];

export const BROWSER_CHOICES = ["off", "edge", "chrome", "chromium", "firefox", "brave", "safari"];

export function findPreset(id) {
	return SITE_PRESETS.find((item) => item.id === id);
}

/** 抓到的 cookie 域是否属于站点声明的域（任一方向是后缀都算，兼顾 www 与根域）。 */
export function domainMatches(cookieDomain, siteDomains) {
	const raw = String(cookieDomain ?? "").replace(/^\./, "").toLowerCase();
	if (raw.length === 0) return false;
	for (const item of siteDomains) {
		const target = String(item ?? "").replace(/^\./, "").toLowerCase();
		if (target.length === 0) continue;
		if (raw === target || raw.endsWith(`.${target}`) || target.endsWith(`.${raw}`)) return true;
	}
	return false;
}

/** 二级公共后缀，取可注册域时要多留一段（video.example.co.uk → example.co.uk）。 */
const SECOND_LEVEL = new Set([
	"co.uk",
	"com.cn",
	"com.hk",
	"com.tw",
	"com.sg",
	"com.au",
	"com.br",
	"co.jp",
	"co.kr",
	"co.in",
	"co.nz"
]);

function registrableDomain(parts) {
	const tail2 = parts.slice(-2).join(".");
	if (SECOND_LEVEL.has(tail2) && parts.length >= 3) return parts.slice(-3).join(".");
	return tail2;
}

/** 根据登录 URL 猜站点：先按域名匹配预设，猜不到就返回从 hostname 现造的 custom 定义。 */
export function siteFromUrl(rawUrl) {
	let url;
	try {
		url = new URL(String(rawUrl ?? "").trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const host = url.hostname.toLowerCase();
	const preset = SITE_PRESETS.find((item) => domainMatches(host, item.domains));
	if (preset !== undefined) return preset;
	const parts = host.split(".").filter(Boolean);
	const base = parts.length >= 2 ? registrableDomain(parts) : host;
	const id = base.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "custom";
	return {
		id,
		label: base,
		domains: [`.${base}`],
		loginUrl: `${url.protocol}//${host}`,
		need: { all: [], any: [] },
		keys: [],
		note: "未收录的站点：登录后手动点「保存并关闭」。"
	};
}

/** 登录态判定：need 全空时永远返回 false（交给手动按钮）。 */
export function isSatisfied(site, cookieNames) {
	const all = site?.need?.all ?? [];
	const any = site?.need?.any ?? [];
	if (all.length === 0 && any.length === 0) return false;
	const names = cookieNames instanceof Set ? cookieNames : new Set(cookieNames);
	if (!all.every((name) => names.has(name))) return false;
	if (any.length > 0 && !any.some((name) => names.has(name))) return false;
	return true;
}
