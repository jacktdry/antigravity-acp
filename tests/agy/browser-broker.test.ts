import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Adapter } from "../../src/acp/adapter";
import {
	BrowserBrokerProxy,
	cleanupAgyBrokerHome,
	parseBrowserBrokerBinding,
	prepareAgyBrokerEnvironment,
} from "../../src/agy/browser-broker";
import { spawnAgy } from "../../src/agy/process";
import { newSession } from "../../src/types/session";

const binding = {
	url: "http://127.0.0.1:3210/internal/acp-browser/mcp",
	token: "test-capability",
};
const server = (url = binding.url, token = binding.token) => ({
	name: "agentdock-browser",
	type: "http",
	url,
	headers: [{ name: "Authorization", value: `Bearer ${token}` }],
});
const computerBinding = {
	url: "http://127.0.0.1:3210/internal/acp-computer/mcp",
	token: binding.token,
};
const computerServer = (
	url = computerBinding.url,
	token = computerBinding.token,
) => ({
	name: "agentdock-computer",
	type: "http",
	url,
	headers: [{ name: "Authorization", value: `Bearer ${token}` }],
});
const combinedBinding = {
	url: binding.url,
	computerUrl: computerBinding.url,
	token: binding.token,
};
let required: string | undefined;
beforeEach(() => {
	required = process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED;
	process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED = "1";
});
afterEach(() => {
	if (required === undefined)
		delete process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED;
	else process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED = required;
	mock.restore();
});

describe("broker binding", () => {
	test("retains the exact loopback capability and accepts IPv6 loopback", () => {
		expect(parseBrowserBrokerBinding([server()])).toEqual(binding);
		expect(
			parseBrowserBrokerBinding([
				server("http://[::1]:3210/internal/acp-browser/mcp"),
			])?.url,
		).toContain("[::1]");
	});
	test("retains Browser and Computer Broker capabilities with one shared token", () => {
		expect(parseBrowserBrokerBinding([server(), computerServer()])).toEqual(
			combinedBinding,
		);
		expect(() =>
			parseBrowserBrokerBinding([
				server(),
				computerServer(undefined, "other-token"),
			]),
		).toThrow();
	});
	test("browser-disabled AgentDock mode may retain a computer-only capability", () => {
		const previousRequired = process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED;
		const previousDisabled = process.env.AGENTDOCK_BROWSER_BACKENDS_DISABLED;
		delete process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED;
		process.env.AGENTDOCK_BROWSER_BACKENDS_DISABLED = "1";
		try {
			expect(parseBrowserBrokerBinding([computerServer()])).toEqual({
				url: null,
				computerUrl: computerBinding.url,
				token: binding.token,
			});
		} finally {
			if (previousRequired === undefined)
				delete process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED;
			else process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED = previousRequired;
			if (previousDisabled === undefined)
				delete process.env.AGENTDOCK_BROWSER_BACKENDS_DISABLED;
			else process.env.AGENTDOCK_BROWSER_BACKENDS_DISABLED = previousDisabled;
		}
	});
	for (const url of [
		"https://127.0.0.1/internal/acp-browser/mcp",
		"http://example.com/internal/acp-browser/mcp",
		"http://127.0.0.1.evil/internal/acp-browser/mcp",
		"http://127.1/internal/acp-browser/mcp",
		"http://2130706433/internal/acp-browser/mcp",
		"http://localhost./internal/acp-browser/mcp",
		"http://user:secret@localhost/internal/acp-browser/mcp",
		"http://localhost/internal/acp-browser/mcp?token=secret",
		"http://localhost/internal/acp-browser/mcp#secret",
		"http://localhost/wrong",
		"http://localhost/a/../internal/acp-browser/mcp",
	]) {
		test(`rejects unsafe URL ${url}`, () => {
			expect(() => parseBrowserBrokerBinding([server(url)])).toThrow();
		});
	}
	for (const url of [
		"https://127.0.0.1/internal/acp-computer/mcp",
		"http://127.1/internal/acp-computer/mcp",
		"http://2130706433/internal/acp-computer/mcp",
		"http://localhost/internal/acp-browser/mcp",
		"http://localhost/a/../internal/acp-computer/mcp",
	]) {
		test(`rejects unsafe Computer Broker URL ${url}`, () => {
			expect(() =>
				parseBrowserBrokerBinding([server(), computerServer(url)]),
			).toThrow();
		});
	}
	test("required mode rejects missing, duplicate and malformed capabilities", () => {
		for (const servers of [
			undefined,
			[],
			[server(), server()],
			[server(binding.url, "")],
			[server(binding.url, "bad\r\nheader")],
			[{ ...server(), type: "sse" }],
			[{ ...server(), headers: [...server().headers, ...server().headers] }],
		])
			expect(() => parseBrowserBrokerBinding(servers)).toThrow();
	});
	test("optional mode leaves ordinary ACP clients unaffected", () => {
		delete process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED;
		expect(parseBrowserBrokerBinding([])).toBeNull();
		expect(parseBrowserBrokerBinding([server("http://evil/wrong")])).toBeNull();
		expect(prepareAgyBrokerEnvironment("none", null)).toBeUndefined();
	});
	test("missing broker prevents child environment preparation", () => {
		expect(() => prepareAgyBrokerEnvironment("none", null)).toThrow();
	});
});

