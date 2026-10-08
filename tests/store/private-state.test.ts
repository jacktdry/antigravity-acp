import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	readPrivateState,
	resolveStateDir,
	writePrivateState,
} from "../../src/store/private-state";

describe("Next private ACP state", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync("/private/tmp/agy-state-test-");
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});
	test("legacy remains HOME-based; invalid opt-ins fail without echoing input", () => {
		expect(resolveStateDir("/legacy")).toBe("/legacy/.agy-acp");
		for (const value of ["", "relative", "/", "/a/..", "canary-secret\0"])
			expect(() => resolveStateDir("/legacy", value)).toThrow(
				"Unsafe AGY_ACP_STATE_DIR or state file",
			);
	});
	test("private directories and atomic files use 0700/0600", () => {
		const dir = resolveStateDir("/legacy", path.join(root, "next", "state"));
		for (const name of ["sessions.json", "models.json"]) {
			const file = path.join(dir, name);
			expect(readPrivateState(file)).toBeNull();
			writePrivateState(file, "first");
			writePrivateState(file, "second");
			expect(readPrivateState(file)).toBe("second");
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		}
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
		expect(fs.readdirSync(dir).sort()).toEqual([
			"models.json",
			"sessions.json",
		]);
	});
	test("rejects symlink ancestors, dangling links and permissive state", () => {
		const target = path.join(root, "target");
		fs.mkdirSync(target, { mode: 0o700 });
		fs.symlinkSync(target, path.join(root, "link"));
		fs.symlinkSync(path.join(root, "missing"), path.join(root, "dangling"));
		for (const name of ["link/state", "dangling/state"])
			expect(() => resolveStateDir(root, path.join(root, name))).toThrow();
		fs.chmodSync(target, 0o755);
		expect(() => resolveStateDir(root, target)).toThrow();
		fs.chmodSync(target, 0o777);
		expect(() => resolveStateDir(root, path.join(target, "state"))).toThrow();
	});
	test("rejects leaf links, hardlinks, directories and broad file permissions", () => {
		const target = path.join(root, "keep");
		const file = path.join(root, "sessions.json");
		fs.writeFileSync(target, "keep", { mode: 0o600 });
		for (const kind of ["symlink", "hardlink", "directory", "public"]) {
			if (kind === "symlink") fs.symlinkSync(target, file);
			if (kind === "hardlink") fs.linkSync(target, file);
			if (kind === "directory") fs.mkdirSync(file);
			if (kind === "public") fs.writeFileSync(file, "public", { mode: 0o644 });
			expect(() => readPrivateState(file)).toThrow();
			expect(() => writePrivateState(file, "overwrite")).toThrow();
			fs.rmSync(file, { recursive: true });
			expect(fs.readFileSync(target, "utf8")).toBe("keep");
		}
	});
	test("rechecks a directory replaced after startup", () => {
		const dir = path.join(root, "state");
		fs.mkdirSync(dir, { mode: 0o700 });
		resolveStateDir(root, dir);
		fs.renameSync(dir, `${dir}-old`);
		fs.symlinkSync(`${dir}-old`, dir);
		expect(() =>
			writePrivateState(path.join(dir, "models.json"), "[]"),
		).toThrow();
	});
	test("fresh module env derives both stores without changing conversation storage", async () => {
		const entry = path.resolve("src/constants/index.ts");
		for (const isolated of [false, true]) {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				HOME: root,
				AGY_CONVERSATIONS_DIR: "/explicit/conversations",
			};
			delete env.AGY_ACP_STATE_DIR;
			if (isolated) env.AGY_ACP_STATE_DIR = path.join(root, "next");
			const proc = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import * as c from ${JSON.stringify(entry)}; console.log(JSON.stringify([c.STATE_DIR,c.SESSIONS_FILE,c.MODELS_CACHE_FILE,c.CONVERSATION_DIR]))`,
				],
				{ env, stdout: "pipe", stderr: "pipe" },
			);
			expect(await proc.exited).toBe(0);
			const dir = path.join(root, isolated ? "next" : ".agy-acp");
			expect(JSON.parse(await new Response(proc.stdout).text())).toEqual([
				dir,
				path.join(dir, "sessions.json"),
				path.join(dir, "models.json"),
				"/explicit/conversations",
			]);
		}
	});
});

test("opt-in SessionStore and model cache persist privately and propagate unsafe paths", async () => {
	const root = fs.mkdtempSync("/private/tmp/agy-store-integration-");
	const state = path.join(root, "state");
	const modules = [
		"src/store/sessionStore.ts",
		"src/acp/agent.ts",
		"src/types/session.ts",
	].map((p) => JSON.stringify(path.resolve(p)));
	const script = `
import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionStore } from ${modules[0]};
import { AgyAcpAgent } from ${modules[1]};
import { newSession } from ${modules[2]};
const state = ${JSON.stringify(state)};
spyOn(fs,"mkdtempSync").mockImplementation(() => { throw new Error("fixture-only discovery disabled"); });
const config = { binary:"fixture",workingDir:${JSON.stringify(root)},conversationsDir:${JSON.stringify(root)},skipNarration:false };
new AgyAcpAgent(config);
await Bun.sleep(0);
const store = new SessionStore();
await store.persist("next",newSession("/cwd"));
expect((await store.restore("next"))?.cwd).toBe("/cwd");
for (const name of ["models.json","sessions.json"]) expect(fs.statSync(path.join(state,name)).mode & 0o777).toBe(0o600);
expect(fs.existsSync(path.join(${JSON.stringify(root)},".agy-acp"))).toBe(false);
fs.chmodSync(path.join(state,"sessions.json"),0o644);
await expect(store.persist("unsafe",newSession("/cwd"))).rejects.toThrow("Unsafe AGY_ACP_STATE_DIR or state file");
await expect(store.list()).rejects.toThrow("Unsafe AGY_ACP_STATE_DIR or state file");
fs.chmodSync(path.join(state,"sessions.json"),0o600);
await store.persist("recovered",newSession("/cwd"));
expect(await store.delete("next")).toBe(true);
expect(await store.restore("recovered")).not.toBeNull();
fs.renameSync(path.join(state,"models.json"),path.join(state,"keep.json"));
fs.symlinkSync(path.join(state,"keep.json"),path.join(state,"models.json"));
expect(() => new AgyAcpAgent(config)).toThrow("Private ACP model cache unavailable");
console.log("private stores fixtures passed");
`;
	try {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: root,
			AGY_ACP_STATE_DIR: state,
		};
		const proc = Bun.spawn([process.execPath, "-e", script], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toBe("");
		expect(await proc.exited).toBe(0);
		expect((await new Response(proc.stdout).text()).trim()).toBe(
			"private stores fixtures passed",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
