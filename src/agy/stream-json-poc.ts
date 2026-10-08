/** Offline PoC for https://www.agy.dev/docs/cli/headless/#streaming-json.
 * Never import into production ACP prompts. All event payloads are inert.
 */
export const MAX_EVENT_BYTES = 1024 * 1024;
export const MAX_QUEUED_EVENTS = 32;
export type PocErrorCode =
	| "EVENT_TOO_LARGE"
	| "INVALID_UTF8"
	| "INVALID_JSON"
	| "INVALID_SCHEMA"
	| "UNSUPPORTED_SCHEMA"
	| "INVALID_ORDER"
	| "IDENTITY_MISMATCH"
	| "INCOMPLETE_TRACE"
	| "CANCELLED";
type ObjectValue = Record<string, unknown>;
export type PocEvent =
	| { event: "init"; conversation_id: string; init: ObjectValue }
	| {
			event: "step_update";
			step_update: ObjectValue & {
				conversation_id: string;
				step_index: number;
				state: "ACTIVE" | "DONE";
				step_type: string;
			};
	  }
	| {
			event: "result";
			result: ObjectValue & {
				conversation_id: string;
				status: string;
				response: string;
				num_turns: number;
				error?: "UPSTREAM_ERROR";
			};
	  };
type Phase = "initial" | "steps" | "result";
const object = (v: unknown): v is ObjectValue =>
	!!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const nonempty = (v: unknown) => typeof v === "string" && v.length > 0;
const optional = (v: ObjectValue, k: string, test: (x: unknown) => boolean) =>
	!Object.hasOwn(v, k) || test(v[k]);
const keys = (v: ObjectValue, allowed: string[]) =>
	Object.keys(v).every((k) => allowed.includes(k));
const duration = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;
const usage = (v: unknown) =>
	object(v) &&
	keys(v, [
		"input_tokens",
		"output_tokens",
		"thinking_tokens",
		"cache_read_tokens",
		"total_tokens",
	]) &&
	[
		"input_tokens",
		"output_tokens",
		"thinking_tokens",
		"cache_read_tokens",
		"total_tokens",
	].every((k) => integer(v[k]));

function schema(v: unknown): PocEvent | PocErrorCode {
	if (!object(v) || typeof v.event !== "string") return "INVALID_SCHEMA";
	if (!["init", "step_update", "result"].includes(v.event))
		return "UNSUPPORTED_SCHEMA";
	if (
		!keys(
			v,
			v.event === "init"
				? ["event", "conversation_id", "init"]
				: ["event", v.event],
		)
	)
		return "INVALID_SCHEMA";
	const p = v[v.event];
	if (!object(p)) return "INVALID_SCHEMA";
	if (v.event === "init") {
		if (
			!nonempty(v.conversation_id) ||
			!keys(p, [
				"cwd",
				"tools",
				"permission_mode",
				"model",
				"agent",
				"json_schema",
			]) ||
			typeof p.cwd !== "string" ||
			!Array.isArray(p.tools) ||
			!p.tools.every((x) => typeof x === "string") ||
			!nonempty(p.permission_mode) ||
			!optional(p, "model", nonempty) ||
			!optional(p, "agent", nonempty) ||
			!optional(p, "json_schema", object)
		)
			return "INVALID_SCHEMA";
	} else {
		if (
			!nonempty(p.conversation_id) ||
			!optional(p, "duration_seconds", duration) ||
			!optional(p, "usage", usage)
		)
			return "INVALID_SCHEMA";
		if (v.event === "step_update") {
			if (
				!keys(p, [
					"conversation_id",
					"step_index",
					"state",
					"step_type",
					"tool_name",
					"text_delta",
					"duration_seconds",
					"usage",
					"tool_info",
					"subagent_info",
				]) ||
				!integer(p.step_index) ||
				!["ACTIVE", "DONE"].includes(p.state as string) ||
				!["user_input", "agent_response", "tool", "checkpoint"].includes(
					p.step_type as string,
				) ||
				!optional(p, "text_delta", (x) => typeof x === "string") ||
				!optional(p, "tool_name", nonempty) ||
				!optional(p, "tool_info", object) ||
				!optional(p, "subagent_info", object)
			)
				return "INVALID_SCHEMA";
			// Nested invocation details are opaque JSON, never commands or authority.
		} else {
			if (
				!keys(p, [
					"conversation_id",
					"status",
					"response",
					"error",
					"duration_seconds",
					"num_turns",
					"usage",
					"structured_output",
					"json_schema",
				]) ||
				![
					"SUCCESS",
					"ERROR",
					"CANCELED",
					"INTERRUPTED",
					"INVALID",
					"WAITING",
					"RUNNING",
				].includes(p.status as string) ||
				typeof p.response !== "string" ||
				!integer(p.num_turns) ||
				!usage(p.usage) ||
				!optional(p, "error", (x) => typeof x === "string") ||
				!optional(p, "structured_output", object) ||
				!optional(p, "json_schema", object)
			)
				return "INVALID_SCHEMA";
			if (Object.hasOwn(p, "error")) p.error = "UPSTREAM_ERROR";
		}
	}
	return v as PocEvent;
}

