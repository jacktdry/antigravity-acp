import { describe, expect, it } from "bun:test";
import {
	MAX_EVENT_BYTES,
	MAX_QUEUED_EVENTS,
	type PocErrorCode,
	StreamJsonPocParser,
} from "../../src/agy/stream-json-poc";

const encoder = new TextEncoder();
const id = "synthetic-conversation";
const usage = {
	input_tokens: 1,
	output_tokens: 2,
	thinking_tokens: 0,
	cache_read_tokens: 0,
	total_tokens: 3,
};
const init = {
	event: "init",
	conversation_id: id,
	init: {
		cwd: "/synthetic",
		tools: ["fixture_tool"],
		permission_mode: "request-review",
	},
};
const step = (index = 0, state = "DONE", text = "文字😀") => ({
	event: "step_update",
	step_update: {
		conversation_id: id,
		step_index: index,
		state,
		step_type: "agent_response",
		text_delta: text,
	},
});
const result = (turn = 1, status = "SUCCESS") => ({
	event: "result",
	result: {
		conversation_id: id,
		status,
		response: "fixture",
		num_turns: turn,
		usage,
	},
});
const lines = (events: unknown[], delimiter = "\n", final = true) =>
	encoder.encode(
		events.map((e) => JSON.stringify(e)).join(delimiter) +
			(final ? delimiter : ""),
	);
function drain(p: StreamJsonPocParser): unknown[] {
	const events: unknown[] = [];
	let event = p.read();
	while (event) {
		events.push(event);
		event = p.read();
	}
	return events;
}
function parse(bytes: Uint8Array) {
	const p = new StreamJsonPocParser();
	p.write(bytes);
	p.finish();
	return p;
}
function rejected(events: unknown[], code: PocErrorCode) {
	const p = parse(events.length ? lines(events) : new Uint8Array());
	expect(p.errorCode).toBe(code);
	expect(p.state).toBe("failed");
	expect(p.bufferedBytes).toBe(0);
	expect(p.queuedEvents).toBe(0);
	expect(p.write(lines([init, result()])).consumed).toBe(0);
	expect(p.finish()).toBe(true);
	expect(p.errorCode).toBe(code);
}

