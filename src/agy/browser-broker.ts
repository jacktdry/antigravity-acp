import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

export interface BrowserBrokerBinding {
	url: string | null;
	computerUrl?: string | null;
	token: string;
}

type MCPHeader = { name?: unknown; value?: unknown };
type MCPServer = {
	name?: unknown;
	type?: unknown;
	url?: unknown;
	headers?: unknown;
};

const BROKER_SERVER_NAME = "agentdock-browser";
const COMPUTER_SERVER_NAME = "agentdock-computer";
const BROWSER_PATH = "/internal/acp-browser/mcp";
const COMPUTER_PATH = "/internal/acp-computer/mcp";
const sandboxHomes = new Map<string, string>();

function brokerRequired(): boolean {
	return process.env.AGENTDOCK_BROWSER_BROKER_REQUIRED === "1";
}

function browserBackendsDisabled(): boolean {
	return process.env.AGENTDOCK_BROWSER_BACKENDS_DISABLED === "1";
}

function parseNamedBinding(
	mcpServers: unknown[],
	serverName: string,
	pathName: string,
): { url: string; token: string } | null {
	const matches = mcpServers.filter(
		(item) =>
			item &&
			typeof item === "object" &&
			(item as MCPServer).name === serverName,
	) as MCPServer[];
	if (matches.length > 1) throw new Error(`Duplicate ${serverName} MCP`);
	const raw = matches[0];
	if (!raw) return null;
	if (raw.type !== "http" || typeof raw.url !== "string") {
		throw new Error(`${serverName} MCP must use HTTP transport`);
	}
	const url = validateControlURL(raw.url, pathName, serverName);
	const headers = Array.isArray(raw.headers)
		? (raw.headers as MCPHeader[])
		: [];
	const auth = headers.filter(
		(header) =>
			typeof header?.name === "string" &&
			header.name.toLowerCase() === "authorization",
	);
	const value =
		auth.length === 1 && typeof auth[0]?.value === "string"
			? auth[0].value
			: "";
	if (!/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(value)) {
		throw new Error(`${serverName} authorization is missing or invalid`);
	}
	return { url, token: value.slice("Bearer ".length) };
}

function parseBinding(mcpServers: unknown): BrowserBrokerBinding | null {
	if (!Array.isArray(mcpServers)) {
		if (brokerRequired())
			throw new Error("AgentDock Browser Broker MCP is required");
		return null;
	}
	const browser = parseNamedBinding(
		mcpServers,
		BROKER_SERVER_NAME,
		BROWSER_PATH,
	);
	const computer = parseNamedBinding(
		mcpServers,
		COMPUTER_SERVER_NAME,
		COMPUTER_PATH,
	);
	if (!browser && brokerRequired()) {
		throw new Error("AgentDock Browser Broker MCP is required");
	}
	if (!browser && !computer) return null;
	const firstBinding = browser ?? computer;
	if (!firstBinding) return null;
	const token = firstBinding.token;
	if (browser && computer && browser.token !== computer.token) {
		throw new Error("AgentDock Broker MCP capabilities must share one token");
	}
	return {
		url: browser?.url ?? null,
		...(computer ? { computerUrl: computer.url } : {}),
		token,
	};
}

export function parseBrowserBrokerBinding(
	mcpServers: unknown,
): BrowserBrokerBinding | null {
	try {
		return parseBinding(mcpServers);
	} catch (error) {
		if (brokerRequired() || browserBackendsDisabled()) throw error;
		return null;
	}
}

function validateControlURL(
	raw: string,
	expectedPath: string,
	label = "AgentDock Broker",
): string {
	const escapedPath = expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const exactLoopback = new RegExp(
		`^http://(?:127.0.0.1|localhost|\\[::1\\])(?::[1-9][0-9]*)?${escapedPath}$`,
	);
	if (!exactLoopback.test(raw)) {
		throw new Error(`${label} must use exact loopback HTTP`);
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`${label} URL is invalid`);
	}
	if (parsed.protocol !== "http:" || parsed.username || parsed.password) {
		throw new Error(`${label} must use loopback HTTP`);
	}
	const host = parsed.hostname.toLowerCase();
	if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
		throw new Error(`${label} must use a loopback host`);
	}
	if (parsed.pathname !== expectedPath || parsed.search || parsed.hash) {
		throw new Error(`${label} URL path is invalid`);
	}
	return parsed.toString();
}

