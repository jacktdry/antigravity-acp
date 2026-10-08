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
2. A shared per-step suppression cursor in `Translator` / `StreamPoller` to prevent replaying directly sent text; verify tool updates remain in timestamp/index order.
3. A defined failure policy for client.update ambiguity and DB post-commit mutation. Fail-closed or reset a disposable Next-only session; do not claim invisible automatic rollback.
4. Benchmark first token, CPU, RSS, DB polling, retry and error paths against shadow/default.
5. Next-only UAT and explicit approval to enable a separate experimental profile. Keep Legacy AgentDock and the current installed Next binary unchanged.

Test file: `tests/agy/stream-direct-ledger.test.ts`. All tests use synthetic `PocEvent` and `StepRow` fixtures; no AGY process, authentication, external tool or live ACP transport is invoked.
