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
import * as path from "node:path";
import { Adapter } from "../../src/acp/adapter";
import {
	cleanupAgyBrokerHome,
	prepareAgyBrokerEnvironment,
	prepareAgyModelEnvironment,
} from "../../src/agy/browser-broker";
import {
	buildAgyArgs,
	discoverModels,
	extraArgsFromEnv,
	runNonInteractivePrompt,
	spawnAgy,
} from "../../src/agy/process";
import { newSession } from "../../src/types/session";

const options = {
	workingDir: "/cwd",
	conversationId: null,
	modelId: null,
	permissionMode: null,
	prompt: "hello",
};
const keys = [
	"AGY_ACP_AUTO_APPROVE",
	"AGY_ACP_CHILD_ISOLATION",
	"AGY_EXTRA_ARGS",
	"AGENTDOCK_BROWSER_BROKER_REQUIRED",
	"AGENTDOCK_BROWSER_BACKENDS_DISABLED",
] as const;
let saved: (string | undefined)[];
beforeEach(() => {
	saved = keys.map((k) => process.env[k]);
	for (const k of keys) delete process.env[k];
});
afterEach(() => {
	mock.restore();
	keys.forEach((k, i) => {
		if (saved[i] === undefined) delete process.env[k];
		else process.env[k] = saved[i];
	});
});

describe("disabled auto approval", () => {
	test("Legacy default is unchanged, opt-in vector removes skip and forces plan/sandbox", () => {
		expect(buildAgyArgs(options)).toEqual([
			"--add-dir",
			"/cwd",
			"--mode",
			"accept-edits",
			"--dangerously-skip-permissions",
			"--print-timeout",
			"0",
			"-p",
			"hello",
		]);
		process.env.AGY_ACP_AUTO_APPROVE = "0";
		const args = buildAgyArgs({
			...options,
			permissionMode: "accept-edits",
			sandbox: false,
		});
		expect(args).not.toContain("--dangerously-skip-permissions");
		expect(args).toContain("plan");
		expect(args).toContain("--sandbox");
	});
	test("rejects every extra token including aliases, equals and configuration escape routes", () => {
		process.env.AGY_ACP_AUTO_APPROVE = "0";
		for (const raw of [
			"--dangerously-skip-permissions",
			"--dangerously-skip-permissions=true",
			"--mode accept-edits",
			"--mode=auto",
			"--no-sandbox",
			"--sandbox=false",
			"--settings /canary-secret",
			"-y",
			"-- harmless",
			"--model safe",
		]) {
			process.env.AGY_EXTRA_ARGS = raw;
			expect(() => extraArgsFromEnv()).toThrow("AGY_EXTRA_ARGS is forbidden");
			expect(() => buildAgyArgs({ ...options, extraArgs: [raw] })).toThrow(
				"AGY_EXTRA_ARGS is forbidden",
			);
		}
	});
	test("no verified runtime approval bridge: all prompt entry points refuse before spawn", async () => {
		process.env.AGY_ACP_AUTO_APPROVE = "0";
		process.env.AGY_EXTRA_ARGS = "--dangerously-skip-permissions=canary-secret";
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("must not launch");
		});
		const adapter = new Adapter({
			binary: "agy",
			workingDir: "/cwd",
			conversationsDir: "/unused",
			skipNarration: false,
		});
		const result = await adapter.runPrompt(
			"next",
			newSession("/cwd"),
			"canary-secret",
			{ update: async () => {} } as any,
		);
		expect(result.hadUpdates).toBe(false);
		expect(result.error).toContain(
			"headless native-tool approval is unavailable",
		);
		expect(result.error).not.toContain("canary-secret");
		await expect(adapter.runUsage("next", "/cwd")).rejects.toThrow(
			"launch refused",
		);
		expect(() =>
			spawnAgy("agy", ["--dangerously-skip-permissions"], "/cwd"),
		).toThrow("launch refused");
		expect(await runNonInteractivePrompt("agy", "hi")).toBe("");
		expect(spawn).not.toHaveBeenCalled();
	});
	test("invalid opt-in values cannot silently restore legacy", () => {
		process.env.AGY_ACP_AUTO_APPROVE = "false";
		expect(() => buildAgyArgs(options)).toThrow("Invalid AGY_ACP_AUTO_APPROVE");
		process.env.AGY_ACP_CHILD_ISOLATION = "true";
		expect(() => prepareAgyBrokerEnvironment("next", null)).toThrow(
			"Invalid AGY_ACP_CHILD_ISOLATION",
		);
	});
});

describe("required child isolation failures", () => {
	test("initialization failure never launches or falls back, including models and usage", async () => {
		process.env.AGY_ACP_CHILD_ISOLATION = "required";
		const mkdir = spyOn(fs, "mkdtempSync").mockImplementation(() => {
			throw new Error("canary-secret");
		});
		const spawn = spyOn(Bun, "spawn");
		expect(() => prepareAgyBrokerEnvironment("next", null)).toThrow(
			"Failed to initialize required AGY child isolation",
		);
		expect(() => prepareAgyModelEnvironment("next")).toThrow(
			"Failed to initialize required AGY child isolation",
		);
		const adapter = new Adapter({
			binary: "agy",
			workingDir: "/cwd",
			conversationsDir: "/unused",
			skipNarration: false,
		});
		const result = await adapter.runPrompt("next", newSession("/cwd"), "hi", {
			update: async () => {},
		} as any);
		expect(result.error).not.toContain("canary-secret");
		await expect(adapter.runUsage("next", "/cwd")).rejects.toThrow(
			"required AGY child isolation",
		);
		expect(await discoverModels("agy")).toEqual([]);
		expect(await runNonInteractivePrompt("agy", "hi")).toBe("");
		expect(mkdir).toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		cleanupAgyBrokerHome("next");
	});
});

