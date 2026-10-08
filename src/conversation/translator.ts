// Shared step → ACP update engine for both live streaming and history replay.
//
// Streaming and replay only really differ in how they treat the agent's text
// stream (step type 15):
//
//   • streaming emits the newly-appended slice each poll (text grows in place
//     at a fixed idx), deduping tool steps it has already sent;
//   • replay buffers consecutive agent-text parts and flushes them as one
//     message at each boundary, applying narration filtering across the group.
//
// Everything else — tool calls, titles, user prompts, and the task/permission/
// error enrichment — is identical, so it flows through the same per-step
// dispatcher (`buildUpdatefromStepPayload`). This class owns the one row loop;
// the two modes are just small branches inside it.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { filterNarration, isNarration } from "../narration";
import type { StepRow } from "../types";
import { toolCallId } from "../updates/utils";
import { buildUpdatefromStepPayload } from "./updates";

export type TranslateMode = "stream" | "replay";

export interface TranslatorOptions {
	mode: TranslateMode;
	skipNarration: boolean;
	/** Project working dir, used to render display paths in tool calls. */
	cwd?: string;
}

function agentChunk(text: string): SessionUpdate {
	return {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text },
	};
}

export class Translator {
	// Streaming: idx -> chars of agent text already emitted (for incremental diff).
	private readonly agentTextLengths = new Map<number, number>();
	// Optional, disabled-by-default handoff state for *externally* delivered text.
	// Only the same live Translator may suppress those chunks from SQLite.
	private readonly externallyDelivered = new Map<
		number,
		{ text: string; token: number; state: "reserved" | "acked" }
	>();
	private nextDeliveryToken = 0;
	private pendingExternalToken: number | null = null;
	private externalDeliveryFailed = false;
	// Streaming: tool step indices already emitted (dedup across polls).
	private readonly emittedSteps = new Set<number>();
	// Streaming: tool steps emitted with a non-terminal status (idx -> toolCallId).
	// agy updates step rows in place as tools run, so a later poll can observe
	// the terminal transition and close the tool-call lifecycle (see
	// `emitToolStepTerminal`).
	private readonly openToolSteps = new Map<number, string>();
	// Replay: buffered consecutive agent-text parts, flushed at boundaries.
	private readonly pendingAgentParts: string[] = [];

	private _lastTitle: string | null = null;
	private _lastStepIdx = -1;
	private _hadUpdates = false;

	constructor(private readonly opts: TranslatorOptions) {}

	/** Highest step idx seen so far. */
	get lastStepIdx(): number {
		return this._lastStepIdx;
	}

	/** Whether any update has been produced across all batches. */
	get hadUpdates(): boolean {
		return this._hadUpdates;
	}

	/**
	 * Reserve a *terminal* SQLite-verified text step before an external
	 * client.update. This never emits an ACP update. It is deliberately not
	 * called by the current Adapter (disabled/shadow modes remain unchanged).
	 *
	 * The caller must serialize all deliveries against translate() until it
	 * acknowledges the send. A failed/ambiguous send permanently seals this
	 * Translator rather than attempting an unsafe automatic replay.
	 */
	reserveExternalText(row: StepRow, exactText: string): number {
		if (
			this.opts.mode !== "stream" ||
			this.externalDeliveryFailed ||
			this.pendingExternalToken !== null
		)
			throw new Error("AGY_EXTERNAL_TEXT_UNAVAILABLE");
		const authoritative = row.stepPayload.agentText?.text;
		if (
			!Number.isSafeInteger(row.idx) ||
			row.idx < 0 ||
			row.stepType !== 15 ||
			row.status !== 3 ||
			typeof exactText !== "string" ||
			exactText.length === 0 ||
			authoritative !== exactText ||
			this.agentTextLengths.has(row.idx) ||
			this.externallyDelivered.has(row.idx) ||
			row.idx < this._lastStepIdx ||
			(this.opts.skipNarration && isNarration(exactText))
		)
			throw new Error("AGY_EXTERNAL_TEXT_UNVERIFIED");
		const token = ++this.nextDeliveryToken;
		this.externallyDelivered.set(row.idx, {
			text: exactText,
			token,
			state: "reserved",
		});
		this.pendingExternalToken = token;
		return token;
	}

