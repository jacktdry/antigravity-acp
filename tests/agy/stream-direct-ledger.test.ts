import { describe, expect, test } from "bun:test";
import { StreamDirectLedger } from "../../src/agy/stream-direct-ledger";
import type { PocEvent } from "../../src/agy/stream-json-poc";
import { StepPayload } from "../../src/gen/steps";
import type { StepRow } from "../../src/types";

const init: PocEvent = {
	event: "init",
	conversation_id: "conv",
	init: { cwd: "/fixture", tools: [], permission_mode: "plan" },
};
const step = (text: string, idx = 1, kind = "agent_response"): PocEvent => ({
	event: "step_update",
	step_update: {
		conversation_id: "conv",
		step_index: idx,
		state: "DONE",
		step_type: kind,
		text_delta: text,
	},
});
const result: PocEvent = {
	event: "result",
	result: {
		conversation_id: "conv",
		status: "SUCCESS",
		response: "",
		num_turns: 1,
	},
};
const db = (text: string, idx = 1, status = 3, type = 15): StepRow => ({
	idx,
	stepType: type,
	status,
	stepPayload: StepPayload.create({ agentText: { text } }),
	error: null,
	permission: null,
	task: null,
	toolOutput: null,
});
const build = (...events: PocEvent[]) => {
	const l = new StreamDirectLedger(null, -1);
	for (const e of events) l.accept(e);
	return l;
};