test("required HOME with normal parent HOME whitelists every Broker combination and models", async () => {
	const root = fs.mkdtempSync("/private/tmp/agy-required-test-");
	const source = path.join(root, "login");
	const parent = path.join(root, "parent");
	const conversations = path.join(root, "conversations");
	for (const dir of [
		path.join(source, "Library/Keychains"),
		path.join(source, ".gemini/antigravity-cli"),
		parent,
		conversations,
	])
		fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(conversations, "keep.db"), "history");
	fs.writeFileSync(
		path.join(source, ".gemini/antigravity-cli/antigravity-oauth-token"),
		"fixture-auth",
	);
	fs.writeFileSync(
		path.join(source, ".gemini/settings.json"),
		JSON.stringify({
			security: { dangerous: true },
			mcpServers: { evil: {} },
			hooks: { evil: {} },
		}),
	);
	const brokerModule = path.resolve("src/agy/browser-broker.ts");
	const processModule = path.resolve("src/agy/process.ts");
	const adapterModule = path.resolve("src/acp/adapter.ts");
	const sessionModule = path.resolve("src/types/session.ts");
	const code = `
import { expect, spyOn, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as b from ${JSON.stringify(brokerModule)};
import * as p from ${JSON.stringify(processModule)};
import { Adapter } from ${JSON.stringify(adapterModule)};
import { newSession } from ${JSON.stringify(sessionModule)};
const source = ${JSON.stringify(source)};
const parent = ${JSON.stringify(parent)};
const conversations = ${JSON.stringify(conversations)};
spyOn(Bun,"spawnSync").mockReturnValue({ exitCode: 0, stdout: Buffer.from(["test","*","501","20","0","0","Test","0",source,"/bin/zsh"].join(":")) } as any);
spyOn(os,"homedir").mockReturnValue(source);
const bindings = [null, {url:"http://127.0.0.1:3210/internal/acp-browser/mcp",token:"fixture-token"}, {url:null,computerUrl:"http://127.0.0.1:3210/internal/acp-computer/mcp",token:"fixture-token"}, {url:"http://127.0.0.1:3210/internal/acp-browser/mcp",computerUrl:"http://127.0.0.1:3210/internal/acp-computer/mcp",token:"fixture-token"}];
for (const redirected of [false,true]) {
  spyOn(os,"homedir").mockReturnValue(redirected ? parent : source);
  for (const [i,binding] of bindings.entries()) {
    const id = "fixture-" + redirected + i;
    const env = b.prepareAgyBrokerEnvironment(id,binding)!;
    expect(env.HOME).not.toBe(source);
    expect(env.HOME).not.toBe(parent);
    expect(fs.statSync(env.HOME).mode & 0o777).toBe(0o700);
    expect(fs.realpathSync(path.join(env.HOME,".gemini/antigravity-cli/conversations"))).toBe(conversations);
    expect(fs.lstatSync(path.join(env.HOME,".gemini/antigravity-cli/brain"),{throwIfNoEntry:false})).toBeUndefined();
    expect(fs.readFileSync(path.join(env.HOME,".gemini/antigravity-cli/antigravity-oauth-token"),"utf8")).toBe("fixture-auth");
    const config = fs.readFileSync(path.join(env.HOME,".gemini/config/mcp_config.json"),"utf8");
    expect(config).not.toContain("fixture-token");
    expect(config).not.toContain("evil");
    expect(Object.keys(JSON.parse(config).mcpServers).length).toBe(i === 3 ? 2 : i === 0 ? 0 : 1);
    expect(JSON.parse(fs.readFileSync(path.join(env.HOME,".gemini/settings.json"),"utf8"))).toEqual({});
    if (process.platform === "darwin") expect(fs.realpathSync(path.join(env.HOME,"Library/Keychains"))).toBe(path.join(source,"Library/Keychains"));
    const spawn = spyOn(Bun,"spawn").mockImplementation(() => { throw new Error("fixture launch"); });
    const adapter = new Adapter({binary:"fixture",workingDir:parent,conversationsDir:conversations,skipNarration:false});
    await adapter.runPrompt(id,newSession(parent),"hi",{update:async()=>{}} as any,binding);
    await adapter.runUsage(id,parent,binding);
    expect(spawn.mock.calls.length).toBe(2);
    for (const call of spawn.mock.calls) expect((call[1] as any).env.HOME).toBe(env.HOME);
    spawn.mockRestore();
    b.cleanupAgyBrokerHome(id);
    expect(fs.existsSync(env.HOME)).toBe(false);
  }
}
const modelEnv = b.prepareAgyModelEnvironment("fixture-model");
expect(modelEnv.HOME).not.toBe(parent);
b.cleanupAgyBrokerHome("fixture-model");
expect(fs.readFileSync(path.join(conversations,"keep.db"),"utf8")).toBe("history");
expect(fs.existsSync(path.join(source,"Library/Keychains"))).toBe(true);
mock.restore();
console.log("required isolation fixtures passed");
`;
	try {
		const env = {
			...process.env,
			HOME: source,
			AGY_CONVERSATIONS_DIR: conversations,
			AGY_ACP_CHILD_ISOLATION: "required",
		};
		const proc = Bun.spawn([process.execPath, "-e", code], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toBe("");
		expect(await proc.exited).toBe(0);
		expect((await new Response(proc.stdout).text()).trim()).toBe(
			"required isolation fixtures passed",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