export class StreamJsonPocParser {
	private line: Uint8Array | null = null;
	private length = 0;
	private readonly queue: PocEvent[] = [];
	private phase: Phase = "initial";
	private conversationId: string | null = null;
	private lastIndex = -1;
	private lastStepState: "ACTIVE" | "DONE" | null = null;
	private lastStepType: string | null = null;
	private lastTurn = -1;
	private ended = false;
	private failure: PocErrorCode | null = null;
	private readonly decoder = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: true,
	});

	get errorCode(): PocErrorCode | null {
		return this.failure;
	}
	get queuedEvents(): number {
		return this.queue.length;
	}
	get bufferedBytes(): number {
		return this.length;
	}
	get state(): Phase | "failed" | "eof" {
		return this.failure ? "failed" : this.ended ? "eof" : this.phase;
	}

	/** Pull one event to release backpressure. Payloads are untrusted inert data. */
	read(): PocEvent | undefined {
		return this.queue.shift();
	}

	/** Caller must retry chunk.subarray(consumed). No caller chunk is retained. */
	write(chunk: Uint8Array): { consumed: number; backpressure: boolean } {
		let consumed = 0;
		while (
			!this.failure &&
			!this.ended &&
			consumed < chunk.length &&
			this.queue.length < MAX_QUEUED_EVENTS
		) {
			const newline = chunk.indexOf(10, consumed);
			const end = newline < 0 ? chunk.length : newline;
			const count = end - consumed;
			if (this.length + count > MAX_EVENT_BYTES) {
				this.fail("EVENT_TOO_LARGE");
				break;
			}
			if (count > 0) {
				this.line ??= new Uint8Array(MAX_EVENT_BYTES);
				this.line.set(chunk.subarray(consumed, end), this.length);
				this.length += count;
			}
			consumed = end;
			if (newline < 0) break;
			consumed++;
			this.parseLine();
		}
		return {
			consumed,
			backpressure:
				!this.failure && !this.ended && this.queue.length === MAX_QUEUED_EVENTS,
		};
	}

	/** Call only after all bytes were consumed. False means drain and retry EOF. */
	finish(): boolean {
		if (this.failure || this.ended) return true;
		if (this.length > 0) {
			if (this.queue.length === MAX_QUEUED_EVENTS) return false;
			this.parseLine();
		}
		if (this.failure) return true;
		if (this.phase !== "result") {
			this.fail("INCOMPLETE_TRACE");
			return true;
		}
		this.ended = true;
		this.line = null;
		return true;
	}

	/** Fragment cancellation discards data; it cannot synthesize a result/exit. */
	cancel(): void {
		if (!this.ended && !this.failure) this.fail("CANCELLED");
	}

	private fail(code: PocErrorCode): void {
		this.failure = code;
		this.line = null;
		this.length = 0;
		this.queue.length = 0;
	}

	private parseLine(): void {
		const bytes = this.line?.subarray(0, this.length) ?? new Uint8Array();
		const content = bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes;
		let text: string;
		try {
			text = this.decoder.decode(content);
		} catch {
			this.fail("INVALID_UTF8");
			return;
		}
		// TextDecoder must not silently strip a BOM.
		if (text.startsWith("\uFEFF")) {
			this.fail("INVALID_UTF8");
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			this.fail("INVALID_JSON");
			return;
		}
		const event = schema(value);
		if (typeof event === "string") {
			this.fail(event);
			return;
		}
		if (event.event === "init") {
			if (this.phase !== "initial") {
				this.fail("INVALID_ORDER");
				return;
			}
			this.conversationId = event.conversation_id;
			this.phase = "steps";
		} else {
			if (this.phase === "initial") {
				this.fail("INVALID_ORDER");
				return;
			}
			const p =
				event.event === "step_update" ? event.step_update : event.result;
			if (p.conversation_id !== this.conversationId) {
				this.fail("IDENTITY_MISMATCH");
				return;
			}
			if (event.event === "step_update") {
				const step = event.step_update;
				if (
					step.step_index < this.lastIndex ||
					(step.step_index === this.lastIndex &&
						(this.lastStepState === "DONE" ||
							step.step_type !== this.lastStepType))
				) {
					this.fail("INVALID_ORDER");
					return;
				}
				this.lastIndex = step.step_index;
				this.lastStepState = step.state;
				this.lastStepType = step.step_type;
				this.phase = "steps";
			} else {
				if (event.result.num_turns <= this.lastTurn) {
					this.fail("INVALID_ORDER");
					return;
				}
				this.lastTurn = event.result.num_turns;
				this.phase = "result";
			}
		}
		this.queue.push(event);
		this.length = 0;
		this.line = null;
	}
}
