# AGY single-turn stream-json shadow runtime

**Status (2026-10-09): experimental opt-in shadow, NOT direct ACP streaming.** Branch `feature/agy-stream-runtime`, based on ACP candidate `1.2.0-agentdock.10`. Source only. No AGY OAuth/prompt tests, deployment, or changes to installed Stable/Next binaries.

## Opt-in contract

The new `AGY_ACP_STREAM_JSON` setting is **disabled by default**; `disabled` has the Legacy behavior. Only `shadow` is accepted, and it rejects `AGY_EXTRA_ARGS` so unreviewed flags cannot rewrite input/output framing. It appends `--output-format stream-json` to the single-turn AGY args and captures bounded stdout while still using the existing per-turn child, Browser/Computer Broker, separate authenticated private HOME, stderr, SQLite StreamPoller and exact-child cancellation.

`src/agy/stream-json-runtime.ts` drives the offline bounded parser from `src/agy/stream-json-poc.ts`. The capture checks conversation/step identities, incremental agent text and SQLite rows, preserves the 1 MiB event / 32 event queue parsing limits, and caps retained text and number of steps. Invalid schemas, missing results, stale conversations, multiple turns and mismatched DB text set fixed shadow fallback diagnostics. Never print raw prompt contents or upstream error payload. Limit stdout drain after child exit; a hanging pipe must not prevent normal cancellation.

**SQLite remains the authoritative ACP output and replay source.** The shadow path neither emits SessionUpdate events nor changes Session persistence/replay. Shadow failures must not turn an otherwise successful SQLite prompt into an error. Usage quotas, images, restores and termination still follow the same established paths. This architecture deliberately avoids duplicate notifications and fabricated completion.

## Limitations, validation and promotion gates

This feature is an observability bridge, **not** the requested final direct stream output. The parser matches AGY 1.3.1 documentation but real successful OAuth-backed AGY schema and tool/image parity are **not** verified. No live `agy -p` was used to avoid unexpected OAuth/Keychain UI. Shadow logs can show fixed diagnostic codes; they are not the source of ACP error status. No long-running `--input-format stream-json` mode is implemented.

Tests: `bun test tests/agy/stream-json-runtime.test.ts tests/acp/stream-json-shadow.test.ts` cover input/identity/parsing/backpressure, Legacy vs shadow output parity, errors, cancellation, nonzero child exit, restored DB rows, image prompt intact, bounded pipe drain, invalid switch and replay. Full Bun suite, typecheck, lint and macOS native build run separately.

Before direct ACP streaming, collect explicit user-authorized live AGY events in an isolated disposable profile without initiating surprise OAuth, validate tool/image/usage/partial deltas, exact stepIndex and timeline parity against SQLite, prevent duplicate tool updates, handle return codes/long-running/SIGINT, and prove rollback automatically restores SQLite output with zero lost or duplicated ACP messages. Only then add a distinct direct-stream gate and Next-only UAT. Stable AgentDock stays unchanged.
