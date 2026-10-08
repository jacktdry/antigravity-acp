/**
 * Synthetic cross-source recovery harness. This does not run AGY or send a
 * real ACP notification. The sender behaves like an unreliable remote client.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StreamDirectLedger } from "../../src/agy/stream-direct-ledger";
import type { PocEvent } from "../../src/agy/stream-json-poc";
import {
	ConversationDb,
	conversationDbPath,
} from "../../src/conversation/database";
import { StreamPoller } from "../../src/conversation/streaming";
import { Translator } from "../../src/conversation/translator";
import { StepPayload } from "../../src/gen/steps";

const init: PocEvent = {
	event: "init",
	conversation_id: "conv",
	init: { cwd: "/synthetic", tools: [] },
};
const step = (
	index: number,
	text: string,
	type = "agent_response",
): PocEvent => ({
	event: "step_update",
	step_update: {
		conversation_id: "conv",
		step_index: index,
		state: "DONE",
		step_type: type,
		text_delta: text,
	},
});
const result = (status = "SUCCESS"): PocEvent => ({
	event: "result",
	result: { conversation_id: "conv", status, response: "", num_turns: 1 },
});

describe("cross-event DB/stream delivery and recovery (offline only)", () => {
	let dir: string;
	let db: Database;
	let poller: StreamPoller;
	let ledger: StreamDirectLedger;
	let sent: string[];

	function add(idx: number, text: string, status = 3, kind = 15) {
		const bytes = StepPayload.encode(
			StepPayload.create({ agentText: { text } }),
		).finish();
		db.query(
			"INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)",
		).run(idx, kind, status, bytes);
	}
	function change(idx: number, text: string, status = 3) {
		const bytes = StepPayload.encode(
			StepPayload.create({ agentText: { text } }),
		).finish();
		db.query("UPDATE steps SET step_payload = ?, status = ? WHERE idx = ?").run(
			bytes,
			status,
			idx,
		);
	}
	function sourceRows() {
		const conn = ConversationDb.open(dir, "conv");
		if (!conn) throw new Error("missing synthetic DB");
		try {
			return conn.readAfter(-1);
		} finally {
			conn.close();
		}
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-xevent-"));
		db = new Database(conversationDbPath(dir, "conv"));
		db.query(
			"CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)",
		).run();
		poller = new StreamPoller({
			dir,
			conversationId: "conv",
			baseStepIdx: -1,
			skipNarration: false,
			snapshot: null,
		});
		// Bind to an empty but already open SQLite DB; no text reaches the client.
		expect(poller.poll()).toEqual([]);
		ledger = new StreamDirectLedger("conv", -1);
		sent = [];
	});
	afterEach(() => {
		poller.close();
		db.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	function accept(...events: PocEvent[]) {
		for (const e of events) ledger.accept(e);
	}

	/** Offline two-ledger handoff, never called from Adapter.runPrompt. */
	async function publish(
		send: (text: string) => Promise<void> = async (text) => {
			sent.push(text);
		},
	) {
		const candidates = ledger.verifyDb("conv", sourceRows());
		for (const { stepIndex, text } of candidates) {
			const dbToken = poller.reserveExternalText("conv", stepIndex, text);
			const held = ledger.reserve(stepIndex);
			if (!held) {
				poller.abortExternalText(dbToken);
				ledger.failDelivery();
				throw new Error("AGY_DIRECT_DELIVERY_UNCERTAIN");
			}
			try {
				await send(held.text);
				poller.ackExternalText(dbToken);
				ledger.ack(stepIndex);
			} catch {
				try {
					poller.abortExternalText(dbToken);
				} catch {
					/* prior ACK cannot be undone */
				}
				ledger.failDelivery();
				throw new Error("AGY_DIRECT_DELIVERY_UNCERTAIN");
			}
		}
	}

	test("UTF-8 chunks aggregate into one verified client update, never duplicate through DB", async () => {
		accept(init, step(1, "繁"), step(1, "體"), step(1, " 🚀"), result());
		add(1, "繁體 🚀");
		await publish();
		expect(sent).toEqual(["繁體 🚀"]);
		expect(poller.poll()).toEqual([]);
		expect(poller.poll()).toEqual([]);
		expect(ledger.committed).toEqual([{ stepIndex: 1, text: "繁體 🚀" }]);
	});
	test("missing/unfinished rows defer emission until matching terminal DB row exists", async () => {
		accept(init, step(1, "hello"), result());
		expect(ledger.verifyDb("conv", sourceRows())).toEqual([]);
		add(1, "hel", 2);
		await publish();
		expect(sent).toEqual([]);
		change(1, "hello", 3);
		await publish();
		expect(sent).toEqual(["hello"]);
	});
	test("tool step fails direct admission and remains SQLite-owned", async () => {
		accept(init, step(1, "text"), step(2, "", "tool"), result());
		add(1, "text");
		add(2, "", 3, 8);
		await publish();
		expect(sent).toEqual([]);
		expect(ledger.errorCode).toBe("UNSUPPORTED_STEP");
		const updates = poller.poll();
		expect(updates.some((x) => x.sessionUpdate === "agent_message_chunk")).toBe(
			true,
		);
		expect(updates.some((x) => x.sessionUpdate === "tool_call")).toBe(true);
	});
	test("mismatched stream text cannot be emitted and SQLite remains authoritative", async () => {
		accept(init, step(1, "upstream"), result());
		add(1, "database");
		await publish();
		expect(sent).toEqual([]);
		expect(ledger.errorCode).toBe("DB_TEXT_MISMATCH");
		const updates = poller.poll();
		expect(
			updates.filter((x) => x.sessionUpdate === "agent_message_chunk"),
		).toHaveLength(1);
	});
	test("one successful chunk followed by uncertain second delivery forbids blind fallback", async () => {
		accept(init, step(1, "first"), step(2, "second"), result());
		add(1, "first");
		add(2, "second");
		let count = 0;
		await expect(
			publish(async (text) => {
				count++;
				sent.push(text);
				if (count === 2) throw new Error("remote may already have delivered");
			}),
		).rejects.toThrow("AGY_DIRECT_DELIVERY_UNCERTAIN");
		expect(sent).toEqual(["first", "second"]);
		expect(ledger.committed).toEqual([{ stepIndex: 1, text: "first" }]);
		expect(ledger.safeToRetry).toBe(false);
		expect(() => poller.poll()).toThrow("AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN");
	});
	test("DB rewrite or deletion after ACK seals all future updates", async () => {
		accept(init, step(1, "sent"), result());
		add(1, "sent");
		await publish();
		change(1, "rewritten");
		expect(() => poller.poll()).toThrow("AGY_EXTERNAL_TEXT_DIVERGENCE");
		expect(ledger.verifyDb("conv", sourceRows())).toEqual([]);
		expect(ledger.errorCode).toBe("POST_COMMIT_DIVERGENCE");
	});
	test("late client resolution after cancellation cannot produce an acknowledged ledger", async () => {
		accept(init, step(1, "text"), result());
		add(1, "text");
		let resolve!: () => void;
		const blocked = new Promise<void>((r) => {
			resolve = r;
		});
		let started!: () => void;
		const pending = new Promise<void>((r) => {
			started = r;
		});
		const send = publish(async (text) => {
			sent.push(text);
			started();
			await blocked;
			throw new Error("client delivery unknown");
		});
		await pending;
		ledger.cancel();
		resolve();
		await expect(send).rejects.toThrow("AGY_DIRECT_DELIVERY_UNCERTAIN");
		expect(ledger.errorCode).toBe("DELIVERY_UNCERTAIN");
		expect(ledger.safeToRetry).toBe(false);
	});
	test("upstream error, duplicate init and wrong conversation never offer text", async () => {
		accept(init, step(1, "text"), result("ERROR"));
		add(1, "text");
		await publish();
		expect(sent).toEqual([]);
		expect(ledger.errorCode).toBe("UPSTREAM_FAILURE");
		const duplicate = new StreamDirectLedger("conv", -1);
		duplicate.accept(init);
		duplicate.accept(init);
		expect(duplicate.errorCode).toBe("INVALID_ORDER");
		const wrong = new StreamDirectLedger("other", -1);
		wrong.accept(init);
		expect(wrong.errorCode).toBe("IDENTITY_MISMATCH");
	});
	test("resumed session excludes history before baseStepIdx and does not duplicate a prior turn", async () => {
		// The resumed poller and ledger begin after an already persisted turn.
		poller.close();
		add(10, "historical");
		poller = new StreamPoller({
			dir,
			conversationId: "conv",
			baseStepIdx: 10,
			skipNarration: false,
			snapshot: null,
		});
		ledger = new StreamDirectLedger("conv", 10);
		expect(poller.poll()).toEqual([]);
		accept(init, step(11, "new turn"), result());
		add(11, "new turn");
		const ready = ledger.verifyDb("conv", sourceRows());
		expect(ready).toEqual([{ stepIndex: 11, text: "new turn" }]);
		await publish();
		expect(sent).toEqual(["new turn"]);
		expect(poller.poll()).toEqual([]);
	});
	test("replay is independently DB-backed after successful external delivery", async () => {
		accept(init, step(1, "text"), result());
		add(1, "text");
		await publish();
		expect(poller.poll()).toEqual([]);
		const replay = new Translator({ mode: "replay", skipNarration: false });
		const replayText = replay.translate(sourceRows());
		expect(
			replayText.filter((x) => x.sessionUpdate === "agent_message_chunk"),
		).toHaveLength(1);
	});
});
