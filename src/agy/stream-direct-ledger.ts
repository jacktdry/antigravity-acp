/**
 * Offline direct-text admission prototype. NOT connected to ACP Adapter.
 *
 * Stream deltas alone are not authoritative: every offered text must belong to
 * the same conversation/step and exactly match a terminal SQLite row.
 * No remote ACP update is sent here. Callers must reserve before delivery and
 * acknowledge only after a successful client.update.
 */
import type { StepRow } from "../types";
import type { PocEvent } from "./stream-json-poc";

export type DirectLedgerError =
	| "IDENTITY_MISMATCH"
	| "INVALID_ORDER"
	| "UNSUPPORTED_STEP"
	| "STALE_STEP"
	| "CAPTURE_LIMIT"
	| "UPSTREAM_FAILURE"
	| "DB_TEXT_MISMATCH"
	| "DB_UNEXPECTED_STEP"
	| "POST_COMMIT_DIVERGENCE"
	| "DELIVERY_UNCERTAIN"
	| "CANCELLED";

export interface VerifiedText {
	stepIndex: number;
	text: string;
}
type TextRecord = {
	text: string;
	state: "pending" | "reserved" | "acked";
};

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_STEPS = 128;

/**
 * This proves the text/DB admission invariant in isolation. It does NOT prove
 * that AGY never edits a completed row, or that a network send is exactly-once.
 */
export class StreamDirectLedger {
	private conversationId: string | null = null;
	private phase: "initial" | "steps" | "result" = "initial";
	private failure: DirectLedgerError | null = null;
	private readonly texts = new Map<number, TextRecord>();
	private byteCount = 0;
	private readonly verified = new Set<number>();
	private reserved: number | null = null;

	constructor(
		private readonly expectedId: string | null,
		private readonly baseStepIdx: number,
	) {}

	get errorCode(): DirectLedgerError | null {
		return this.failure;
	}
	get hasResult(): boolean {
		return this.phase === "result";
	}
	get committed(): ReadonlyArray<VerifiedText> {
		return [...this.texts.entries()]
			.filter(([, item]) => item.state === "acked")
			.sort(([a], [b]) => a - b)
			.map(([stepIndex, item]) => ({ stepIndex, text: item.text }));
	}
	get safeToRetry(): boolean {
		// Without a shared Translator suppression cursor, *any* prior send
		// prevents an unconditional switch to SQLite output.
		return (
			this.reserved === null &&
			[...this.texts.values()].every((record) => record.state === "pending") &&
			this.failure !== "DELIVERY_UNCERTAIN" &&
			this.failure !== "POST_COMMIT_DIVERGENCE"
		);
	}

	private stop(reason: DirectLedgerError): undefined {
		if (!this.failure) this.failure = reason;
		this.verified.clear();
		return undefined;
	}
	cancel(): void {
		// A pending client update can already be visible when cancellation arrives.
		this.stop(this.reserved === null ? "CANCELLED" : "DELIVERY_UNCERTAIN");
	}

	accept(event: PocEvent): void {
		if (this.failure) return;
		if (event.event === "init") {
			if (this.phase !== "initial") {
				this.stop("INVALID_ORDER");
				return;
			}
			if (this.expectedId && this.expectedId !== event.conversation_id) {
				this.stop("IDENTITY_MISMATCH");
				return;
			}
			this.conversationId = event.conversation_id;
			this.phase = "steps";
			return;
		}
		if (this.phase !== "steps" || !this.conversationId) {
			this.stop("INVALID_ORDER");
			return;
		}
		if (event.event === "result") {
			if (
				event.result.conversation_id !== this.conversationId ||
				event.result.status !== "SUCCESS" ||
				event.result.error
			) {
				this.stop("UPSTREAM_FAILURE");
				return;
			}
			this.phase = "result";
			return;
		}

		const update = event.step_update;
		if (update.conversation_id !== this.conversationId) {
			this.stop("IDENTITY_MISMATCH");
			return;
		}
		if (update.step_type === "user_input") return;
		if (update.step_type !== "agent_response") {
			this.stop("UNSUPPORTED_STEP");
			return;
		}
		if (update.step_index <= this.baseStepIdx) {
			this.stop("STALE_STEP");
			return;
		}
		if (typeof update.text_delta !== "string") {
			this.stop("INVALID_ORDER");
			return;
		}
		if (update.text_delta.length === 0) return;
		const old = this.texts.get(update.step_index);
		if (old?.state !== undefined && old.state !== "pending") {
			this.stop("INVALID_ORDER");
			return;
		}
		const bytes = Buffer.byteLength(update.text_delta, "utf8");
		if (
			this.byteCount + bytes > MAX_TEXT_BYTES ||
			(!old && this.texts.size >= MAX_STEPS)
		) {
			this.stop("CAPTURE_LIMIT");
			return;
		}
		this.byteCount += bytes;
		this.texts.set(update.step_index, {
			text: (old?.text ?? "") + update.text_delta,
			state: "pending",
		});
	}

