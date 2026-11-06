// eslint 配置：只查「静态上会出错」的问题，不做风格检查。
//
// 与 .ruff.toml 同一思路：这个仓库是紧凑风格手写代码，
// 引入 stylistic 规则会产出大量与正确性无关的噪声。
//
// 刻意不 `import "@eslint/js"`：eslint 可能装在 tests/.tools/node_modules、
// 项目根 node_modules 或全局，配置文件本身不应该依赖包的解析位置，
// 这样本地与 CI 跑的是同一份规则。
//
// 跑法：
//   node tests/.tools/node_modules/eslint/bin/eslint.js .
// 或用 npx：npx --yes eslint@10 .

const NODE_GLOBALS = {
	process: "readonly", Buffer: "readonly", console: "readonly",
	URL: "readonly", URLSearchParams: "readonly",
	TextEncoder: "readonly", TextDecoder: "readonly",
	setTimeout: "readonly", clearTimeout: "readonly",
	setInterval: "readonly", clearInterval: "readonly",
	setImmediate: "readonly", clearImmediate: "readonly",
	queueMicrotask: "readonly", structuredClone: "readonly",
	fetch: "readonly", AbortController: "readonly", AbortSignal: "readonly",
	Blob: "readonly", crypto: "readonly", performance: "readonly",
	WebSocket: "readonly", EventSource: "readonly", MessageChannel: "readonly",
	globalThis: "readonly",
};

const BROWSER_GLOBALS = {
	window: "readonly", document: "readonly", navigator: "readonly",
	location: "readonly", localStorage: "readonly", sessionStorage: "readonly",
	history: "readonly", screen: "readonly",
	Event: "readonly", CustomEvent: "readonly", HTMLElement: "readonly", Node: "readonly",
	requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly",
	requestIdleCallback: "readonly",
	File: "readonly", FileReader: "readonly", Image: "readonly", DOMParser: "readonly",
	MutationObserver: "readonly", IntersectionObserver: "readonly", ResizeObserver: "readonly",
	confirm: "readonly", alert: "readonly", prompt: "readonly", open: "readonly",
	btoa: "readonly", atob: "readonly", matchMedia: "readonly",
};

export default [
	{
		ignores: [
			"vendor/**",
			"node_modules/**",
			"tests/.tools/**",
			"tests/.npm-cache/**",
			"tests/.tmp-*/**",
			".tmp-*/**",
		],
	},
	{
		files: ["**/*.js", "**/*.mjs"],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: "module",
			globals: { ...NODE_GLOBALS, ...BROWSER_GLOBALS },
		},
		rules: {
			// 真会导致运行期错误
			"no-undef": "error",
			"no-dupe-keys": "error",
			"no-dupe-args": "error",
			"no-dupe-class-members": "error",
			"no-func-assign": "error",
			"no-unreachable": "error",
			"no-constant-condition": ["error", { checkLoops: false }],
			"no-fallthrough": "error",
			"no-redeclare": "error",
			"no-self-assign": "error",
			"no-self-compare": "error",
			"no-useless-catch": "error",
			"no-async-promise-executor": "error",
			"valid-typeof": "error",
			"use-isnan": "error",
			"no-cond-assign": ["error", "except-parens"],
			"no-unsafe-negation": "error",
			"no-unsafe-optional-chaining": "error",
			"no-prototype-builtins": "error",
			"no-empty": ["error", { allowEmptyCatch: true }],
			"no-control-regex": "off",
			// 未使用的变量/导入：错误级别，避免死代码堆积
			"no-unused-vars": ["error", { args: "after-used", caughtErrors: "none", ignoreRestSiblings: true }],
		},
	},
];