function readJSON(file: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function writeJSON(file: string, value: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
}

function selfProxyCommand(): { command: string; args: string[] } {
	const execPath = process.execPath;
	const base = path.basename(execPath).toLowerCase();
	if (base === "bun" || base === "bun.exe") {
		const entry = path.resolve(import.meta.dir, "..", "..", "index.ts");
		return { command: execPath, args: [entry] };
	}
	return { command: execPath, args: [] };
}

function copyIfExists(source: string, target: string): void {
	if (!fs.existsSync(source)) return;
	fs.copyFileSync(source, target);
	fs.chmodSync(target, 0o600);
}

/** Only these state paths are shared; MCP/plugin directories and settings are private. */
const SHARED_DIRECTORIES = [
	"conversations",
	"brain",
	"annotations",
	"knowledge",
	"implicit",
];
const SHARED_FILES = [
	"history.jsonl",
	"conversation_summaries.db",
	"jetbox_summaries_proto.pb",
	"jetski_state.pbtxt",
];

export function prepareAgyBrokerEnvironment(
	sessionId: string,
	binding: BrowserBrokerBinding | null,
): Record<string, string> | undefined {
	if (!binding) {
		if (brokerRequired())
			throw new Error("AgentDock Browser Broker MCP is required");
		if (browserBackendsDisabled())
			return prepareChildEnvironment(sessionId, null);
		return undefined;
	}
	if (brokerRequired() && !binding.url)
		throw new Error("AgentDock Browser Broker MCP is required");
	return prepareChildEnvironment(sessionId, binding);
}

export function prepareAgyModelEnvironment(
	sessionId: string,
): Record<string, string> {
	return prepareChildEnvironment(sessionId, null);
}

function prepareChildEnvironment(
	sessionId: string,
	binding: BrowserBrokerBinding | null,
): Record<string, string> {
	const url = binding?.url
		? validateControlURL(binding.url, BROWSER_PATH, BROKER_SERVER_NAME)
		: null;
	const computerUrl = binding?.computerUrl
		? validateControlURL(
				binding.computerUrl,
				COMPUTER_PATH,
				COMPUTER_SERVER_NAME,
			)
		: null;
	if (binding && !/^[A-Za-z0-9._~+/-]+=*$/.test(binding.token))
		throw new Error("Invalid Browser Broker token");
	const sourceGemini = path.join(os.homedir(), ".gemini");
	let sandboxHome = sandboxHomes.get(sessionId);
	if (!sandboxHome) {
		sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-browser-"));
		sandboxHomes.set(sessionId, sandboxHome);
	}
	// macOS agy resolves OAuth through the login Keychain. AgentDock overrides
	// HOME for the outer ACP profile, and Bun's os.userInfo().homedir also
	// follows that override. Query the OS password record (not HOME) instead.
	// Keep .gemini/config isolated and remove only this link during cleanup.
	if (process.platform === "darwin") {
		const account = Bun.spawnSync(["/usr/bin/id", "-P"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const accountHome =
			account.exitCode === 0
				? new TextDecoder()
						.decode(account.stdout)
						.trim()
						.split(":")[8]
				: undefined;
		const sourceKeychains =
			accountHome && path.isAbsolute(accountHome)
				? path.join(accountHome, "Library", "Keychains")
				: null;
		const sandboxLibrary = path.join(sandboxHome, "Library");
		const sandboxKeychains = path.join(sandboxLibrary, "Keychains");
		if (
			sourceKeychains &&
			fs.existsSync(sourceKeychains) &&
			!fs.existsSync(sandboxKeychains)
		) {
			fs.mkdirSync(sandboxLibrary, { recursive: true, mode: 0o700 });
			fs.symlinkSync(sourceKeychains, sandboxKeychains, "dir");
		}
	}
	const sandboxGemini = path.join(sandboxHome, ".gemini");
	const sandboxConfig = path.join(sandboxGemini, "config");
	fs.mkdirSync(sandboxConfig, { recursive: true, mode: 0o700 });
	// Never copy global hooks, plugins, sidecars, MCP routes, or credentials embedded in them.
	const settings = readJSON(path.join(sourceGemini, "settings.json"));
	writeJSON(path.join(sandboxGemini, "settings.json"), {
		security: settings.security,
	});
	const proxy = selfProxyCommand();
	const mcpServers: Record<string, unknown> = {};
	if (url) {
		mcpServers[BROKER_SERVER_NAME] = {
			command: proxy.command,
			args: [...proxy.args, "--agentdock-browser-proxy", url],
			disabled: false,
		};
	}
	if (computerUrl) {
		mcpServers[COMPUTER_SERVER_NAME] = {
			command: proxy.command,
			args: [...proxy.args, "--agentdock-browser-proxy", computerUrl],
			disabled: false,
		};
	}
	writeJSON(path.join(sandboxConfig, "mcp_config.json"), { mcpServers });
	writeJSON(path.join(sandboxConfig, "config.json"), {
		plugins: { "chrome-devtools-plugin": { enabled: false } },
	});
	for (const name of [
		"google_accounts.json",
		"oauth_creds.json",
		"state.json",
		"installation_id",
	]) {
		copyIfExists(path.join(sourceGemini, name), path.join(sandboxGemini, name));
	}
	const sourceState = path.join(sourceGemini, "antigravity-cli");
	const sandboxState = path.join(sandboxGemini, "antigravity-cli");
	fs.mkdirSync(sandboxState, { recursive: true, mode: 0o700 });
	for (const name of ["antigravity-oauth-token", "installation_id"]) {
		copyIfExists(path.join(sourceState, name), path.join(sandboxState, name));
	}
	const cliSettings = readJSON(path.join(sourceState, "settings.json"));
	writeJSON(path.join(sandboxState, "settings.json"), {
		model: cliSettings.model,
		colorScheme: cliSettings.colorScheme,
	});
	for (const name of [...SHARED_DIRECTORIES, ...SHARED_FILES]) {
		const source = path.join(sourceState, name);
		const target = path.join(sandboxState, name);
		if (fs.existsSync(target)) continue;
		if (!fs.existsSync(source)) {
			if (!SHARED_DIRECTORIES.includes(name)) continue;
			fs.mkdirSync(target, { recursive: true, mode: 0o700 });
			continue;
		}
		if (process.platform === "win32" && SHARED_FILES.includes(name)) {
			copyIfExists(source, target);
			continue;
		}
		fs.symlinkSync(
			source,
			target,
			SHARED_DIRECTORIES.includes(name)
				? process.platform === "win32"
					? "junction"
					: "dir"
				: "file",
		);
	}
	return {
		HOME: sandboxHome,
		USERPROFILE: sandboxHome,
		XDG_CONFIG_HOME: path.join(sandboxHome, ".config"),
		XDG_DATA_HOME: path.join(sandboxHome, ".local", "share"),
		XDG_CACHE_HOME: path.join(sandboxHome, ".cache"),
		APPDATA: path.join(sandboxHome, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(sandboxHome, "AppData", "Local"),
		AGENTDOCK_BROWSER_BROKER_TOKEN: binding?.token ?? "",
	};
}

export function cleanupAgyBrokerHome(sessionId: string): void {
	const sandboxHome = sandboxHomes.get(sessionId);
	if (!sandboxHome) return;
	// rm removes links/junctions themselves, never the shared targets.
	fs.rmSync(sandboxHome, { recursive: true, force: true });
	sandboxHomes.delete(sessionId);
}

function rpcFailure(line: string, message: string): string | null {
	try {
		const request = JSON.parse(line) as { id?: unknown };
		if (!("id" in request)) return null;
		return JSON.stringify({
			jsonrpc: "2.0",
			id: request.id ?? null,
			error: { code: -32603, message },
		});
	} catch {
		return JSON.stringify({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "Parse error" },
		});
	}
}

/** Per-proxy Streamable HTTP state. This shim never manages a browser. */
export class BrowserBrokerProxy {
	private sessionId: string | null = null;
	private protocolVersion: string | null = null;
	constructor(private readonly binding: { url: string; token: string }) {
		const parsed = new URL(binding.url);
		const expected =
			parsed.pathname === COMPUTER_PATH ? COMPUTER_PATH : BROWSER_PATH;
		validateControlURL(binding.url, expected);
		if (binding && !/^[A-Za-z0-9._~+/-]+=*$/.test(binding.token))
			throw new Error("Invalid Browser Broker token");
	}

	async forward(line: string, emit: (line: string) => void): Promise<void> {
		let request: {
			id?: unknown;
			method?: string;
			params?: { protocolVersion?: string };
		};
		try {
			request = JSON.parse(line);
			if (!request || typeof request !== "object" || Array.isArray(request))
				throw new Error();
		} catch {
			emit(
				JSON.stringify({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "Parse error" },
				}),
			);
			return;
		}
		const hasId = "id" in request;
		let answered = false;
		const receive = (data: string): boolean => {
			const message = JSON.parse(data);
			if (message?.jsonrpc !== "2.0" || Array.isArray(message))
				throw new Error();
			if ("id" in message && message.id === request.id && hasId) {
				answered = true;
				if (
					request.method === "initialize" &&
					typeof message.result?.protocolVersion === "string"
				) {
					this.protocolVersion = message.result.protocolVersion;
				}
			}
			emit(JSON.stringify(message));
			return answered;
		};
		try {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${this.binding.token}`,
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
			};
			if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
			if (this.protocolVersion)
				headers["MCP-Protocol-Version"] = this.protocolVersion;
			const response = await fetch(this.binding.url, {
				method: "POST",
				headers,
				body: line,
				redirect: "error",
				signal: AbortSignal.timeout(120_000),
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error();
			}
			this.sessionId = response.headers.get("Mcp-Session-Id") ?? this.sessionId;
			if (response.status === 202 || response.status === 204) {
				await response.body?.cancel();
			} else if (
				response.headers.get("content-type")?.includes("text/event-stream")
			) {
				if (!response.body) throw new Error();
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let pending = "";
				let data: string[] = [];
				try {
					while (!answered) {
						const chunk = await reader.read();
						pending += decoder.decode(chunk.value, { stream: !chunk.done });
						while (pending.includes("\n")) {
							const newline = pending.indexOf("\n");
							const row = pending.slice(0, newline).replace(/\r$/, "");
							pending = pending.slice(newline + 1);
							if (row === "") {
								if (data.length && receive(data.join("\n"))) break;
								data = [];
							} else if (row.startsWith("data:")) {
								data.push(row.slice(5).replace(/^ /, ""));
							}
						}
						if (chunk.done) break;
					}
				} finally {
					await reader.cancel();
				}
			} else {
				const body = (await response.text()).trim();
				if (body) receive(body);
			}
			if (hasId && !answered) throw new Error();
		} catch {
			if (!answered) {
				const failure = rpcFailure(
					line,
					"AgentDock Browser Broker request failed or unavailable",
				);
				if (failure) emit(failure);
			}
		}
	}
}

export async function runBrowserBrokerProxyFromArgs(): Promise<boolean> {
	const index = process.argv.indexOf("--agentdock-browser-proxy");
	if (index < 0) return false;
	let proxy: BrowserBrokerProxy;
	try {
		proxy = new BrowserBrokerProxy({
			url: process.argv[index + 1] ?? "",
			token: process.env.AGENTDOCK_BROWSER_BROKER_TOKEN ?? "",
		});
	} catch {
		process.stderr.write("[agy-acp] Invalid Browser Broker URL/token\n");
		process.exitCode = 2;
		return true;
	}
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const raw of lines) {
		const line = raw.trim();
		if (line)
			await proxy.forward(line, (output) =>
				process.stdout.write(`${output}\n`),
			);
	}
	return true;
}
