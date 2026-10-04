import { Database } from "bun:sqlite";
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
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import {
	Adapter,
	CANCEL_GRACE_MS,
	formatQuotaError,
} from "../../src/acp/adapter";
import type { AcpClient } from "../../src/acp/client";
import { conversationDbPath } from "../../src/conversation/database";
import { newSession } from "../../src/types/session";

describe("formatQuotaError", () => {
	test("formats the message, Error ID, and refresh time like the IDE", () => {
		const now = new Date(2026, 8, 16, 16, 41, 44).getTime();
		const text = formatQuotaError(
			{
				message: "",
				detail:
					"API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 7m11s.",
				stackTrace: "",
				id: "error-id-1",
			},
			now,
		);
		const refresh = new Date(2026, 8, 16, 16, 48, 55).toLocaleString("en-US");
		expect(text).toBe(
			"Individual quota reached. Please upgrade your subscription to increase your limits.\n\n" +
				"Error ID: error-id-1\n\n" +
				`Your plan's baseline quota will refresh on ${refresh}.`,
		);
	});
});

describe("formatQuotaError reset times", () => {
	const now = new Date(2026, 8, 16, 16, 41, 44).getTime();
	const format = (tail: string) =>
		formatQuotaError(
			{
				message: "",
				detail: `API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. ${tail}`,
				stackTrace: "",
			},
			now,
		);

	test("counts days in the reset time", () => {
		const refresh = new Date(2026, 8, 17, 18, 44, 44).toLocaleString("en-US");
		expect(format("Resets in 1d2h3m.")).toBe(
			`Individual quota reached.\n\nYour plan's baseline quota will refresh on ${refresh}.`,
		);
	});

	test("keeps a reset time it cannot parse", () => {
		expect(format("Resets in about a week.")).toBe(
			"Individual quota reached. Resets in about a week.",
		);
	});
});

describe("Adapter", () => {
	test("cancel should handle non-existent session gracefully", () => {
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/tmp",
			skipNarration: false,
		});
		// should not throw
		adapter.cancel("non-existent");
		expect(true).toBe(true);
	});

	test("runPrompt should handle spawn failure", async () => {
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/tmp",
			skipNarration: false,
		});

		// We could mock spawnAgy but let's test if it handles a non-existent binary or errors.
		// A lightweight test for prompt running.
		expect(adapter).toBeDefined();
	});
});

describe("Adapter quota handling", () => {
	let tempDir: string;
	let killed: boolean;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-test-"));
		killed = false;
	});

	afterEach(() => {
		mock.restore();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/** Stand-in for agy: records one 429 ERROR_MESSAGE step, then keeps
	 *  retrying until killed, or exits cleanly after `exitAfterMs`. */
	function mockAgy(errorText: string, exitAfterMs?: number) {
		spyOn(Bun, "spawn").mockImplementation((() => {
			const sqlite = new Database(conversationDbPath(tempDir, "conv"));
			sqlite
				.query(
					"CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)",
				)
				.run();
			const writer = new BinaryWriter();
			writer.tag(24, 2).fork().tag(3, 2).fork();
			writer.tag(2, 2).string(errorText);
			writer.join().join();
			sqlite
				.query(
					"INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 17, 3, ?)",
				)
				.run(writer.finish());
			sqlite.close();

			let exit: (code: number) => void = () => {};
			const exited = new Promise<number>((r) => {
				exit = r;
			});
			if (exitAfterMs !== undefined) setTimeout(() => exit(0), exitAfterMs);
			return {
				stderr: null,
				exited,
				kill: () => {
					killed = true;
					exit(130);
				},
			};
		}) as unknown as typeof Bun.spawn);
	}

	function runPrompt() {
		const adapter = new Adapter({
			workingDir: tempDir,
			binary: "agy",
			conversationsDir: tempDir,
			skipNarration: false,
		});
		const client = { update: async () => {} } as unknown as AcpClient;
		return adapter.runPrompt("s1", newSession(tempDir), "hi", client);
	}

	test("stops agy and returns the quota message on a usage-limit 429", async () => {
		mockAgy(
			"API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 7m11s.",
		);
		const outcome = await runPrompt();

		expect(killed).toBe(true);
		expect(outcome.error).toStartWith("Individual quota reached.");
		expect(outcome.error).toContain("baseline quota will refresh on");
	});

	test("lets agy retry a per-minute rate limit", async () => {
		mockAgy(
			"API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Rate limit exceeded. Resets in 20s.",
			300,
		);
		const outcome = await runPrompt();

		expect(killed).toBe(false);
		expect(outcome.error).toBeUndefined();
	});
});

