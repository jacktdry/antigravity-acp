# Stream-json direct text admission: offline readiness checkpoint

Status: **prototype only, not an enabled ACP mode**. Branch `feature/agy-stream-direct-experimental` from `1.2.0-agentdock.11`.

## Design and implemented checks

`src/agy/stream-direct-ledger.ts` provides `StreamDirectLedger`, a bounded pure state machine for assessing **whether a stream-json agent_response can be offered to an ACP transport**, without sending it. It consumes already schema-validated `PocEvent` objects and terminal `StepRow` values from the existing SQLite conversation store. It does not invoke AGY, access OAuth, write conversation state or emit ACP updates.

- Hard-bind an AGY conversation ID and discard prior Session steps; reject identity mismatches, unsupported tools/checkpoints, invalid state/ordering, non-success results and stale or extra DB rows.
- Stage at most 1 MiB of agent text across 128 text steps, require the real `result.status=SUCCESS` and exact full-text equality with **terminal** SQLite rows (`status=3`). An incomplete row or missing identity/result never authorizes output.
- `verifyDb` returns *candidates*, not updates. Caller must `reserve` once **before** its outgoing `client.update`, then `ack` only after success. Repeated verification and reservation cannot duplicate a committed text step; multiple steps preserve step order.
- An ambiguous update failure, cancellation while a send is in flight, or a later DB rewrite after an acknowledged send makes safe automatic retransmission impossible. The ledger exposes this as `DELIVERY_UNCERTAIN` / `POST_COMMIT_DIVERGENCE` with `safeToRetry=false`. It does **not** silently switch output source after client visibility is uncertain.
- Tools, images, quota handling and replay remain solely in the existing DB translator. There is no promotion of `tool_info` or untrusted event payloads into ACP messages.

## Why direct runtime is deliberately not enabled yet

This contract establishes admission, **not a promise of low-latency direct streaming**. Waiting for a completed SQLite text row already limits its potential latency advantage. It also cannot prove an upstream AGY session will never rewrite a row after publication. Once an ACP client has received a delta, there is no protocol mechanism to retract it; a thrown `client.update` may still have been delivered remotely. No pure adapter fallback can unconditionally provide both no lost and no duplicate output in these cases.

Do not introduce `AGY_ACP_STREAM_JSON=direct` or feed this prototype into `Adapter.runPrompt` without first completing:

1. User-authorized, disposable-profile AGY event/SQLite parity traces that **do not cause unexpected OAuth prompts**, including multi-step, tools, images, models and cancellations.
2. Integrate the now implemented shared suppression cursor into a Next-only Adapter path only after proving ordered tool/image/usage updates and safe remote-ACK handling.
3. A defined failure policy for client.update ambiguity and DB post-commit mutation. Fail-closed or reset a disposable Next-only session; do not claim invisible automatic rollback.
4. Benchmark first token, CPU, RSS, DB polling, retry and error paths against shadow/default.
5. Next-only UAT and explicit approval to enable a separate experimental profile. Keep Legacy AgentDock and the current installed Next binary unchanged.

Test file: `tests/agy/stream-direct-ledger.test.ts`. All tests use synthetic `PocEvent` and `StepRow` fixtures; no AGY process, authentication, external tool or live ACP transport is invoked.

## Shared Translator / Poller suppression cursor (follow-up)

A second, still **disabled-by-default** research increment adds methods to the
same live `Translator` / `StreamPoller` currently serving SQLite:

- `StreamPoller.reserveExternalText(conversationId, stepIndex, exactText)` checks
  the already-open, bound conversation DB, rejects preceding unhandled steps,
  requires one exact terminal text row, and asks its **existing** Translator
  to reserve that text before any outbound client send.
- `StreamPoller.ackExternalText(token)` records successful delivery. Subsequent
  SQLite polls suppress that complete text step but continue dispatching tool
  rows. Replay remains independently DB-backed.
- `StreamPoller.abortExternalText(token)` permanently seals that Translator:
  uncertain remote delivery cannot be safely undone or replayed. While
  reserved, `poll()` refuses to emit updates; after an acknowledged send any
  later DB edit of that text step fails closed with a fixed error code.

This extends, but does **not** replace, `StreamDirectLedger`. A future
orchestrator must coordinate the *two* reservations, serialize the outgoing
`client.update`, confirm both ledgers only after transport success, and
terminate/surface any delivery ambiguity without automatic retransmission.
The current `Adapter.runPrompt` does not call these methods and does not
expose a `direct` mode. The existing default and shadow paths are unchanged.

The necessary live UAT still needs an authorization-safe AGY corpus and a
defined recovery contract for lost transport acknowledgements. A completed
SQLite row check does not itself prove upstream immutability and waiting for
such rows cannot be advertised as faster first-token streaming. For this
reason this increment is **handoff infrastructure, not a productized
direct-stream mode**.

The synthetic+SQLite tests in
`tests/conversation/external-text-delivery.test.ts` verify exact-once
suppression, prior-step ordering, trailing tool updates, Unicode, wrong
identity/text/status/token, duplicate attempts, post-send DB mutation,
cancel/abort behavior and independent replay behavior.

## Cross-event / failure-recovery hardening (2026-10-09)

The next candidate increment adds **full DB snapshot validation of previously
ACKed text rows** before every SQLite poll and before reserving a subsequent
external send. It seals the Translator when a previously delivered step is
missing, duplicated, demoted from terminal status, changes kind, or has its
text rewritten. Validation indexes acknowledged steps once and scans the DB
snapshot in O(rows + acknowledged steps) rather than a nested scan. The
independent `StreamDirectLedger` also treats a removed or nonterminal row
*after ACK* as `POST_COMMIT_DIVERGENCE` instead of silently awaiting rows.

`tests/agy/stream-cross-event-recovery.test.ts` uses temporary SQLite DBs,
synthetic AGY `init`/`step_update`/`result` events and a mock unreliable
client to exercise two-ledger delivery, Unicode chunks, missing/incomplete DB
steps, tool-only fallback, mismatched text, partial delivery followed by
ambiguous client error, cancellation races, resumed sessions and independent
history replay. `tests/conversation/external-text-delivery.test.ts` adds DB
row deletion, duplicate indices, terminal-state regression and validation
*between* consecutive outgoing sends. No real AGY process or OAuth flow runs.

**Important limitation:** this is still an offline reconciliation harness.
The mock sender illustrates safe denial, not a solution to exactly-once delivery
when an ACP connection loses its ACK. A completed SQLite row can be rewritten
later and the system cannot unsend text. The Adapter still never calls the
experimental reservation methods; Legacy and Shadow use SQLite updates.
Promotion still requires AGY/SQLite real-event parity and a deliberately
specified reconnect/resume protocol owned jointly with Next Core.