describe("offline DB-verified stream-text admission (not in ACP runtime)", () => {
	test("never authorizes text before init/result/terminal matching SQLite row", () => {
		const l = new StreamDirectLedger(null, -1);
		expect(l.verifyDb("conv", [db("hello")])).toEqual([]);
		l.accept(init);
		l.accept(step("he"));
		l.accept(step("llo"));
		expect(l.verifyDb("conv", [db("hello")])).toEqual([]);
		l.accept(result);
		expect(l.verifyDb("conv", [db("hello", 1, 2)])).toEqual([]);
		expect(l.verifyDb("conv", [db("hello")])).toEqual([
			{ stepIndex: 1, text: "hello" },
		]);
	});
	test("offers one text once; reserve before delivery, ack after; never reoffer", () => {
		const l = build(init, step("he"), step("llo"), result);
		expect(l.verifyDb("conv", [db("hello")])).toHaveLength(1);
		expect(l.reserve(1)).toEqual({ stepIndex: 1, text: "hello" });
		expect(l.reserve(1)).toBeNull();
		l.ack(1);
		expect(l.verifyDb("conv", [db("hello")])).toEqual([]);
		expect(l.committed).toEqual([{ stepIndex: 1, text: "hello" }]);
	});
	test("Unicode pieces are never emitted before full DB match", () => {
		const text = "測試 🚀 你好";
		const l = build(init, step("測試 "), step("🚀 "), step("你好"), result);
		expect(l.verifyDb("conv", [db("測試 🚀")])).toEqual([]);
		expect(l.errorCode).toBe("DB_TEXT_MISMATCH");
		expect(l.verifyDb("conv", [db(text)])).toEqual([]);
		const stable = build(init, step(text), result);
		expect(stable.verifyDb("conv", [db(text)])).toEqual([
			{ stepIndex: 1, text },
		]);
	});
	test("identity mismatch and prior session step fail closed", () => {
		const a = build(init, step("x"), result);
		expect(a.verifyDb("other", [db("x")])).toEqual([]);
		expect(a.errorCode).toBe("IDENTITY_MISMATCH");
		const b = new StreamDirectLedger("wrong", -1);
		b.accept(init);
		expect(b.errorCode).toBe("IDENTITY_MISMATCH");
		const c = new StreamDirectLedger("conv", 5);
		c.accept(init);
		c.accept(step("old", 5));
		expect(c.errorCode).toBe("STALE_STEP");
	});
	test("unknown tool/checkpoint and DB-only tool forbid direct emission", () => {
		const a = build(init, step("x"), step("", 2, "tool"), result);
		expect(a.errorCode).toBe("UNSUPPORTED_STEP");
		const b = build(init, step("x"), result);
		expect(b.verifyDb("conv", [db("x"), db("", 2, 3, 16)])).toEqual([]);
		expect(b.errorCode).toBe("UNSUPPORTED_STEP");
	});
	test("unsupported/malformed ordering and non-success result do not authorize", () => {
		const a = build(step("x"), init, result);
		expect(a.errorCode).toBe("INVALID_ORDER");
		const b = build(init, step("x"), {
			...result,
			result: { ...result.result, status: "ERROR" },
		});
		expect(b.errorCode).toBe("UPSTREAM_FAILURE");
		expect(b.verifyDb("conv", [db("x")])).toEqual([]);
		const c = build(init, step("x"), result, step("again"));
		expect(c.errorCode).toBe("INVALID_ORDER");
	});
	test("DB extra steps, wrong text and duplicate rows forbid any emission", () => {
		const a = build(init, step("x"), result);
		expect(a.verifyDb("conv", [db("different")])).toEqual([]);
		expect(a.errorCode).toBe("DB_TEXT_MISMATCH");
		const b = build(init, step("x"), result);
		expect(b.verifyDb("conv", [db("x"), db("x", 2)])).toEqual([]);
		expect(b.errorCode).toBe("DB_UNEXPECTED_STEP");
		const c = build(init, step("x"), result);
		expect(c.verifyDb("conv", [db("x"), db("x")])).toEqual([]);
		expect(c.errorCode).toBe("DB_UNEXPECTED_STEP");
	});
	test("a later tool fallback cannot blindly replay text already acknowledged by a client", () => {
		const l = build(init, step("x"), result);
		l.verifyDb("conv", [db("x")]);
		l.reserve(1);
		l.ack(1);
		expect(l.safeToRetry).toBe(false);
		expect(l.verifyDb("conv", [db("x"), db("", 2, 3, 16)])).toEqual([]);
		expect(l.errorCode).toBe("UNSUPPORTED_STEP");
		expect(l.safeToRetry).toBe(false);
	});
	test("multi-step ordering and no repeated reservations", () => {
		const l = build(init, step("first", 1), step("second", 2), result);
		expect(l.verifyDb("conv", [db("first", 1), db("second", 2)])).toEqual([
			{ stepIndex: 1, text: "first" },
			{ stepIndex: 2, text: "second" },
		]);
		const first = l.reserve(1);
		expect(first?.text).toBe("first");
		expect(l.reserve(2)).toBeNull();
		l.ack(1);
		expect(l.reserve(2)).toEqual({ stepIndex: 2, text: "second" });
		l.ack(2);
		expect(l.committed.map((e) => e.text)).toEqual(["first", "second"]);
	});
	test("network failure leaves delivery uncertain rather than retrying", () => {
		const l = build(init, step("x"), result);
		l.verifyDb("conv", [db("x")]);
		l.reserve(1);
		l.failDelivery();
		expect(l.errorCode).toBe("DELIVERY_UNCERTAIN");
		expect(l.safeToRetry).toBe(false);
		expect(l.verifyDb("conv", [db("x")])).toEqual([]);
	});
	test("cancellation during an in-flight client send is not automatically retryable", () => {
		const l = build(init, step("x"), result);
		l.verifyDb("conv", [db("x")]);
		l.reserve(1);
		l.cancel();
		l.ack(1); // late transport success cannot erase delivery uncertainty
		expect(l.errorCode).toBe("DELIVERY_UNCERTAIN");
		expect(l.safeToRetry).toBe(false);
		expect(l.committed).toEqual([]);
	});
	test("later DB rewrite after a sent chunk is detected as irreversible divergence", () => {
		const l = build(init, step("x"), result);
		l.verifyDb("conv", [db("x")]);
		l.reserve(1);
		l.ack(1);
		l.verifyDb("conv", [db("rewritten")]);
		expect(l.errorCode).toBe("POST_COMMIT_DIVERGENCE");
		expect(l.safeToRetry).toBe(false);
	});
	test("a previously delivered step reverting to a nonterminal DB state is irreversible", () => {
		const l = build(init, step("stable"), result);
		l.verifyDb("conv", [db("stable")]);
		l.reserve(1);
		l.ack(1);
		expect(l.verifyDb("conv", [db("stable", 1, 2)])).toEqual([]);
		expect(l.errorCode).toBe("POST_COMMIT_DIVERGENCE");
		expect(l.safeToRetry).toBe(false);
	});
	test("a verified and acknowledged text step disappearing from DB is terminal", () => {
		const ledger = build(init, step("present"), result);
		ledger.verifyDb("conv", [db("present")]);
		expect(ledger.reserve(1)).toEqual({ stepIndex: 1, text: "present" });
		ledger.ack(1);
		expect(ledger.verifyDb("conv", [])).toEqual([]);
		expect(ledger.errorCode).toBe("POST_COMMIT_DIVERGENCE");
		expect(ledger.safeToRetry).toBe(false);
	});
	test("cancel and memory caps block admission", () => {
		const l = build(init, step("x".repeat(1024 * 1024 + 1)), result);
		expect(l.errorCode).toBe("CAPTURE_LIMIT");
		const c = build(init, step("x"), result);
		c.cancel();
		expect(c.verifyDb("conv", [db("x")])).toEqual([]);
		expect(c.errorCode).toBe("CANCELLED");
	});
	test("missing DB step/result cannot be fabricated; image/tool remain DB-owned", () => {
		const a = build(init, step("x"), result);
		expect(a.verifyDb("conv", [])).toEqual([]);
		const b = build(init, step("x"));
		expect(b.verifyDb("conv", [db("x")])).toEqual([]);
		const c = build(init, step("x"), result);
		expect(c.verifyDb("conv", [db("x", 1, 3, 16)])).toEqual([]);
		expect(c.errorCode).toBe("UNSUPPORTED_STEP");
	});
});