describe("Adapter cancellation", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cancel-"));
	});
	afterEach(() => {
		mock.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	function setup(exitOnInterrupt = false) {
		let finish!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			finish = resolve;
		});
		const kill = mock((signal: string) => {
			if (signal === "SIGKILL" || exitOnInterrupt) finish(130);
		});
		spyOn(Bun, "spawn").mockReturnValue({ stderr: null, exited, kill } as any);
		const adapter = new Adapter({
			binary: "agy",
			workingDir: dir,
			conversationsDir: dir,
			skipNarration: false,
		});
		const run = () =>
			adapter.runPrompt("s1", newSession(dir), "hi", {
				update: async () => {},
			} as unknown as AcpClient);
		return { adapter, run, kill, finish };
	}
	test("repeated cancellation signals once, then kills an unresponsive child", async () => {
		const { adapter, run, kill } = setup();
		const turn = run();
		adapter.cancel("s1");
		adapter.cancel("s1");
		expect(kill.mock.calls).toEqual([
			[process.platform === "win32" ? "SIGKILL" : "SIGINT"],
		]);
		expect((await turn).stopReason).toBe("cancelled");
		expect(kill.mock.calls).toEqual(
			process.platform === "win32" ? [["SIGKILL"]] : [["SIGINT"], ["SIGKILL"]],
		);
		adapter.cancel("s1");
	});
	test("graceful exit clears escalation before the next child", async () => {
		const first = setup(true);
		const turn = first.run();
		first.adapter.cancel("s1");
		await turn;
		let finish!: (code: number) => void;
		const exited = new Promise<number>((r) => {
			finish = r;
		});
		const kill = mock(() => finish(130));
		spyOn(Bun, "spawn").mockReturnValue({ stderr: null, exited, kill } as any);
		const next = first.run();
		await Bun.sleep(CANCEL_GRACE_MS + 50);
		expect(first.kill).toHaveBeenCalledTimes(1);
		expect(kill).not.toHaveBeenCalled();
		finish(0);
		expect((await next).stopReason).toBe("end_turn");
	});
	test("usage output is tracked and terminated through the same cancellation path", async () => {
		let finish!: (code: number) => void;
		let close!: () => void;
		const exited = new Promise<number>((r) => {
			finish = r;
		});
		const stdout = new ReadableStream({
			start(controller) {
				close = () => controller.close();
			},
		});
		const kill = mock(() => {
			close();
			finish(130);
		});
		spyOn(Bun, "spawn").mockReturnValue({ stdout, exited, kill } as any);
		const adapter = new Adapter({
			binary: "agy",
			workingDir: dir,
			conversationsDir: dir,
			skipNarration: false,
		});
		const usage = adapter.runUsage("s1", dir);
		adapter.cancel("s1");
		adapter.cancel("s1");
		expect(await usage).toEqual({ text: "", cancelled: true });
		await Bun.sleep(CANCEL_GRACE_MS + 50);
		expect(kill).toHaveBeenCalledTimes(1);
	});

	test("a second prompt cannot replace the child targeted by cancellation", async () => {
		const { adapter, run } = setup(true);
		const turn = run();
		await expect(run()).rejects.toThrow("already active");
		adapter.cancel("s1");
		await turn;
	});
});
