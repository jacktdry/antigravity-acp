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
	evaluateNativePermissionHook,
	nativePermissionHookConfig,
	nativePermissionPolicy,
	NativePermissionError,
	type NativePermissionBinding,
	type NativePermissionDiagnostic,
	type NativePermissionProvider,
	type NativePermissionResponse,
} from "../../src/agy/native-permission-policy";
import {
	buildAgyArgs,
	extraArgsFromEnv,
	MAX_PROMPT_ARG_LENGTH,
	spawnAgy,
} from "../../src/agy/process";
import { newSession } from "../../src/types/session";

const binding: NativePermissionBinding = {
	ownerId: "next-owner",
	adapterIncarnation: "incarnation-1",
	sessionId: "session-1",
	turnId: "turn-1",
	policyRevision: "revision-1",
	conversationId: "conversation-1",
	workspacePaths: ["/fixture"],
};
const input = {
	conversationId: binding.conversationId,
	workspacePaths: binding.workspacePaths,
	stepIdx: 1,
	toolCall: {
		name: "run_command",
		args: { CommandLine: "fixture-only-canary", Cwd: "/fixture" },
	},
};
const raw = JSON.stringify(input);
const provider =
	(decision: NativePermissionResponse["decision"]): NativePermissionProvider =>
	async (request) => ({
		requestId: request.requestId,
		operationDigest: request.operationDigest,
		decision,
		expiresAt: Date.now() + 1000,
	});

