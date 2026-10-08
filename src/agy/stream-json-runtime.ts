// Experimental single-turn shadow capture. SQLite alone emits ACP updates.
import type { StepRow } from "../types";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { type PocEvent, StreamJsonPocParser } from "./stream-json-poc";

export const CAPTURE_TEXT_LIMIT = 1024 * 1024;
export const CAPTURE_STEP_LIMIT = 128;
export const CAPTURE_IDLE_MS = 30_000;
export const CAPTURE_DRAIN_MS = 1_000;

/** Only the reviewed shadow mode is legal; no direct ACP streaming switch. */
export function streamJsonMode(value = process.env.AGY_ACP_STREAM_JSON): boolean {
	if (value === undefined || value === "disabled") return false;
	if (value === "shadow") return true;
	throw new Error("AGY_ACP_STREAM_JSON must be disabled or shadow");
}

export function assertShadowArgs(args: string[]): void {
	// Reject extra arguments wholesale: aliases/config loaders can change the
	// input protocol or process lifetime, not just the output format.
	if (args.length > 0)
		throw new Error("AGY_EXTRA_ARGS is unavailable in stream-json shadow mode");
}

export class StreamJsonCapture {
	private readonly parser = new StreamJsonPocParser();
	private readonly texts = new Map<number, string>();
	private textBytes = 0;
	private id: string | null = null;
	private resultSeen = false;
	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	private done: Promise<void> = Promise.resolve();
	private idleTimer?: ReturnType<typeof setTimeout>;
	private stopped = false;
	private finished = false;
	private failure: string | null = null;
	private matched = 0;

	constructor(
		private readonly expectedId: string | null,
		private readonly baseStepIdx: number,
		private readonly idleMs = CAPTURE_IDLE_MS,
		private readonly drainMs = CAPTURE_DRAIN_MS,
	) {}

	get errorCode(): string | null {
		return this.failure;
	}
	get retainedTextBytes(): number {
		return this.textBytes;
	}
	get matchedSteps(): number {
		return this.matched;
	}
	private fallback(code: string): void {
		if (this.failure) return;
		this.failure = code;
		this.parser.cancel();
		this.texts.clear();
		this.textBytes = 0;
		console.error(`[agy-acp] stream-json shadow fallback: ${code}`);
	}

	cancel(): void {
		this.fallback("CANCELLED");
	}

	/** Called on the same rows used by the authoritative Poller. No DB writes. */
	observeDb(id: string | null, rows: StepRow[]): void {
		if (this.failure || !this.id || !id) return;
		if (this.id !== id) {
			this.fallback("DB_IDENTITY_MISMATCH");
			return;
		}
		this.matched = 0;
		for (const row of rows) {
			const text = this.texts.get(row.idx);
			if (text === undefined) continue;
			const dbText = row.stepPayload.agentText?.text ?? "";
			if (
				row.stepType !== 15 ||
				(!dbText.startsWith(text) && !text.startsWith(dbText)) ||
				(row.status === 3 && this.resultSeen && dbText !== text)
			) {
				this.fallback("DB_TEXT_MISMATCH");
				return;
			}
			if (dbText === text) this.matched++;
		}
	}

	private accept(event: PocEvent): void {
		if (this.failure) return;
		if (this.resultSeen) {
			this.fallback("MULTIPLE_TURNS");
			return;
		}
		if (event.event === "init") {
			this.id = event.conversation_id;
			if (this.expectedId && this.expectedId !== this.id)
				this.fallback("IDENTITY_MISMATCH");
		} else if (event.event === "result") {
			this.resultSeen = true;
			if (event.result.status !== "SUCCESS" || event.result.error) {
				this.fallback("UPSTREAM_RESULT_ERROR");
			}
		} else {
			const step = event.step_update;
			if (step.step_index <= this.baseStepIdx) {
				this.fallback("STALE_STEP");
				return;
			}
			if (step.step_type !== "agent_response") return;
			const delta = step.text_delta;
			if (typeof delta !== "string" || delta.length === 0) return;
			const bytes = new TextEncoder().encode(delta).length;
			if (
				this.textBytes + bytes > CAPTURE_TEXT_LIMIT ||
				(!this.texts.has(step.step_index) &&
					this.texts.size === CAPTURE_STEP_LIMIT)
			) {
				this.fallback("CAPTURE_LIMIT");
				return;
			}
			this.textBytes += bytes;
			this.texts.set(step.step_index, (this.texts.get(step.step_index) ?? "") + delta);
		}
	}

	private drainEvents(): void {
		let event = this.parser.read();
		while (event) {
			this.accept(event);
			event = this.parser.read();
		}
		if (this.parser.errorCode && !this.failure)
			this.fallback(this.parser.errorCode);
	}

	start(stdout: ReadableStream<Uint8Array> | null): void {
		if (!stdout) {
			this.fallback("STDOUT_UNAVAILABLE");
			return;
		}
		this.reader = stdout.getReader();
		this.done = this.consume();
	}

	private async consume(): Promise<void> {
		const reader = this.reader;
		if (!reader) return;
		try {
			while (!this.stopped) {
				this.idleTimer = setTimeout(() => this.fallback("STDOUT_IDLE_TIMEOUT"), this.idleMs);
				const { done, value } = await reader.read();
				clearTimeout(this.idleTimer);
				if (done) {
					if (!this.failure) {
						while (!this.parser.finish()) this.drainEvents();
						this.drainEvents();
					}
					break;
				}
				// The parser owns <=1 MiB/32 events. Drain queue between bounded
				// slices, retry unconsumed bytes, yield so poll/cancel can run.
				let offset = 0;
				while (!this.failure && !this.stopped && offset < value.length) {
					const end = Math.min(offset + 64 * 1024, value.length);
					offset += this.parser.write(value.subarray(offset, end)).consumed;
					this.drainEvents();
					await Bun.sleep(0);
				}
				// On failure keep draining stdout without retaining bytes; otherwise
				// the child can block on a full pipe and never flush SQLite/exit.
				if (this.failure) await Bun.sleep(0);
			}
		} catch {
			this.fallback("STDOUT_READ_ERROR");
		} finally {
			clearTimeout(this.idleTimer);
			reader.releaseLock();
		}
	}

	/** Bound post-exit drain even if a descendant holds stdout open. */
	async finish(): Promise<void> {
		if (this.finished) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			this.done,
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					this.fallback("STDOUT_DRAIN_TIMEOUT");
					this.stopped = true;
					void this.reader?.cancel().catch(() => {});
					resolve();
				}, this.drainMs);
			}),
		]);
		clearTimeout(timer);
		clearTimeout(this.idleTimer);
		this.finished = true;
	}

	release(): void {
		this.texts.clear();
		this.textBytes = 0;
	}
}
