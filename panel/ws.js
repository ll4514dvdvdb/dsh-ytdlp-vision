// 极简 WebSocket 客户端（RFC 6455，仅客户端、仅文本）。
//
// 用途是连本机 Chrome 的 DevTools 端点。环境里有全局 WebSocket 时直接用官方实现，
// 没有（Electron 自带的 Node 版本偏低）就退回到这里的 net 实现，避免为了读一次
// cookie 去装 ws 依赖。
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function parseUrl(raw) {
	const url = new URL(raw);
	if (url.protocol !== "ws:") throw new Error(`只支持 ws:// 端点：${raw}`);
	return { host: url.hostname, port: Number(url.port || 80), path: `${url.pathname}${url.search}` };
}

function frame(text, opcode = 0x1) {
	const payload = Buffer.from(text, "utf8");
	const length = payload.length;
	let header;
	if (length < 126) {
		header = Buffer.alloc(6);
		header[1] = 0x80 | length;
	} else if (length < 65536) {
		header = Buffer.alloc(8);
		header[1] = 0x80 | 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(14);
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	header[0] = 0x80 | opcode;
	const mask = randomBytes(4);
	mask.copy(header, header.length - 4);
	const masked = Buffer.alloc(length);
	for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
	return Buffer.concat([header, masked]);
}

/** 打开一个 WebSocket 连接，返回 { send, onMessage, onClose, close }。 */
export function wsConnect(rawUrl, options = {}) {
	if (typeof globalThis.WebSocket === "function") return globalWs(rawUrl, options);
	return netWs(rawUrl, options);
}

function globalWs(rawUrl, { timeoutMs = 8000 } = {}) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(rawUrl);
		const listeners = new Set();
		const closers = new Set();
		const timer = setTimeout(() => {
			try {
				socket.close();
			} catch {
				// 已经关了
			}
			reject(new Error("WebSocket 连接超时"));
		}, timeoutMs);
		socket.addEventListener("open", () => {
			clearTimeout(timer);
			resolve({
				send: (text) => socket.send(text),
				onMessage: (handler) => listeners.add(handler),
				onClose: (handler) => closers.add(handler),
				close: () => {
					try {
						socket.close();
					} catch {
						// 忽略重复关闭
					}
				}
			});
		});
		socket.addEventListener("message", (event) => {
			for (const handler of listeners) handler(String(event.data));
		});
		socket.addEventListener("close", () => {
			clearTimeout(timer);
			for (const handler of closers) handler();
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error("WebSocket 连接失败"));
		});
	});
}

function netWs(rawUrl, { timeoutMs = 8000 } = {}) {
	return new Promise((resolve, reject) => {
		const { host, port, path } = parseUrl(rawUrl);
		const key = randomBytes(16).toString("base64");
		const socket = connect({ host, port });
		const listeners = new Set();
		const closers = new Set();
		let buffer = Buffer.alloc(0);
		let handshaken = false;
		let fragments = [];
		let closed = false;

		const finish = (error) => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			for (const handler of closers) handler();
		};

		const timer = setTimeout(() => finish(new Error("WebSocket 连接超时")), timeoutMs);

		const dispatch = (payload) => {
			for (const handler of listeners) handler(payload);
		};

		const parseFrames = () => {
			for (;;) {
				if (buffer.length < 2) return;
				const first = buffer[0];
				const second = buffer[1];
				const opcode = first & 0x0f;
				const fin = (first & 0x80) !== 0;
				const masked = (second & 0x80) !== 0;
				let length = second & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (buffer.length < offset + 2) return;
					length = buffer.readUInt16BE(offset);
					offset += 2;
				} else if (length === 127) {
					if (buffer.length < offset + 8) return;
					length = Number(buffer.readBigUInt64BE(offset));
					offset += 8;
				}
				const maskOffset = offset;
				if (masked) offset += 4;
				if (buffer.length < offset + length) return;
				let payload = buffer.subarray(offset, offset + length);
				if (masked) {
					const maskKey = buffer.subarray(maskOffset, maskOffset + 4);
					const copy = Buffer.alloc(length);
					for (let index = 0; index < length; index += 1) copy[index] = payload[index] ^ maskKey[index % 4];
					payload = copy;
				}
				buffer = buffer.subarray(offset + length);
				if (opcode === 0x8) {
					finish(null);
					return;
				}
				if (opcode === 0x9) {
					socket.write(frame("", 0xa));
					continue;
				}
				if (opcode === 0xa) continue;
				if (opcode === 0x0) {
					fragments.push(payload);
				} else {
					fragments = [payload];
				}
				if (!fin) continue;
				const text = Buffer.concat(fragments).toString("utf8");
				fragments = [];
				dispatch(text);
			}
		};

		socket.on("connect", () => {
			socket.write(
				[
					`GET ${path} HTTP/1.1`,
					`Host: ${host}:${port}`,
					"Upgrade: websocket",
					"Connection: Upgrade",
					`Sec-WebSocket-Key: ${key}`,
					"Sec-WebSocket-Version: 13",
					"",
					""
				].join("\r\n")
			);
		});

		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!handshaken) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end < 0) return;
				const head = buffer.subarray(0, end).toString("latin1");
				buffer = buffer.subarray(end + 4);
				const status = Number(head.split(" ")[1] ?? 0);
				if (status !== 101) {
					finish(new Error(`WebSocket 握手失败：HTTP ${status}`));
					return;
				}
				const expected = createHash("sha1").update(key + GUID).digest("base64");
				if (!head.toLowerCase().includes(expected.toLowerCase())) {
					finish(new Error("WebSocket 握手校验失败"));
					return;
				}
				handshaken = true;
				clearTimeout(timer);
				resolve({
					send: (text) => {
						if (!closed) socket.write(frame(text));
					},
					onMessage: (handler) => listeners.add(handler),
					onClose: (handler) => closers.add(handler),
					close: () => {
						if (closed) return;
						try {
							socket.write(frame("", 0x8));
						} catch {
							// 已经断开
						}
						finish(null);
					}
				});
			}
			parseFrames();
		});

		socket.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
		socket.on("close", () => finish(null));
	});
}