describe("offline official stream-json PoC", () => {
	it("accepts documentation shapes, gaps, optional usage and cumulative turns", () => {
		const events = [
			init,
			step(0),
			{
				...step(3),
				step_update: { ...step(3).step_update, duration_seconds: 0.1, usage },
			},
			result(),
			step(4),
			result(2),
		];
		const p = parse(lines(events));
		expect(p.errorCode).toBeNull();
		expect(drain(p)).toEqual(events);
		expect(p.state).toBe("eof");
	});
	for (const delimiter of ["\n", "\r\n"])
		for (const final of [true, false]) {
			it(`preserves UTF-8 across every two-chunk boundary (${JSON.stringify(delimiter)}, ${final})`, () => {
				const events = [init, step(), result()];
				const bytes = lines(events, delimiter, final);
				for (let split = 0; split <= bytes.length; split++) {
					const p = new StreamJsonPocParser();
					expect(p.write(bytes.subarray(0, split)).consumed).toBe(split);
					expect(p.write(bytes.subarray(split)).consumed).toBe(
						bytes.length - split,
					);
					p.finish();
					expect(p.errorCode).toBeNull();
					expect(drain(p)).toEqual(events);
				}
			}, 30_000);
		}
	it("handles one-byte chunks and copies caller-owned data", () => {
		const events = [init, step(), result()];
		const p = new StreamJsonPocParser();
		for (const byte of lines(events, "\r\n")) {
			const chunk = new Uint8Array([byte]);
			p.write(chunk);
			chunk[0] = 0;
		}
		p.finish();
		expect(drain(p)).toEqual(events);
	});
	it("retains only an incomplete coalesced tail and releases on failure", () => {
		const p = new StreamJsonPocParser();
		const tail = encoder.encode('{"event":');
		p.write(lines([init, step()]));
		p.write(tail);
		expect(p.queuedEvents).toBe(2);
		expect(p.bufferedBytes).toBe(tail.length);
		p.finish();
		expect(p.errorCode).toBe("INVALID_JSON");
		expect(p.bufferedBytes).toBe(0);
	});
	for (const ending of ["", "\n", "\r\n"]) {
		it(`accepts exactly 1MiB including CR (${JSON.stringify(ending)})`, () => {
			const overhead = JSON.stringify(step(0, "DONE", "")).length;
			const data = "x".repeat(
				MAX_EVENT_BYTES - overhead - (ending === "\r\n" ? 1 : 0),
			);
			const p = new StreamJsonPocParser();
			p.write(lines([init]));
			p.write(encoder.encode(JSON.stringify(step(0, "DONE", data)) + ending));
			expect(p.errorCode).toBeNull();
			if (!ending) p.write(encoder.encode("\n"));
			p.write(lines([result()]));
			p.finish();
			expect(p.errorCode).toBeNull();
		});
	}
	for (const size of [MAX_EVENT_BYTES + 1, MAX_EVENT_BYTES * 5]) {
		it(`rejects oversized unterminated bytes ${size} before UTF-8 decode`, () => {
			const p = parse(new Uint8Array(size).fill(255));
			expect(p.errorCode).toBe("EVENT_TOO_LARGE");
			expect(p.bufferedBytes).toBe(0);
		});
	}
	it("limits multibyte input by bytes and accumulated incomplete lines", () => {
		expect(
			parse(lines([init, step(0, "DONE", "😀".repeat(MAX_EVENT_BYTES / 4))]))
				.errorCode,
		).toBe("EVENT_TOO_LARGE");
		const p = new StreamJsonPocParser();
		p.write(new Uint8Array(MAX_EVENT_BYTES).fill(32));
		expect(p.bufferedBytes).toBe(MAX_EVENT_BYTES);
		p.write(new Uint8Array([32]));
		expect(p.errorCode).toBe("EVENT_TOO_LARGE");
		expect(p.bufferedBytes).toBe(0);
	});
	for (const bytes of [
		[255],
		[192, 175],
		[237, 160, 128],
		[244, 144, 128, 128],
		[226, 130],
	]) {
		it(`fails closed for invalid UTF-8 ${bytes}`, () =>
			expect(parse(new Uint8Array(bytes)).errorCode).toBe("INVALID_UTF8"));
	}
	it("rejects BOM without silently stripping it", () =>
		expect(
			parse(encoder.encode(`\uFEFF${JSON.stringify(init)}`)).errorCode,
		).toBe("INVALID_UTF8"));
	for (const text of [
		"",
		"\n",
		"\r\n",
		"{",
		'{"event":',
		"stdout diagnostic",
		"{}{}",
		'"canary',
	]) {
		it(`rejects malformed or empty framing ${JSON.stringify(text)}`, () =>
			expect(parse(encoder.encode(text)).errorCode).toBe(
				text === "" ? "INCOMPLETE_TRACE" : "INVALID_JSON",
			));
	}
	for (const value of [
		null,
		1,
		true,
		"x",
		[],
		{},
		{ event: 1 },
		{ type: "init" },
		{ event: "init", conversation_id: id, init: [] },
	]) {
		it(`rejects invalid envelope ${JSON.stringify(value)}`, () =>
			rejected([value], "INVALID_SCHEMA"));
	}
	for (const event of ["step", "error", "control_request", "future"]) {
		it(`rejects undocumented event ${event}`, () =>
			rejected([{ event }], "UNSUPPORTED_SCHEMA"));
	}
	for (const bad of [
		{ ...init, init: { ...init.init, tools: [1] } },
		{ ...init, init: {} },
		{ ...init, secret: "TOKEN_CANARY" },
		...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((step_index) => ({
			...step(),
			step_update: { ...step().step_update, step_index },
		})),
		{ ...step(), step_update: { ...step().step_update, state: "UNKNOWN" } },
		{ ...step(), step_update: { ...step().step_update, text_delta: {} } },
		{ ...step(), step_update: { ...step().step_update, tool_info: [] } },
		{ ...result(), result: { ...result().result, usage: { total_tokens: 1 } } },
		{ ...result(), result: { ...result().result, num_turns: -1 } },
		{ ...result(), result: { ...result().result, status: "BOGUS" } },
		{ ...result(), result: { ...result().result, duration_seconds: -1 } },
	])
		it("rejects mistyped, missing or extra schema fields", () =>
			rejected(bad.event === "init" ? [bad] : [init, bad], "INVALID_SCHEMA"));
	for (const events of [
		[step()],
		[result()],
		[init, init],
		[init, step(), step()],
		[init, step(4), step(3)],
		[init, result(), result()],
		[init, result(2), result(1)],
	]) {
		it("rejects ordering violations and duplicates", () =>
			rejected(events, "INVALID_ORDER"));
	}
	it("preserves repeated ACTIVE deltas but rejects changes after DONE", () => {
		const events = [
			init,
			step(3, "ACTIVE", "a"),
			step(3, "ACTIVE", "a"),
			step(3, "DONE", "b"),
			result(),
		];
		expect(drain(parse(lines(events)))).toEqual(events);
		rejected([...events, step(3, "ACTIVE")], "INVALID_ORDER");
	});
	it("fences every payload to its initialized conversation", () => {
		rejected(
			[
				init,
				{
					...step(),
					step_update: { ...step().step_update, conversation_id: "stale" },
				},
			],
			"IDENTITY_MISMATCH",
		);
		rejected(
			[
				init,
				{
					...result(),
					result: { ...result().result, conversation_id: "stale" },
				},
			],
			"IDENTITY_MISMATCH",
		);
	});
	it("keeps tool start/end, partial parameters and repeated names inert", () => {
		const tool = (state: string, parameters: unknown) => ({
			event: "step_update",
			step_update: {
				conversation_id: id,
				step_index: 4,
				step_type: "tool",
				state,
				tool_name: "fixture_tool",
				tool_info: { name: "fixture_tool", parameters, output: "synthetic" },
			},
		});
		const events = [
			init,
			tool("ACTIVE", { fragment: "{" }),
			tool("ACTIVE", { fragment: "}" }),
			tool("DONE", {}),
			result(),
		];
		expect(drain(parse(lines(events)))).toEqual(events);
	});
	for (const status of [
		"SUCCESS",
		"ERROR",
		"CANCELED",
		"INTERRUPTED",
		"INVALID",
		"WAITING",
		"RUNNING",
	]) {
		it(`represents ${status} independently of process exit, redacting native error`, () => {
			const event = {
				...result(0, status),
				result: {
					...result(0, status).result,
					error: "TOKEN_CANARY PROMPT_CANARY",
				},
			};
			const p = parse(lines([init, event]));
			expect(p.errorCode).toBeNull();
			const output = drain(p) as any[];
			expect(output[1].result.error).toBe("UPSTREAM_ERROR");
			expect(JSON.stringify(output)).not.toContain("CANARY");
			expect(Object.keys(p)).not.toContain("exitCode");
		});
	}
	for (const events of [
		[],
		[init],
		[init, step()],
		[init, result(), step(5, "ACTIVE")],
	]) {
		it("fails missing-result EOF without fabricating completion", () =>
			rejected(events, "INCOMPLETE_TRACE"));
	}
	it("diagnostics never echo malformed token/prompt contents or recover", () => {
		const p = parse(
			encoder.encode(
				`{"TOKEN_CANARY":"PROMPT_CANARY"\n${JSON.stringify(init)}`,
			),
		);
		expect(p.errorCode).toBe("INVALID_JSON");
		expect(JSON.stringify({ code: p.errorCode, state: p.state })).not.toContain(
			"CANARY",
		);
		expect(p.write(lines([init, result()])).consumed).toBe(0);
	});
	it("backs up a long burst at 32 and retries only caller-owned bytes", () => {
		const events = [
			init,
			...Array.from({ length: 1500 }, (_, i) => step(i)),
			result(),
		];
		const bytes = lines(events);
		const p = new StreamJsonPocParser();
		const output: unknown[] = [];
		let offset = 0;
		let pressures = 0;
		while (offset < bytes.length) {
			const progress = p.write(bytes.subarray(offset));
			offset += progress.consumed;
			expect(p.queuedEvents).toBeLessThanOrEqual(MAX_QUEUED_EVENTS);
			expect(p.bufferedBytes).toBe(0);
			if (progress.backpressure) {
				pressures++;
				expect(p.queuedEvents).toBe(32);
			}
			output.push(p.read());
		}
		p.finish();
		output.push(...drain(p));
		expect(output).toEqual(events);
		expect(pressures).toBeGreaterThan(1);
	});
	it("consumes nothing while queue is full, then accepts the final EOF tail", () => {
		const p = new StreamJsonPocParser();
		p.write(lines([init, ...Array.from({ length: 30 }, (_, i) => step(i))]));
		const bytes = lines([step(30), result()], "\n", false);
		const progress = p.write(bytes);
		expect(p.queuedEvents).toBe(32);
		expect(progress.backpressure).toBe(true);
		expect(p.write(bytes.subarray(progress.consumed)).consumed).toBe(0);
		p.read();
		p.write(bytes.subarray(progress.consumed));
		p.finish();
		expect(p.errorCode).toBeNull();
	});
	it("EOF is idempotent and prevents later input", () => {
		const p = parse(lines([init, result()]));
		expect(p.finish()).toBe(true);
		expect(p.write(lines([step()])).consumed).toBe(0);
		expect(p.errorCode).toBeNull();
	});
	it("cancellation releases fragments and queue without a result", () => {
		const p = new StreamJsonPocParser();
		p.write(lines([init]));
		p.write(encoder.encode('{"event":'));
		p.cancel();
		p.cancel();
		expect(p.errorCode).toBe("CANCELLED");
		expect(p.bufferedBytes).toBe(0);
		expect(p.queuedEvents).toBe(0);
		expect(p.write(lines([result()])).consumed).toBe(0);
	});
	it("isolates parser instances and rejects stale restarted events", () => {
		const a = new StreamJsonPocParser();
		const b = new StreamJsonPocParser();
		a.write(lines([init]));
		b.write(lines([{ ...init, conversation_id: "second" }]));
		b.write(lines([step()]));
		expect(b.errorCode).toBe("IDENTITY_MISMATCH");
		a.write(lines([result()]));
		a.finish();
		expect(a.errorCode).toBeNull();
		rejected([step()], "INVALID_ORDER");
	});
	it("rejects image/unknown fields until their upstream schema is confirmed", () =>
		rejected(
			[
				init,
				{
					...step(),
					step_update: {
						...step().step_update,
						step_type: "image",
						image: "synthetic",
					},
				},
			],
			"INVALID_SCHEMA",
		));
	it("has no imports, process execution, credential storage or ACP dependencies", async () => {
		const source = await Bun.file("src/agy/stream-json-poc.ts").text();
		expect(source).not.toMatch(/^import\s/m);
		expect(source).not.toMatch(
			/Bun\.spawn|SQLite|SessionUpdate|process\.env|node:fs/,
		);
	});
});
