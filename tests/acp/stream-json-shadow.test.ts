import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { Adapter } from "../../src/acp/adapter";
import type { AcpClient } from "../../src/acp/client";
import { conversationDbPath } from "../../src/conversation/database";
import { ReplayCache } from "../../src/conversation/replay";
import { StepPayload } from "../../src/gen/steps";
import { newSession } from "../../src/types/session";
import { init, result, step, stdout } from "../agy/stream-json-runtime.test";

describe("Adapter Legacy/shadow parity (mock spawn only)", () => {
	let dir: string;
	const savedMode = process.env.AGY_ACP_STREAM_JSON;
	const savedExtra = process.env.AGY_EXTRA_ARGS;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-shadow-"));
		delete process.env.AGY_EXTRA_ARGS;
	});
	afterEach(() => {
		mock.restore();
		if (savedMode === undefined) delete process.env.AGY_ACP_STREAM_JSON;
		else process.env.AGY_ACP_STREAM_JSON = savedMode;
		if (savedExtra === undefined) delete process.env.AGY_EXTRA_ARGS;
		else process.env.AGY_EXTRA_ARGS = savedExtra;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	function createDb(text = "hello", status = 2) {
		const db = new Database(conversationDbPath(dir, "conv"));
		db.exec("CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)");
		db.query("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (1, 15, ?, ?)")
			.run(status, StepPayload.encode(StepPayload.create({ agentText: { text } })).finish());
		db.close();
	}
	function adapter() {
		return new Adapter({ binary: "mock-agy-never-launch", workingDir: dir, conversationsDir: dir, skipNarration: false });
	}
	function client(updates: SessionUpdate[]) {
		return { update: async (_id: string, update: SessionUpdate) => { updates.push(update); } } as AcpClient;
	}
	for (const mode of [undefined, "shadow"]) {
		for (const code of [0, 1]) {
			test(`${mode ?? "Legacy"}: exit ${code} with DB text preserves existing outcome and exactly one notification`, async () => {
				if (mode) process.env.AGY_ACP_STREAM_JSON = mode;
				else delete process.env.AGY_ACP_STREAM_JSON;
				const spawn = spyOn(Bun, "spawn").mockImplementation((() => {
					createDb(); // status remains ACTIVE: shadow cannot reject Legacy success
					return { stdout: stdout([init, step("he", "ACTIVE"), step("llo"), result()]), stderr: null, exited: Promise.resolve(code), kill: mock() };
				}) as any);
				const updates: SessionUpdate[] = [];
				const outcome = await adapter().runPrompt("s", newSession(dir), "fixture", client(updates));
				expect(outcome).toEqual({ stopReason: "end_turn", conversationId: "conv", lastStepIdx: 1, hadUpdates: true });
				expect(updates).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }]);
				const [args, opts] = spawn.mock.calls[0] as any;
				expect(opts.stdout).toBe(mode ? "pipe" : "ignore");
				expect(opts.stdin).toBe("ignore");
				if (mode) {
					expect(args.indexOf("--output-format")).toBeLessThan(args.indexOf("-p"));
					expect(args.slice(1, 3)).toEqual(["--output-format", "stream-json"]);
				} else expect(args).not.toContain("--output-format");
				expect(args).not.toContain("--input-format");
			});
		}
		test(`${mode ?? "Legacy"}: nonzero without DB updates surfaces failure`, async () => {
			if (mode) process.env.AGY_ACP_STREAM_JSON = mode;
			else delete process.env.AGY_ACP_STREAM_JSON;
			spyOn(Bun, "spawn").mockReturnValue({ stdout: stdout([init, result()]), stderr: null, exited: Promise.resolve(1), kill: mock() } as any);
			const updates: SessionUpdate[] = [];
			const outcome = await adapter().runPrompt("s", newSession(dir), "fixture", client(updates));
			expect(outcome.error).toBe("agy exited with status: 1");
			expect(updates).toEqual([]); // result.response is never promoted to ACP text
		});
		test(`${mode ?? "Legacy"}: cancel remains idempotent and flushes DB only`, async () => {
			if (mode) process.env.AGY_ACP_STREAM_JSON = mode;
			else delete process.env.AGY_ACP_STREAM_JSON;
			let exit!: (code: number) => void;
			const exited = new Promise<number>((resolve) => { exit = resolve; });
			const kill = mock(() => exit(130));
			spyOn(Bun, "spawn").mockImplementation((() => {
				createDb();
				return { stdout: stdout([init, step("late"), result()]), stderr: null, exited, kill };
			}) as any);
			const a = adapter();
			const updates: SessionUpdate[] = [];
			const turn = a.runPrompt("s", newSession(dir), "fixture", client(updates));
			a.cancel("s");
			a.cancel("s");
			expect((await turn).stopReason).toBe("cancelled");
			expect(kill).toHaveBeenCalledTimes(1);
			expect(updates).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }]);
		});
	}
	for (const events of [
		[init, { event: "future", payload: "SECRET_CANARY" }],
		[init, step("hello")], // missing result
		[init, result("ERROR")],
		[init, step("different"), result()],
	]) {
		test(`shadow fallback ${JSON.stringify(events.at(-1))} preserves SQLite outcome`, async () => {
			process.env.AGY_ACP_STREAM_JSON = "shadow";
			const diagnostic = spyOn(console, "error").mockImplementation(() => {});
			spyOn(Bun, "spawn").mockImplementation((() => {
				createDb();
				return { stdout: stdout(events), stderr: null, exited: Promise.resolve(0), kill: mock() };
			}) as any);
			const updates: SessionUpdate[] = [];
			const outcome = await adapter().runPrompt("s", newSession(dir), "fixture", client(updates));
			expect(outcome.error).toBeUndefined();
			expect(updates).toHaveLength(1);
			expect(diagnostic.mock.calls.flat().join(" ")).toContain("shadow fallback:");
			expect(diagnostic.mock.calls.flat().join(" ")).not.toContain("SECRET_CANARY");
		});
	}
	test("stream-only text/events emit no ACP notification or persistence identity", async () => {
		process.env.AGY_ACP_STREAM_JSON = "shadow";
		spyOn(Bun, "spawn").mockReturnValue({ stdout: stdout([init, step("hello"), result()]), stderr: null, exited: Promise.resolve(0), kill: mock() } as any);
		const updates: SessionUpdate[] = [];
		const outcome = await adapter().runPrompt("s", newSession(dir), "fixture", client(updates));
		expect(outcome.conversationId).toBeNull();
		expect(outcome.lastStepIdx).toBe(-1);
		expect(outcome.hadUpdates).toBe(false);
		expect(updates).toEqual([]);
	});
	test("slow stdout with pipe held after child exit finishes boundedly and does not kill child", async () => {
		process.env.AGY_ACP_STREAM_JSON = "shadow";
		let cancelled = false;
		const kill = mock();
		spyOn(Bun, "spawn").mockImplementation((() => {
			createDb();
			return { stdout: new ReadableStream({ cancel() { cancelled = true; } }), stderr: null, exited: Promise.resolve(0), kill };
		}) as any);
		const began = Date.now();
		const outcome = await adapter().runPrompt("s", newSession(dir), "fixture", client([]));
		expect(Date.now() - began).toBeLessThan(2500);
		expect(cancelled).toBe(true);
		expect(kill).not.toHaveBeenCalled();
		expect(outcome.error).toBeUndefined();
	});
	test("restored session uses only new DB steps; image prompt remains intact and replay unchanged", async () => {
		process.env.AGY_ACP_STREAM_JSON = "shadow";
		createDb("historical", 3);
		const session = newSession(dir);
		session.conversationId = "conv";
		session.lastStepIdx = 1;
		const prompt = "[User attached an image file. Absolute path: /fixture/image.png]";
		const spawn = spyOn(Bun, "spawn").mockImplementation((() => {
			const db = new Database(conversationDbPath(dir, "conv"));
			db.query("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (2, 15, 3, ?)")
				.run(StepPayload.encode(StepPayload.create({ agentText: { text: "new" } })).finish());
			db.close();
			return { stdout: stdout([init, step("new", "DONE", 2), result()]), stderr: null, exited: Promise.resolve(0), kill: mock() };
		}) as any);
		const updates: SessionUpdate[] = [];
		const outcome = await adapter().runPrompt("s", session, prompt, client(updates));
		expect(outcome.lastStepIdx).toBe(2);
		expect(updates).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new" } }]);
		const args = spawn.mock.calls[0]![0] as string[];
		expect(args.slice(args.indexOf("-p"))).toEqual(["-p", prompt]);
		expect(args).toContain("--conversation");
		expect(new ReplayCache().get(dir, "conv", { skipNarration: false })?.maxIdx).toBe(2);
	});
	test("invalid gate or extra args refuses before spawn", async () => {
		const spawn = spyOn(Bun, "spawn");
		process.env.AGY_ACP_STREAM_JSON = "text";
		expect((await adapter().runPrompt("s", newSession(dir), "fixture", client([]))).error).toContain("disabled or shadow");
		process.env.AGY_ACP_STREAM_JSON = "shadow";
		process.env.AGY_EXTRA_ARGS = "--input-format stream-json";
		expect((await adapter().runPrompt("s", newSession(dir), "fixture", client([]))).error).toContain("AGY_EXTRA_ARGS");
		expect(spawn).not.toHaveBeenCalled();
	});
});