describe("private child HOME", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-source-"));
		spyOn(os, "homedir").mockReturnValue(root);
		const originalSpawnSync = Bun.spawnSync;
		spyOn(Bun, "spawnSync").mockImplementation(
			((cmd: string[], options?: unknown) => {
				if (cmd[0] !== "/usr/bin/id" || cmd[1] !== "-P")
					return (originalSpawnSync as any)(cmd, options);
				return {
					exitCode: 0,
					stdout: Buffer.from(
						["test", "*", "501", "20", "0", "0", "Test", "0", root, "/bin/zsh"].join(":"),
					),
					stderr: Buffer.alloc(0),
				};
			}) as typeof Bun.spawnSync,
		);
		if (process.platform === "darwin")
			fs.mkdirSync(path.join(root, "Library", "Keychains"), {
				recursive: true,
			});
		fs.mkdirSync(path.join(root, ".gemini/config"), { recursive: true });
		fs.mkdirSync(path.join(root, ".gemini/antigravity-cli/conversations"), {
			recursive: true,
		});
		for (const [file, value] of Object.entries({
			"settings.json": {
				security: { auth: { selectedType: "oauth-personal" } },
				mcpServers: { "CHROME-DEVTOOLS": {}, "aliased-browser": {} },
			},
			"config/mcp_config.json": {
				mcpServers: { browser: {}, memory: {}, "computer-use": {} },
			},
			"config/config.json": {
				plugins: { "chrome-devtools-plugin": { enabled: true } },
			},
			"antigravity-cli/settings.json": {
				model: "claude-opus-5.5",
				mcpServers: { evil: {} },
			},
		}))
			fs.writeFileSync(path.join(root, ".gemini", file), JSON.stringify(value));
		fs.writeFileSync(
			path.join(root, ".gemini/antigravity-cli/antigravity-oauth-token"),
			"auth-state",
		);
		fs.writeFileSync(
			path.join(root, ".gemini/antigravity-cli/conversations/keep.db"),
			"history",
		);
	});
	afterEach(() => {
		cleanupAgyBrokerHome("../unsafe");
		cleanupAgyBrokerHome("second");
		fs.rmSync(root, { recursive: true, force: true });
	});
	test("login Keychains lookup ignores the outer ACP profile HOME", () => {
		if (process.platform !== "darwin") return;
		const parentHome = fs.mkdtempSync(path.join(os.tmpdir(), "broker-parent-"));
		try {
			spyOn(os, "homedir").mockReturnValue(parentHome);
			const env = prepareAgyBrokerEnvironment("second", combinedBinding)!;
			const keychains = path.join(env.HOME!, "Library", "Keychains");
			expect(fs.lstatSync(keychains).isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(keychains)).toBe(
				fs.realpathSync(path.join(root, "Library", "Keychains")),
			);
			expect(
				fs.existsSync(path.join(parentHome, "Library", "Keychains")),
			).toBe(false);
		} finally {
			fs.rmSync(parentHome, { recursive: true, force: true });
		}
	});
	test("copies auth, shares conversations, excludes global routes and preserves source bytes", () => {
		const snapshot = () =>
			fs
				.readdirSync(path.join(root, ".gemini"), { recursive: true })
				.map((file) => {
					const p = path.join(root, ".gemini", String(file));
					return [
						file,
						fs.statSync(p).isFile()
							? fs.readFileSync(p).toString("base64")
							: null,
					];
				});
		const before = snapshot();
		const env = prepareAgyBrokerEnvironment("../unsafe", combinedBinding)!;
		const read = (file: string) =>
			JSON.parse(
				fs.readFileSync(path.join(env.HOME!, ".gemini", file), "utf8"),
			);
		expect(read("config/mcp_config.json").mcpServers).toHaveProperty(
			"agentdock-browser",
		);
		expect(read("config/mcp_config.json").mcpServers).toHaveProperty(
			"agentdock-computer",
		);
		expect(Object.keys(read("config/mcp_config.json").mcpServers)).toEqual([
			"agentdock-browser",
			"agentdock-computer",
		]);
		expect(read("settings.json").mcpServers).toBeUndefined();
		expect(
			read("config/config.json").plugins["chrome-devtools-plugin"].enabled,
		).toBe(false);
		expect(read("antigravity-cli/settings.json")).toEqual({
			model: "claude-opus-5.5",
		});
		expect(
			fs.readFileSync(
				path.join(env.HOME!, ".gemini/antigravity-cli/antigravity-oauth-token"),
				"utf8",
			),
		).toBe("auth-state");
		const linked = path.join(
			env.HOME!,
			".gemini/antigravity-cli/conversations",
		);
		expect(fs.realpathSync(linked)).toBe(
			fs.realpathSync(path.join(root, ".gemini/antigravity-cli/conversations")),
		);
		expect(JSON.stringify(read("config/mcp_config.json"))).not.toContain(
			binding.token,
		);
		expect(env.AGENTDOCK_BROWSER_BROKER_TOKEN).toBe(binding.token);
		expect(env.USERPROFILE).toBe(env.HOME);
		expect(env.XDG_CONFIG_HOME).toStartWith(env.HOME!);
		if (process.platform === "darwin") {
			const keychains = path.join(env.HOME!, "Library", "Keychains");
			expect(fs.lstatSync(keychains).isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(keychains)).toBe(
				fs.realpathSync(path.join(root, "Library", "Keychains")),
			);
		}
		expect(
			prepareAgyBrokerEnvironment("../unsafe", combinedBinding)?.HOME,
		).toBe(env.HOME);
		const other = prepareAgyBrokerEnvironment("second", combinedBinding)!;
		expect(other.HOME).not.toBe(env.HOME);
		cleanupAgyBrokerHome("../unsafe");
		expect(fs.existsSync(env.HOME!)).toBe(false);
		if (process.platform === "darwin")
			expect(fs.existsSync(path.join(root, "Library", "Keychains"))).toBe(true);
		expect(fs.existsSync(other.HOME!)).toBe(true);
		expect(snapshot()).toEqual(before);
	});
	test("prompt and usage child env receives private HOME and env-only token", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation((() => {
			throw new Error("test spawn");
		}) as typeof Bun.spawn);
		const env = prepareAgyBrokerEnvironment("../unsafe", binding)!;
		expect(() => spawnAgy("agy", ["--model", "gpt-oss"], root, env)).toThrow();
		expect((spawn.mock.calls[0]![1] as any).env.HOME).toBe(env.HOME);
		const adapter = new Adapter({
			binary: "agy",
			workingDir: root,
			conversationsDir: root,
			skipNarration: false,
		});
		await adapter.runPrompt(
			"../unsafe",
			newSession(root),
			"hi",
			{ update: async () => {} } as any,
			binding,
		);
		await adapter.runUsage("../unsafe", root, binding);
		for (const call of spawn.mock.calls) {
			expect((call[1] as any).env.AGENTDOCK_BROWSER_BROKER_TOKEN).toBe(
				binding.token,
			);
			expect(JSON.stringify(call[0])).not.toContain(binding.token);
		}
	});
});

