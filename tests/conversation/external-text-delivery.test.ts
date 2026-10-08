import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { conversationDbPath } from "../../src/conversation/database";
import { StreamPoller } from "../../src/conversation/streaming";
import { Translator } from "../../src/conversation/translator";
import { StepPayload } from "../../src/gen/steps";
import type { StepRow } from "../../src/types";

const row = (
	idx: number,
	text: string,
	status = 3,
	stepType = 15,
): StepRow => ({
	idx,
	stepType,
	status,
	stepPayload: StepPayload.create({ agentText: { text } }),
	error: null,
	permission: null,
	task: null,
	toolOutput: null,
});
const options = { mode: "stream" as const, skipNarration: false };

describe("offline handoff between verified text and the SQLite Translator", () => {
	let dir: string;
	let db: Database;
	let poller: StreamPoller;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-external-text-"));
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
	});
	afterEach(() => {
		poller.close();
		db.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const payload = (text: string) =>
		StepPayload.encode(StepPayload.create({ agentText: { text } })).finish();
	function add(idx: number, text: string, status = 3, type = 15) {
		db.query(
			"INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)",
		).run(idx, type, status, payload(text));
	}
	function rewrite(idx: number, text: string) {
		db.query("UPDATE steps SET step_payload=? WHERE idx=?").run(
			payload(text),
			idx,
		);
	}

	test("SQLite text is suppressed exactly once after reservation and ACK", () => {
		expect(poller.poll()).toEqual([]);
		add(1, "測試 🚀");
		const token = poller.reserveExternalText("conv", 1, "測試 🚀");
		expect(() => poller.poll()).toThrow("AGY_EXTERNAL_TEXT_DELIVERY_PENDING");
		poller.ackExternalText(token);
		expect(poller.poll()).toEqual([]);
		expect(poller.poll()).toEqual([]);
		expect(poller.hadUpdates).toBe(true);
		expect(poller.lastStepIdx).toBe(1);
	});
	test("a preceding DB tool/update cannot be overtaken by direct text", () => {
		poller.poll();
		add(1, "", 3, 8);
		add(2, "later", 3);
		expect(() => poller.reserveExternalText("conv", 2, "later")).toThrow(
			"AGY_EXTERNAL_TEXT_PRIOR_STEP_PENDING",
		);
		const updates = poller.poll();
		expect(updates.length).toBeGreaterThan(0);
		expect(() => poller.reserveExternalText("conv", 2, "later")).toThrow(
			"AGY_EXTERNAL_TEXT_UNVERIFIED",
		);
	});
	test("subsequent tool rows are still translated by SQLite, without repeating text", () => {
		expect(poller.poll()).toEqual([]);
		add(1, "hello");
		const token = poller.reserveExternalText("conv", 1, "hello");
		poller.ackExternalText(token);
		add(2, "", 3, 8);
		const updates = poller.poll();
		expect(
			updates.every((u) => u.sessionUpdate !== "agent_message_chunk"),
		).toBe(true);
		expect(updates.length).toBeGreaterThan(0);
	});
	test("SQLite mutation after an acknowledged send fails closed with no retried text", () => {
		poller.poll();
		add(1, "before");
		const token = poller.reserveExternalText("conv", 1, "before");
		poller.ackExternalText(token);
		rewrite(1, "after");
		expect(() => poller.poll()).toThrow("AGY_EXTERNAL_TEXT_DIVERGENCE");
		expect(() => poller.poll()).toThrow("AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN");
	});
	test("a previously acknowledged DB row disappearing is a non-retryable divergence", () => {
		poller.poll();
		add(1, "delivered");
		const token = poller.reserveExternalText("conv", 1, "delivered");
		poller.ackExternalText(token);
		db.query("DELETE FROM steps WHERE idx=1").run();
		expect(() => poller.poll()).toThrow("AGY_EXTERNAL_TEXT_DIVERGENCE");
		expect(() => poller.poll()).toThrow("AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN");
	});
	test("a completed DB row reverting to in-progress after external ACK fails closed", () => {
		poller.poll();
		add(1, "delivered");
		const token = poller.reserveExternalText("conv", 1, "delivered");
		poller.ackExternalText(token);
		db.query("UPDATE steps SET status=2 WHERE idx=1").run();
		expect(() => poller.poll()).toThrow("AGY_EXTERNAL_TEXT_DIVERGENCE");
	});
	test("duplicate DB identities after delivery cannot result in multiple text emissions", () => {
		poller.poll();
		add(1, "delivered");
		const token = poller.reserveExternalText("conv", 1, "delivered");
		poller.ackExternalText(token);
		add(1, "delivered");
		expect(() => poller.poll()).toThrow("AGY_EXTERNAL_TEXT_DIVERGENCE");
	});
	test("a second external reservation checks prior ACK even without another Poll", () => {
		poller.poll();
		add(1, "sent");
		const token = poller.reserveExternalText("conv", 1, "sent");
		poller.ackExternalText(token);
		add(2, "next");
		db.query("UPDATE steps SET status=2 WHERE idx=1").run();
		expect(() => poller.reserveExternalText("conv", 2, "next")).toThrow(
			"AGY_EXTERNAL_TEXT_DIVERGENCE",
		);
		expect(() => poller.poll()).toThrow("AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN");
	});
	test("ambiguous external send permanently blocks automatic SQLite replay", () => {
		poller.poll();
		add(1, "hello");
		const token = poller.reserveExternalText("conv", 1, "hello");
		poller.abortExternalText(token);
		expect(() => poller.ackExternalText(token)).toThrow(
			"AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN",
		);
		expect(() => poller.poll()).toThrow("AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN");
	});
	test("unbound DB identity, incomplete rows and mismatched text cannot reserve", () => {
		expect(() => poller.reserveExternalText("conv", 1, "hello")).toThrow(
			"AGY_EXTERNAL_TEXT_UNBOUND",
		);
		poller.poll();
		add(1, "hello", 2);
		expect(() => poller.reserveExternalText("wrong", 1, "hello")).toThrow(
			"AGY_EXTERNAL_TEXT_UNBOUND",
		);
		expect(() => poller.reserveExternalText("conv", 1, "hello")).toThrow(
			"AGY_EXTERNAL_TEXT_UNVERIFIED",
		);
		db.query("UPDATE steps SET status=3 WHERE idx=1").run();
		expect(() => poller.reserveExternalText("conv", 1, "fake")).toThrow(
			"AGY_EXTERNAL_TEXT_UNVERIFIED",
		);
		expect(() => poller.reserveExternalText("conv", 2, "hello")).toThrow(
			"AGY_EXTERNAL_TEXT_PRIOR_STEP_PENDING",
		);
	});
	test("already-emitted SQLite text may never be reserved by another output source", () => {
		poller.poll();
		add(1, "hello");
		expect(poller.poll()[0]?.sessionUpdate).toBe("agent_message_chunk");
		expect(() => poller.reserveExternalText("conv", 1, "hello")).toThrow(
			"AGY_EXTERNAL_TEXT_UNVERIFIED",
		);
	});
	test("replay translator remains independent of external delivery", () => {
		const translator = new Translator({ mode: "replay", skipNarration: false });
		expect(() =>
			translator.reserveExternalText(row(1, "hello"), "hello"),
		).toThrow("AGY_EXTERNAL_TEXT_UNAVAILABLE");
		const updates = translator.translate([row(1, "hello")]);
		expect(updates[0]?.sessionUpdate).toBe("agent_message_chunk");
	});
	test("token must match, and finished row cannot be reserved twice", () => {
		const translator = new Translator(options);
		const token = translator.reserveExternalText(row(1, "hello"), "hello");
		expect(() => translator.ackExternalText(token + 1)).toThrow(
			"AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN",
		);
		translator.ackExternalText(token);
		expect(() =>
			translator.reserveExternalText(row(1, "hello"), "hello"),
		).toThrow("AGY_EXTERNAL_TEXT_UNVERIFIED");
		expect(translator.translate([row(1, "hello")])).toEqual([]);
	});
	test("reservation rejects preceding DB text, nonterminal rows and stale indices", () => {
		const translator = new Translator(options);
		expect(() =>
			translator.reserveExternalText(row(1, "hello", 2), "hello"),
		).toThrow("AGY_EXTERNAL_TEXT_UNVERIFIED");
		expect(() =>
			translator.reserveExternalText(row(1, "hello", 3, 8), "hello"),
		).toThrow("AGY_EXTERNAL_TEXT_UNVERIFIED");
		translator.translate([row(3, "later")]);
		expect(() =>
			translator.reserveExternalText(row(2, "earlier"), "earlier"),
		).toThrow("AGY_EXTERNAL_TEXT_UNVERIFIED");
	});
});