	/**
	 * Return only candidates which exactly match *completed* DB rows.
	 * Never emit text directly: caller must reserve/ack to track uncertainty.
	 */
	verifyDb(
		conversationId: string | null,
		rows: readonly StepRow[],
	): VerifiedText[] {
		if (this.failure || this.phase !== "result") return [];
		if (!conversationId || conversationId !== this.conversationId) {
			this.stop("IDENTITY_MISMATCH");
			return [];
		}
		const byIndex = new Map<number, StepRow>();
		for (const row of rows) {
			if (row.idx <= this.baseStepIdx) continue;
			if (row.stepType === 14 || row.stepType === 23) continue;
			if (row.stepType !== 15) {
				this.stop("UNSUPPORTED_STEP");
				return [];
			}
			if (byIndex.has(row.idx)) {
				this.stop("DB_UNEXPECTED_STEP");
				return [];
			}
			byIndex.set(row.idx, row);
			const record = this.texts.get(row.idx);
			if (!record) {
				this.stop("DB_UNEXPECTED_STEP");
				return [];
			}
			const dbText = row.stepPayload.agentText?.text ?? "";
			if (dbText !== record.text && row.status === 3) {
				this.stop(
					record.state === "acked"
						? "POST_COMMIT_DIVERGENCE"
						: "DB_TEXT_MISMATCH",
				);
				return [];
			}
			// A mutable/incomplete DB row does not authorize direct output;
			// reverting a row already delivered to the client is divergence.
			if (row.status !== 3) {
				if (record.state === "acked") this.stop("POST_COMMIT_DIVERGENCE");
				return [];
			}
		}
		// A missing step is not proof of completion. If it was already sent,
		// its disappearance is an irreversible DB/source divergence.
		if (byIndex.size !== this.texts.size) {
			if ([...this.texts.values()].some((record) => record.state === "acked"))
				this.stop("POST_COMMIT_DIVERGENCE");
			return [];
		}
		this.verified.clear();
		const ready: VerifiedText[] = [];
		for (const [idx, record] of [...this.texts.entries()].sort(
			([a], [b]) => a - b,
		)) {
			if (record.state === "pending") {
				this.verified.add(idx);
				ready.push({ stepIndex: idx, text: record.text });
			}
		}
		return ready;
	}

	/** Reserve before client.update; never offer the same chunk twice. */
	reserve(stepIndex: number): VerifiedText | null {
		if (this.failure || this.reserved !== null || !this.verified.has(stepIndex))
			return null;
		const record = this.texts.get(stepIndex);
		if (record?.state !== "pending") return null;
		record.state = "reserved";
		this.verified.delete(stepIndex);
		this.reserved = stepIndex;
		return { stepIndex, text: record.text };
	}
	ack(stepIndex: number): void {
		if (this.failure) {
			if (this.reserved !== null) this.failure = "DELIVERY_UNCERTAIN";
			return;
		}
		if (
			this.reserved !== stepIndex ||
			this.texts.get(stepIndex)?.state !== "reserved"
		) {
			this.stop("DELIVERY_UNCERTAIN");
			return;
		}
		const record = this.texts.get(stepIndex);
		if (!record) {
			this.stop("DELIVERY_UNCERTAIN");
			return;
		}
		record.state = "acked";
		this.reserved = null;
	}
	/** On ambiguous network failure the chunk may already be visible. */
	failDelivery(): void {
		// An uncertain remote send overrides any earlier local diagnostic.
		this.failure = "DELIVERY_UNCERTAIN";
		this.verified.clear();
		this.reserved = null;
	}
}