test("disabled mode keeps coding child sandboxed without a broker", () => {
	const previousRequired = process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED;
	const previousDisabled = process.env.AGENTDOCK_BROWSER_BACKENDS_DISABLED;
	delete process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED;
	process.env.AGENTDOCK_BROWSER_BACKENDS_DISABLED = "1";
	try {
		const env = prepareAgyBrokerEnvironment("disabled-session", null);
		if (!env) throw new Error("disabled mode did not create a child sandbox");
		const home = env.HOME;
		if (!home) throw new Error("disabled mode child HOME missing");
		expect(home).not.toBe(os.homedir());
		expect(env.AGENTDOCK_BROWSER_BROKER_TOKEN).toBe("");
		const mcp = JSON.parse(
			fs.readFileSync(
				path.join(home, ".gemini/config/mcp_config.json"),
				"utf8",
			),
		);
		expect(mcp.mcpServers).toEqual({});
		const cfg = JSON.parse(
			fs.readFileSync(path.join(home, ".gemini/config/config.json"), "utf8"),
		);
		expect(cfg.plugins["chrome-devtools-plugin"].enabled).toBe(false);
	} finally {
		cleanupAgyBrokerHome("disabled-session");
		if (previousRequired === undefined)
			delete process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED;
		else process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED = previousRequired;
		if (previousDisabled === undefined)
			delete process.env.AGENTDOCK_BROWSER_BACKENDS_DISABLED;
		else process.env.AGENTDOCK_BROWSER_BACKENDS_DISABLED = previousDisabled;
	}
});