describe("independent native permission hook bridge PoC", () => {
	test("only an exact Core allow permits a tool; ask never becomes AGY cached ask", async () => {
		for (const [core, decision, reason] of [
			["allow", "allow", "AGY_NATIVE_CORE_ALLOWED"],
			["deny", "deny", "AGY_NATIVE_CORE_DENIED"],
			["ask", "deny", "AGY_NATIVE_CORE_APPROVAL_PENDING"],
		] as const) {
			expect(
				await evaluateNativePermissionHook(raw, binding, provider(core)),
			).toEqual({ decision, reason });
		}
	});
	test("missing provider, exceptions and invalid responses deny without exposing data", async () => {
		const cases: [
			NativePermissionProvider | undefined,
			NativePermissionDiagnostic,
		][] = [
			[undefined, "AGY_NATIVE_CORE_UNAVAILABLE"],
			[
				async () => {
					throw new Error("canary-secret");
				},
				"AGY_NATIVE_CORE_UNAVAILABLE",
			],
			[async () => null, "AGY_NATIVE_CORE_RESPONSE_INVALID"],
			[async () => ({ decision: "allow" }), "AGY_NATIVE_CORE_RESPONSE_INVALID"],
			[
				async (r) => ({
					...((await provider("allow")(
						r,
						new AbortController().signal,
					)) as object),
					requestId: "other",
				}),
				"AGY_NATIVE_CORE_RESPONSE_INVALID",
			],
			[
				async (r) => ({
					...((await provider("allow")(
						r,
						new AbortController().signal,
					)) as object),
					operationDigest: "other",
				}),
				"AGY_NATIVE_CORE_RESPONSE_INVALID",
			],
			[
				async (r) => ({
					...((await provider("allow")(
						r,
						new AbortController().signal,
					)) as object),
					expiresAt: 0,
				}),
				"AGY_NATIVE_CORE_RESPONSE_INVALID",
			],
			[
				async (r) => ({
					...((await provider("allow")(
						r,
						new AbortController().signal,
					)) as object),
					decision: "force_ask",
				}),
				"AGY_NATIVE_CORE_RESPONSE_INVALID",
			],
		];
		for (const [core, reason] of cases) {
			const output = await evaluateNativePermissionHook(raw, binding, core);
			expect(output).toEqual({ decision: "deny", reason });
			expect(JSON.stringify(output)).not.toContain("canary");
		}
	});
	test("malformed, oversized, mismatched or unsupported input never reaches Core", async () => {
		const core = mock(provider("allow"));
		for (const payload of [
			"{",
			"null",
			"[]",
			"x".repeat(256 * 1024 + 1),
			JSON.stringify({ ...input, conversationId: "other" }),
			JSON.stringify({ ...input, workspacePaths: ["/other"] }),
			JSON.stringify({ ...input, stepIdx: -1 }),
			JSON.stringify({ ...input, toolCall: { name: "run_command", args: [] } }),
		])
			expect(
				await evaluateNativePermissionHook(payload, binding, core),
			).toEqual({ decision: "deny", reason: "AGY_NATIVE_HOOK_INPUT_INVALID" });
		expect(
			await evaluateNativePermissionHook(
				JSON.stringify({
					...input,
					toolCall: { name: "invoke_subagent", args: {} },
				}),
				binding,
				core,
			),
		).toEqual({ decision: "deny", reason: "AGY_NATIVE_HOOK_TOOL_UNSUPPORTED" });
		expect(core).not.toHaveBeenCalled();
	});
	test("every native shell/file category is gated and binds exact args and owner context", async () => {
		const requests: Parameters<NativePermissionProvider>[0][] = [];
		const core: NativePermissionProvider = async (r, signal) => {
			requests.push(r);
			return provider("allow")(r, signal);
		};
		for (const name of [
			"run_command",
			"view_file",
			"write_to_file",
			"replace_file_content",
			"multi_replace_file_content",
			"list_dir",
			"find_by_name",
			"grep_search",
		]) {
			expect(
				(
					await evaluateNativePermissionHook(
						JSON.stringify({ ...input, toolCall: { name, args: {} } }),
						binding,
						core,
					)
				).decision,
			).toBe("allow");
		}
		await evaluateNativePermissionHook(raw, binding, core);
		await evaluateNativePermissionHook(
			raw,
			{ ...binding, turnId: "turn-2" },
			core,
		);
		await evaluateNativePermissionHook(
			JSON.stringify({
				...input,
				toolCall: { ...input.toolCall, args: { Cwd: "/other" } },
			}),
			binding,
			core,
		);
		expect(new Set(requests.map((r) => r.operationDigest)).size).toBe(
			requests.length,
		);
		expect(new Set(requests.map((r) => r.requestId)).size).toBe(
			requests.length,
		);
	});
	test("a previous allow cannot be replayed for the same tool", async () => {
		let previous: unknown;
		const core: NativePermissionProvider = async (r, s) =>
			(previous ??= await provider("allow")(r, s));
		expect(
			(await evaluateNativePermissionHook(raw, binding, core)).decision,
		).toBe("allow");
		expect(await evaluateNativePermissionHook(raw, binding, core)).toEqual({
			decision: "deny",
			reason: "AGY_NATIVE_CORE_RESPONSE_INVALID",
		});
	});
	test("timeouts and cancellation deny even when the provider ignores abort", async () => {
		let signal: AbortSignal | undefined;
		let lateAllow: (() => void) | undefined;
		const core: NativePermissionProvider = (r, s) => {
			signal = s;
			return new Promise((resolve) => {
				lateAllow = () =>
					resolve({
						requestId: r.requestId,
						operationDigest: r.operationDigest,
						decision: "allow",
						expiresAt: Date.now() + 1000,
					});
			});
		};
		const output = await evaluateNativePermissionHook(raw, binding, core, {
			timeoutMs: 5,
		});
		expect(output).toEqual({
			decision: "deny",
			reason: "AGY_NATIVE_CORE_TIMEOUT",
		});
		expect(signal?.aborted).toBe(true);
		lateAllow?.();
		expect(output.decision).toBe("deny");
		const cancel = new AbortController();
		const pending = evaluateNativePermissionHook(raw, binding, core, {
			signal: cancel.signal,
		});
		cancel.abort();
		expect(await pending).toEqual({
			decision: "deny",
			reason: "AGY_NATIVE_CORE_CANCELLED",
		});
		const unused = mock(provider("allow"));
		await evaluateNativePermissionHook(raw, binding, unused, {
			signal: cancel.signal,
		});
		expect(unused).not.toHaveBeenCalled();
	});
	test("private HOME configuration fixture matches the official hook shape", () => {
		const home = fs.mkdtempSync("/private/tmp/agy-native-hook-fixture-");
		try {
			const dir = path.join(home, ".gemini/config");
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			const file = path.join(dir, "hooks.json");
			const config = nativePermissionHookConfig("/fixture/Core's hook");
			fs.writeFileSync(file, JSON.stringify(config), {
				flag: "wx",
				mode: 0o600,
			});
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(config);
			expect(config["agentdock-native-permission"].PreToolUse[0]).toEqual({
				matcher: "*",
				hooks: [
					{
						type: "command",
						command: "'/fixture/Core'\\''s hook'",
						timeout: 30,
					},
				],
			});
			expect(() => nativePermissionHookConfig("relative-hook")).toThrow(
				NativePermissionError,
			);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("runtime remains blocked, Legacy remains unchanged", () => {
	const keys = ["AGY_ACP_AUTO_APPROVE", "AGY_EXTRA_ARGS"] as const;
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
	test("typed policy rejects invalid opt-ins without leaking values", () => {
		expect(nativePermissionPolicy()).toEqual({
			mode: "legacy",
			authority: "agy",
		});
		expect(nativePermissionPolicy("0").mode).toBe("blocked");
		for (const value of ["", "1", "false", "canary-secret"]) {
			try {
				nativePermissionPolicy(value);
				throw new Error("must reject");
			} catch (e) {
				expect(e).toBeInstanceOf(NativePermissionError);
				expect((e as NativePermissionError).code).toBe(
					"AGY_NATIVE_POLICY_INVALID",
				);
				expect((e as Error).message).not.toContain("canary");
			}
		}
	});
	test("parent and child policy cannot weaken one another at the spawn boundary", () => {
		const spawn = spyOn(Bun, "spawn");
		const args = [
			"--dangerously-skip-permissions",
			"--mode=accept-edits",
			"--sandbox=false",
		];
		process.env.AGY_ACP_AUTO_APPROVE = "0";
		expect(() =>
			spawnAgy("fixture", args, "/unused", { AGY_ACP_AUTO_APPROVE: "1" }),
		).toThrow(NativePermissionError);
		expect(() => spawnAgy("fixture", args, "/unused", {})).toThrow(
			"AGY_NATIVE_APPROVAL_UNAVAILABLE",
		);
		delete process.env.AGY_ACP_AUTO_APPROVE;
		expect(() =>
			spawnAgy("fixture", args, "/unused", { AGY_ACP_AUTO_APPROVE: "0" }),
		).toThrow("AGY_NATIVE_APPROVAL_UNAVAILABLE");
		expect(spawn).not.toHaveBeenCalled();
	});
	test("blocked oversized prompts allocate no temp file or child; all extra args reject", async () => {
		process.env.AGY_ACP_AUTO_APPROVE = "0";
		const write = spyOn(fs, "writeFileSync");
		const spawn = spyOn(Bun, "spawn");
		const adapter = new Adapter({
			binary: "fixture",
			workingDir: "/unused",
			conversationsDir: "/unused",
			skipNarration: false,
		});
		const outcome = await adapter.runPrompt(
			"fixture",
			newSession("/unused"),
			"x".repeat(MAX_PROMPT_ARG_LENGTH + 1),
			{ update: async () => {} } as any,
		);
		expect(outcome.error).toContain("AGY_NATIVE_APPROVAL_UNAVAILABLE");
		expect(write).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		for (const flag of [
			"--dangerously-skip-permissions=true",
			"--mode=auto",
			"--no-sandbox",
			"--settings=/secret",
			"--agent=other",
			"--project=other",
			"-y",
			"--model=safe",
			"--future-flag",
		]) {
			process.env.AGY_EXTRA_ARGS = flag;
			expect(() => extraArgsFromEnv()).toThrow(
				"AGY_NATIVE_EXTRA_ARGS_FORBIDDEN",
			);
			expect(() =>
				buildAgyArgs({
					workingDir: "/fixture",
					conversationId: null,
					modelId: null,
					permissionMode: null,
					prompt: "fixture",
					extraArgs: [flag],
				}),
			).toThrow("AGY_NATIVE_EXTRA_ARGS_FORBIDDEN");
		}
	});
});
