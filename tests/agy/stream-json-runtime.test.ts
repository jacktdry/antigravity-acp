import { describe, expect, test } from "bun:test";
import {
	assertShadowArgs,
	CAPTURE_TEXT_LIMIT,
	StreamJsonCapture,
	streamJsonMode,
} from "../../src/agy/stream-json-runtime";
import { StepPayload } from "../../src/gen/steps";
import type { StepRow } from "../../src/types";

export const init = {
	event: "init",
	conversation_id: "conv",
	init: { cwd: "/fixture", tools: [], permission_mode: "always-proceed" },
};
export const step = (text: string, state = "DONE", index = 1) => ({
	event: "step_update",
	step_update: {
		conversation_id: "conv",
		step_index: index,
		state,
		step_type: "agent_response",
		text_delta: text,
	},
});
export const result = (status = "SUCCESS") => ({
	event: "result",
	result: {
		conversation_id: "conv",
		status,
		response: "hello",
		num_turns: 1,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			thinking_tokens: 0,
			cache_read_tokens: 0,
			total_tokens: 0,
		},
	},
});
export const ndjson = (events: unknown[]) =>
	new TextEncoder().encode(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
export const stdout = (events: unknown[]) =>
	new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(ndjson(events));
			c.close();
		},
	});
const row = (text: string, status = 3): StepRow => ({
	idx: 1,
	stepType: 15,
	status,
	stepPayload: StepPayload.create({ agentText: { text } }),
	error: null,
	permission: null,
	task: null,
	toolOutput: null,
});

describe("single-turn stream-json shadow", () => {
	test("switch defaults disabled and rejects every unreviewed value/extra arg", () => {
		expect(streamJsonMode(undefined)).toBe(false);
		expect(streamJsonMode("disabled")).toBe(false);
		expect(streamJsonMode("shadow")).toBe(true);
		for (const value of ["", "1", "true", "text", "stream", "SHADOW", " shadow"])
			expect(() => streamJsonMode(value)).toThrow("disabled or shadow");
		expect(() => assertShadowArgs(["--input-format=stream-json"])).toThrow();
	});
	test("compares incremental text against SQLite without any ACP authority", async () => {
		const capture = new StreamJsonCapture(null, -1);
		capture.start(stdout([init, step("he", "ACTIVE"), step("llo"), result()]));
		await capture.finish();
		capture.observeDb("conv", [row("hello", 2)]);
		expect(capture.matchedSteps).toBe(1);
		capture.observeDb("conv", []);
		capture.observeDb("conv", [row("hello")]);
		expect(capture.errorCode).toBeNull();
		capture.observeDb("conv", [row("different")]);
		expect(capture.errorCode).toBe("DB_TEXT_MISMATCH");
		expect(capture.retainedTextBytes).toBe(0);
	});
	test("fences restored identity, stale steps and multiple turns", async () => {
		for (const [id, base, events, code] of [
			["other", -1, [init, result()], "IDENTITY_MISMATCH"],
			["conv", 1, [init, step("hello"), result()], "STALE_STEP"],
			[null, -1, [init, result(), step("again", "DONE", 2)], "MULTIPLE_TURNS"],
		] as const) {
			const capture = new StreamJsonCapture(id, base);
			capture.start(stdout([...events]));
			await capture.finish();
			expect(capture.errorCode).toBe(code);
		}
		const capture = new StreamJsonCapture(null, -1);
		capture.start(stdout([init, step("hello"), result()]));
		await capture.finish();
		capture.observeDb("other", [row("hello")]);
		expect(capture.errorCode).toBe("DB_IDENTITY_MISMATCH");
	});
	test("unknown schema falls back and continues consuming the entire pipe", async () => {
		let pulls = 0;
		const capture = new StreamJsonCapture(null, -1);
		capture.start(new ReadableStream({
			pull(c) {
				pulls++;
				if (pulls === 1) c.enqueue(ndjson([{ event: "future" }]));
				else if (pulls < 60) c.enqueue(new Uint8Array(64 * 1024));
				else c.close();
			},
		}));
		await capture.finish();
		expect(pulls).toBe(60);
		expect(capture.errorCode).toBe("UNSUPPORTED_SCHEMA");
		expect(capture.retainedTextBytes).toBe(0);
	});
	test("aggregate capture cap and parser backpressure are bounded", async () => {
		const capture = new StreamJsonCapture(null, -1);
		capture.start(stdout([
			init,
			...Array.from({ length: 80 }, (_, i) => step("x".repeat(16 * 1024), "DONE", i)),
			result(),
		]));
		await capture.finish();
		expect(capture.errorCode).toBe("CAPTURE_LIMIT");
		expect(capture.retainedTextBytes).toBeLessThanOrEqual(CAPTURE_TEXT_LIMIT);
	});
	test("reports missing result and native error using fixed codes", async () => {
		for (const [events, code] of [
			[[init, step("hello")], "INCOMPLETE_TRACE"],
			[[init, result("ERROR")], "UPSTREAM_RESULT_ERROR"],
		] as const) {
			const capture = new StreamJsonCapture(null, -1);
			capture.start(stdout([...events]));
			await capture.finish();
			expect(capture.errorCode).toBe(code);
		}
	});
	test("idle fallback keeps draining, and post-exit finish cancels a held pipe", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		let cancelled = false;
		const capture = new StreamJsonCapture(null, -1, 10, 20);
		capture.start(new ReadableStream({
			start(c) { controller = c; },
			cancel() { cancelled = true; },
		}));
		await Bun.sleep(25);
		expect(capture.errorCode).toBe("STDOUT_IDLE_TIMEOUT");
		controller.enqueue(ndjson([init, result()]));
		await capture.finish();
		expect(cancelled).toBe(true);
		expect(capture.retainedTextBytes).toBe(0);
	});
	test("cancelled fragments never become parsed text or fabricated result", async () => {
		const capture = new StreamJsonCapture(null, -1);
		capture.cancel();
		capture.start(stdout([init, step("late"), result()]));
		await capture.finish();
		expect(capture.errorCode).toBe("CANCELLED");
		expect(capture.retainedTextBytes).toBe(0);
	});
});
