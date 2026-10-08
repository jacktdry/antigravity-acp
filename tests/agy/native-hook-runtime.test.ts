import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	installNativeHookFixture,
	subprocessNativeProvider,
} from "../../src/agy/native-hook-runtime";
import {
	evaluateNativePermissionHook,
	type NativePermissionBinding,
} from "../../src/agy/native-permission-policy";
import { assertHeadlessApprovalSupported } from "../../src/agy/process";

const binding: NativePermissionBinding = {
	ownerId: "core-fixture-owner",
	adapterIncarnation: "incarnation-1",
	sessionId: "session-1",
	turnId: "turn-1",
	policyRevision: "revision-1",
	conversationId: "conversation-1",
	workspacePaths: ["/synthetic/workspace"],
};
const input = (name = "run_command", args = { command: "synthetic-canary" }) =>
	JSON.stringify({
		conversationId: binding.conversationId,
		workspacePaths: binding.workspacePaths,
		stepIdx: 1,
		toolCall: { name, args },
	});
const env = {
	AGY_ACP_NATIVE_HOOK: "fixture-v1",
	AGY_ACP_AUTO_APPROVE: "0",
	AGY_ACP_CHILD_ISOLATION: "required",
};
let root: string;
let trustedBun: string;
beforeEach(() => {
	root = fs.mkdtempSync("/private/tmp/agy-hook-runtime-");
	trustedBun = path.join(root, "bun");
	// Homebrew's group-writable Cellar is deliberately rejected by the installer.
	fs.copyFileSync(process.execPath, trustedBun, fs.constants.COPYFILE_FICLONE);
	fs.chmodSync(trustedBun, 0o700);
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** Separate synthetic Core process: no shell/file operations in tool input run. */
function provider(body: string) {
	const executable = path.join(root, `provider-${crypto.randomUUID()}`);
	fs.writeFileSync(
		executable,
		`#!${trustedBun}\nconst r = JSON.parse(await Bun.stdin.text());\n${body}\n`,
		{ mode: 0o700, flag: "wx" },
	);
	return { executable, args: [] };
}
function decision(value: string) {
	return provider(`console.log(JSON.stringify({requestId:r.requestId,
		operationDigest:r.operationDigest,decision:${JSON.stringify(value)},expiresAt:Date.now()+10000}));`);
}
function install(p = decision("allow"), timeoutMs = 1000) {
	return installNativeHookFixture(
		root,
		{ executable: trustedBun, args: [path.resolve("index.ts")] },
		binding,
		p,
		{ env, timeoutMs },
	);
}
async function invoke(
	fixture: ReturnType<typeof install>,
	raw = input(),
	extra: string[] = [],
	overrides = {},
) {
	const child = Bun.spawn(
		[fixture.command.executable, ...fixture.command.args, ...extra],
		{
			env: { ...fixture.env, ...overrides },
			stdin: new Blob([raw]),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(stderr).toBe("");
	expect(code).toBe(0);
	expect(stdout.trim().split("\n")).toHaveLength(1);
	expect(stdout).not.toContain("canary");
	return JSON.parse(stdout);
}

describe("private HOME hook subprocess gate (non-production)", () => {
	test("installed launcher and trusted hook config execute only explicit provider allow", async () => {
		const f = install();
		for (const dir of [
			f.home,
			path.join(f.home, "bin"),
			path.join(f.home, ".gemini/config"),
		])
			expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
		for (const file of ["native-hook.json", ".gemini/config/hooks.json"])
			expect(fs.statSync(path.join(f.home, file)).mode & 0o777).toBe(0o600);
		expect(fs.readdirSync(path.join(f.home, ".gemini"))).toEqual(["config"]);
		const config = JSON.parse(
			fs.readFileSync(path.join(f.home, ".gemini/config/hooks.json"), "utf8"),
		);
		expect(
			config["agentdock-native-permission"].PreToolUse[0].hooks[0].command,
		).toBe(`'${f.command.executable}'`);
		expect(await invoke(f)).toEqual({
			decision: "allow",
			reason: "AGY_NATIVE_CORE_ALLOWED",
		});
	}, 30_000);
	test("ask stays denied; deny and provider failures never authorize", async () => {
		for (const [p, reason] of [
			[decision("ask"), "AGY_NATIVE_CORE_APPROVAL_PENDING"],
			[decision("deny"), "AGY_NATIVE_CORE_DENIED"],
			[decision("future"), "AGY_NATIVE_CORE_RESPONSE_INVALID"],
			[
				provider('console.log("malformed-canary")'),
				"AGY_NATIVE_CORE_UNAVAILABLE",
			],
			[
				provider('console.error("secret-canary");process.exit(2)'),
				"AGY_NATIVE_CORE_UNAVAILABLE",
			],
			[
				provider('console.log("x".repeat(300000))'),
				"AGY_NATIVE_CORE_UNAVAILABLE",
			],
		] as const)
			expect(await invoke(install(p))).toEqual({ decision: "deny", reason });
		const p = decision("allow");
		const f = install(p);
		fs.unlinkSync(p.executable);
		expect((await invoke(f)).decision).toBe("deny");
	}, 30_000);
	test("unknown tool, malformed input and operation identity mismatch never reach provider", async () => {
		const marker = path.join(root, "called");
		const p = provider(
			`await Bun.write(${JSON.stringify(marker)}, "called"); process.exit(3);`,
		);
		const f = install(p);
		for (const raw of [
			"{",
			input("unknown-tool"),
			"x".repeat(300000),
			input().replace("conversation-1", "wrong"),
			input().replace("/synthetic/workspace", "/other"),
		]) {
			expect((await invoke(f, raw)).decision).toBe("deny");
			expect(fs.existsSync(marker)).toBe(false);
		}
	}, 30_000);
	test("timeout closes provider group and cancellation ignores late allow", async () => {
		const p = provider(
			'await Bun.sleep(2000); console.log(JSON.stringify({requestId:r.requestId,operationDigest:r.operationDigest,decision:"allow",expiresAt:Date.now()+1000}));',
		);
		expect(await invoke(install(p, 50))).toEqual({
			decision: "deny",
			reason: "AGY_NATIVE_CORE_TIMEOUT",
		});
		const controller = new AbortController();
		const pending = evaluateNativePermissionHook(
			input(),
			binding,
			subprocessNativeProvider(p),
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 30);
		expect(await pending).toEqual({
			decision: "deny",
			reason: "AGY_NATIVE_CORE_CANCELLED",
		});
	}, 30_000);
	test("subprocess replay, expired, digest substitution and wrong-owner responses deny", async () => {
		const cache = path.join(root, "reply");
		const replay = provider(`const file=Bun.file(${JSON.stringify(cache)});
			if(await file.exists()) console.log(await file.text());
			else {const reply=JSON.stringify({requestId:r.requestId,operationDigest:r.operationDigest,decision:"allow",expiresAt:Date.now()+10000});await Bun.write(file,reply);console.log(reply);}`);
		const f = install(replay);
		expect((await invoke(f)).decision).toBe("allow");
		expect((await invoke(f)).reason).toBe("AGY_NATIVE_CORE_RESPONSE_INVALID");
		for (const field of [
			'requestId:"wrong"',
			'operationDigest:"wrong"',
			"expiresAt:0",
		]) {
			const p = provider(
				`console.log(JSON.stringify({requestId:r.requestId,operationDigest:r.operationDigest,decision:"allow",expiresAt:Date.now()+1000,${field}}));`,
			);
			expect((await invoke(install(p))).reason).toBe(
				"AGY_NATIVE_CORE_RESPONSE_INVALID",
			);
		}
		const ownerGate = provider(`const expected=${JSON.stringify(binding)};
			console.log(JSON.stringify({requestId:r.requestId,operationDigest:r.operationDigest,
			decision:JSON.stringify(r.binding)===JSON.stringify(expected)?"allow":"deny",expiresAt:Date.now()+1000}));`);
		for (const key of [
			"ownerId",
			"adapterIncarnation",
			"sessionId",
			"turnId",
			"policyRevision",
		] as const) {
			const f = installNativeHookFixture(
				root,
				{ executable: trustedBun, args: [path.resolve("index.ts")] },
				{ ...binding, [key]: "stale" },
				ownerGate,
				{ env },
			);
			expect((await invoke(f)).reason).toBe("AGY_NATIVE_CORE_DENIED");
		}
	}, 30_000);
	test("opt-in is exact and cannot open the formal prompt gate", async () => {
		const p = decision("allow");
		for (const bad of [
			{},
			{ ...env, AGY_ACP_NATIVE_HOOK: "1" },
			{ ...env, AGY_ACP_AUTO_APPROVE: "1" },
			{ ...env, AGY_ACP_CHILD_ISOLATION: "optional" },
			{ ...env, AGY_EXTRA_ARGS: "--settings=canary" },
		]) {
			expect(() =>
				installNativeHookFixture(
					root,
					{ executable: process.execPath, args: [] },
					binding,
					p,
					{ env: bad },
				),
			).toThrow("Invalid native hook fixture");
		}
		const f = install(p);
		expect((await invoke(f, input(), ["--version"])).decision).toBe("deny");
		expect(
			(await invoke(f, input(), [], { AGY_ACP_NATIVE_HOOK: "" })).decision,
		).toBe("deny");
		expect(() => assertHeadlessApprovalSupported(f.env)).toThrow(
			"AGY_NATIVE_APPROVAL_UNAVAILABLE",
		);
	}, 30_000);
	test("symlink, unsafe permissions and manifest substitution fail closed", async () => {
		const p = decision("allow");
		const link = path.join(root, "link");
		fs.symlinkSync(p.executable, link);
		expect(() => install({ executable: link, args: [] })).toThrow();
		fs.chmodSync(p.executable, 0o777);
		expect(() => install(p)).toThrow();
		fs.chmodSync(p.executable, 0o700);
		fs.chmodSync(root, 0o755);
		expect(() => install(p)).toThrow();
		fs.chmodSync(root, 0o700);
		const f = install(p);
		const manifest = path.join(f.home, "native-hook.json");
		fs.chmodSync(manifest, 0o644);
		expect((await invoke(f)).decision).toBe("deny");
		fs.unlinkSync(manifest);
		fs.symlinkSync(path.join(root, "missing"), manifest);
		expect((await invoke(f)).decision).toBe("deny");
	}, 30_000);
});
