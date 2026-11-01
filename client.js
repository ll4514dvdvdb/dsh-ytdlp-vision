// 客户端包：一个侧栏入口 + 它打开的页面。
//
// 页面本体是同源 iframe（`/ytdlp-vision-panel/`，由本插件的 `webServer` 路由提供），
// 这样面板就是普通的 HTML/JS 应用：不用对齐 React 工具链、不用第二个端口、没有 CORS、
// URL 里也不带 token；侧栏入口和主页面位置仍按 GUI 期望的方式注册。
//
// 通过 `window.__ModuleLoader__.load({...})` 加载，和其他客户端包同一个信封；
// `react` 是平台预置模块，所以这里 `require` 可用。
window.__ModuleLoader__.load({
	id: "ytdlp-vision",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		const NS = "ytdlp-vision";
		const PANEL_ID = "ytdlp-vision";
		const PANEL_PATH = "/ytdlp-vision-panel/";

		const messages = {
			zh: { title: "视频 Cookie", page: "视频源" },
			en: { title: "Video cookies", page: "Sources" }
		};

		/** 侧栏图标：一个带播放三角的胶片格。 */
		function VisionIcon({ size }) {
			const dimension = typeof size === "number" ? size : 18;
			return h(
				"svg",
				{
					width: dimension,
					height: dimension,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.7,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }),
				h("path", { d: "M3 9h18M3 15h18M8 4v16M16 4v16" }),
				h("path", { d: "M11.2 10.4v3.2l2.6-1.6z", fill: "currentColor", stroke: "none" })
			);
		}

		/** 主页面：面板自己的文档，嵌进来。 */
		function CookiePanelPage() {
			return h(
				"div",
				{ style: { width: "100%", height: "100%", minHeight: 0, display: "flex" } },
				h("iframe", {
					src: PANEL_PATH,
					title: "ytdlp-vision panel",
					style: { flex: "1 1 auto", width: "100%", height: "100%", border: 0, background: "transparent" }
				})
			);
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.locale.register(NS, messages);
			const t = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : (key) => messages.zh[key] ?? key;

			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS, inject: () => ({}) }, CookiePanelPage)
			);
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 31, locale: NS, label: () => t("title") }, VisionIcon)
			);
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register({ name: "conversation.view", id: PANEL_ID, order: 41, locale: NS, label: () => t("page") }, CookiePanelPage)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