	/** Only call after client.update resolves; a late ACK cannot revive a failed send. */
	ackExternalText(token: number): void {
		if (this.externalDeliveryFailed || this.pendingExternalToken !== token)
			throw new Error("AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN");
		const record = [...this.externallyDelivered.entries()].find(
			([, r]) => r.token === token,
		);
		if (record?.[1].state !== "reserved")
			throw new Error("AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN");
		record[1].state = "acked";
		this.agentTextLengths.set(record[0], record[1].text.length);
		this._lastStepIdx = Math.max(this._lastStepIdx, record[0]);
		this._hadUpdates = true;
		this.pendingExternalToken = null;
	}

	/** Uncertain remote delivery is never retried through SQLite. */
	abortExternalText(token: number): void {
		if (this.pendingExternalToken !== token)
			throw new Error("AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN");
		this.externalDeliveryFailed = true;
		this.pendingExternalToken = null;
	}

	/**
	 * Verify *every* previously acknowledged external delivery against a full
	 * SQLite turn snapshot. Required because a removed row, duplicate idx or
	 * reverted status cannot be detected by the incremental text handler alone.
	 *
	 * StreamPoller calls this before dispatching any updates. Unlike translate(),
	 * this needs all rows for the current turn (not a filtered/incremental batch).
	 */
	assertExternalSnapshot(rows: readonly StepRow[]): void {
		if (this.externalDeliveryFailed)
			throw new Error("AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN");
		// Index the *acknowledged* steps only, so even a large SQLite turn
		// snapshot is verified in O(rows + acknowledged) rather than O(N*M).
		const acknowledged = new Map<number, { text: string; count: number }>();
		for (const [idx, record] of this.externallyDelivered) {
			if (record.state === "acked")
				acknowledged.set(idx, { text: record.text, count: 0 });
		}
		if (acknowledged.size === 0) return;
		for (const row of rows) {
			const record = acknowledged.get(row.idx);
			if (!record) continue;
			record.count++;
			if (
				row.stepType !== 15 ||
				row.status !== 3 ||
				row.stepPayload.agentText?.text !== record.text ||
				record.count !== 1
			) {
				this.externalDeliveryFailed = true;
				throw new Error("AGY_EXTERNAL_TEXT_DIVERGENCE");
			}
		}
		for (const record of acknowledged.values()) {
			if (record.count !== 1) {
				this.externalDeliveryFailed = true;
				throw new Error("AGY_EXTERNAL_TEXT_DIVERGENCE");
			}
		}
	}

	/** Translate a batch of rows into ordered ACP updates, advancing state. */
	translate(rows: StepRow[]): SessionUpdate[] {
		if (this.externalDeliveryFailed)
			throw new Error("AGY_EXTERNAL_TEXT_DELIVERY_UNCERTAIN");
		if (this.pendingExternalToken !== null)
			throw new Error("AGY_EXTERNAL_TEXT_DELIVERY_PENDING");
		const out: SessionUpdate[] = [];
		for (const row of rows) this.translateRow(row, out);
		// Replay groups agent text per batch; a batch ends a message boundary.
		if (this.opts.mode === "replay") this.flushAgentBuffer(out);
		if (out.length > 0) this._hadUpdates = true;
		return out;
	}

	private translateRow(row: StepRow, out: SessionUpdate[]): void {
		this._lastStepIdx = Math.max(this._lastStepIdx, row.idx);

		switch (row.stepType) {
			case 15: // agent text chunk
				this.handleAgentText(row, out);
				return;

			case 23: // conversation title
				this.handleTitle(row, out);
				return;

			case 14: // user prompt
				// The streaming client already has its own prompt; only replay re-emits it.
				if (this.opts.mode === "stream") return;
				this.flushAgentBuffer(out);
				this.pushDispatched(row, out);
				return;

			default: {
				// Tool calls and lifecycle steps. In replay, a tool call ends the
				// current agent message; in streaming, dedup by idx across polls.
				if (this.opts.mode === "replay") {
					this.flushAgentBuffer(out);
				} else if (this.emittedSteps.has(row.idx)) {
					// agy moves a step's status in place (same idx) as its tool runs,
					// and every poll re-reads the whole turn — so a tool step that was
					// first emitted mid-run may have reached a terminal state since.
					// Re-emit it as tool_call_update so clients can close the
					// tool-call lifecycle; without this, such a step stays
					// in_progress forever.
					this.emitToolStepTerminal(row, out);
					return;
				}
				this.emittedSteps.add(row.idx);
				for (const update of this.dispatchStep(row)) {
					out.push(update);
					this.trackOpenToolStep(row.idx, update);
				}
			}
		}
	}