describe("HTTP proxy", () => {
	let http: ReturnType<typeof Bun.serve>;
	afterEach(() => http?.stop(true));
	test("forwards initialize, notifications, list and SSE call with negotiated headers", async () => {
		const calls: any[] = [];
		http = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const rpc = (await req.json()) as Record<string, any>;
				calls.push({ rpc, headers: Object.fromEntries(req.headers) });
				if (!Object.hasOwn(rpc, "id"))
					return new Response(null, { status: 202 });
				const reply = {
					jsonrpc: "2.0",
					id: rpc.id,
					result:
						rpc.method === "initialize"
							? { protocolVersion: "2025-03-26" }
							: { tools: [] },
				};
				if (rpc.method === "tools/call")
					return new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(
									new TextEncoder().encode(
										': ping\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\n',
									),
								);
								c.enqueue(
									new TextEncoder().encode(
										`data: "id":${rpc.id},"result":{}}\r\n\r\n`,
									),
								);
								// Keep the SSE connection open: the shim must finish on the matching reply.
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				return Response.json(reply, {
					headers: { "Mcp-Session-Id": "transport-session" },
				});
			},
		});
		const proxy = new BrowserBrokerProxy({
			...binding,
			url: `http://127.0.0.1:${http.port}/internal/acp-browser/mcp`,
		});
		const output: string[] = [];
		for (const rpc of [
			{ jsonrpc: "2.0", id: 1, method: "initialize" },
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			{ jsonrpc: "2.0", id: 3, method: "tools/call" },
		])
			await proxy.forward(JSON.stringify(rpc), (line) => output.push(line));
		expect(output.map((line) => JSON.parse(line).id)).toEqual([1, 2, 3]);
		expect(calls[2].headers["mcp-session-id"]).toBe("transport-session");
		expect(calls[2].headers["mcp-protocol-version"]).toBe("2025-03-26");
		expect(calls[0].headers.authorization).toBe(`Bearer ${binding.token}`);
	});
	test("forwards the Computer Broker endpoint with the same env-only token", async () => {
		const calls: any[] = [];
		http = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const rpc = (await req.json()) as Record<string, any>;
				calls.push({ rpc, headers: Object.fromEntries(req.headers) });
				return Response.json({
					jsonrpc: "2.0",
					id: rpc.id,
					result:
						rpc.method === "initialize"
							? { protocolVersion: "2025-03-26" }
							: { tools: [{ name: "computer_acquire" }] },
				});
			},
		});
		const proxy = new BrowserBrokerProxy({
			url: `http://127.0.0.1:${http.port}/internal/acp-computer/mcp`,
			token: binding.token,
		});
		const output: string[] = [];
		await proxy.forward(
			'{"jsonrpc":"2.0","id":11,"method":"initialize"}',
			(line) => output.push(line),
		);
		await proxy.forward(
			'{"jsonrpc":"2.0","id":12,"method":"tools/list"}',
			(line) => output.push(line),
		);
		expect(JSON.parse(output[1]!).result.tools[0].name).toBe(
			"computer_acquire",
		);
		expect(
			calls.every(
				(call) => call.headers.authorization === `Bearer ${binding.token}`,
			),
		).toBe(true);
	});
	for (const status of [401, 500, 302])
		test(`safe JSON-RPC error for HTTP ${status}`, async () => {
			http = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () =>
					new Response(binding.token, {
						status,
						headers: { Location: "http://example.com" },
					}),
			});
			const proxy = new BrowserBrokerProxy({
				...binding,
				url: `http://127.0.0.1:${http.port}/internal/acp-browser/mcp`,
			});
			const output: string[] = [];
			await proxy.forward(
				'{"jsonrpc":"2.0","id":7,"method":"tools/list"}',
				(line) => output.push(line),
			);
			expect(JSON.parse(output[0]!).error.code).toBe(-32603);
			expect(output[0]).not.toContain(binding.token);
		});
	test("unavailable broker and invalid JSON produce structured errors", async () => {
		http = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({}),
		});
		const url = `http://127.0.0.1:${http.port}/internal/acp-browser/mcp`;
		http.stop(true);
		const proxy = new BrowserBrokerProxy({ ...binding, url });
		const output: string[] = [];
		await proxy.forward('{"jsonrpc":"2.0","id":8}', (line) =>
			output.push(line),
		);
		await proxy.forward("invalid", (line) => output.push(line));
		expect(output.map((line) => JSON.parse(line).error.code)).toEqual([
			-32603, -32700,
		]);
	});
});