	/**
	 * Remember tool-call updates emitted with a non-terminal status, so a later
	 * poll can close them once agy reports the outcome. Terminal tool calls and
	 * non-tool updates need no tracking.
	 */
	private trackOpenToolStep(idx: number, update: SessionUpdate): void {
		if (this.opts.mode !== "stream") return;
		if (update.sessionUpdate !== "tool_call") return;
		// An absent status means in_progress per the ACP spec.
		if (update.status === "completed" || update.status === "failed") return;
		this.openToolSteps.set(idx, update.toolCallId);
	}

	/**
	 * Re-build the update for an already-emitted tool step and emit it as
	 * tool_call_update when agy has since moved it to a terminal state. Steps
	 * still in flight are suppressed — only the terminal transition is worth a
	 * notification.
	 */
	private emitToolStepTerminal(row: StepRow, out: SessionUpdate[]): void {
		if (!this.openToolSteps.has(row.idx)) return;
		for (const update of this.dispatchStep(row)) {
			if (update.sessionUpdate !== "tool_call") continue;
			if (update.status !== "completed" && update.status !== "failed") continue;
			out.push({ ...update, sessionUpdate: "tool_call_update" });
			this.openToolSteps.delete(row.idx);
		}
	}

	/** Build the ACP updates for one step via the per-step-type dispatchers. */
	private dispatchStep(row: StepRow): SessionUpdate[] {
		const update = buildUpdatefromStepPayload(row, this.opts.cwd);
		if (Array.isArray(update)) return update;
		return update ? [update] : [];
	}

	private pushDispatched(row: StepRow, out: SessionUpdate[]): void {
		const update = buildUpdatefromStepPayload(row, this.opts.cwd);
		if (Array.isArray(update)) {
			out.push(...update);
		} else if (update) {
			out.push(update);
		}
	}

	private handleTitle(row: StepRow, out: SessionUpdate[]): void {
		const title = row.stepPayload.titleUpdate?.title ?? null;
		const blocks = title?.split("\n\n");
		const currentTitle = blocks?.shift() || null;
		if (currentTitle !== this._lastTitle) {
			this._lastTitle = currentTitle;
			out.push({ sessionUpdate: "session_info_update", title: currentTitle });
		}

		if (!blocks || blocks?.filter((b) => b.trim().length > 0).length === 0)
			return;

		out.push({
			sessionUpdate: "tool_call",
			toolCallId: toolCallId(row),
			title: "Think",
			kind: "think",
			status: "completed",
			content: [
				{
					type: "content",
					content: {
						type: "text",
						text: blocks?.join("\n\n") || (currentTitle ?? ""),
					},
				},
			],
		});
		return;
	}

	private handleAgentText(row: StepRow, out: SessionUpdate[]): void {
		const text = row.stepPayload.agentText?.text ?? "";

		if (this.opts.mode === "replay") {
			if (text.length > 0) this.pendingAgentParts.push(text);
			return;
		}

		// Once a verified chunk reached the client by an external source,
		// a later SQLite rewrite cannot be treated as a harmless suffix.
		const external = this.externallyDelivered.get(row.idx);
		if (external) {
			if (external.state !== "acked" || text !== external.text) {
				this.externalDeliveryFailed = true;
				throw new Error("AGY_EXTERNAL_TEXT_DIVERGENCE");
			}
			return;
		}

		// Streaming: emit only the slice appended since the last poll for this idx.
		const emitted = this.agentTextLengths.get(row.idx) ?? 0;
		if (text.length <= emitted) return;
		this.agentTextLengths.set(row.idx, text.length);
		if (this.opts.skipNarration && isNarration(text)) return;
		const delta = text.slice(emitted);
		if (delta.length > 0) out.push(agentChunk(delta));
	}

	private flushAgentBuffer(out: SessionUpdate[]): void {
		if (this.pendingAgentParts.length === 0) return;
		const text = this.opts.skipNarration
			? filterNarration(this.pendingAgentParts)
			: this.pendingAgentParts.join("\n");
		this.pendingAgentParts.length = 0;
		if (text && text.length > 0) out.push(agentChunk(text));
	}
}
