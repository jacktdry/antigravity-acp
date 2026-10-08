# Stream-json parser PoC and validation matrix

Status (2026-10-08): **standalone offline parser implemented**. This is not
production stream-json integration. Only `src/agy/stream-json-poc.ts`, its
synthetic tests, and this document change. Production stdout handling, SQLite
StreamPoller, replay, images, cancellation and native permission remain unchanged.

## Provenance and live evidence

Schema source: [official headless streaming JSON documentation](https://www.agy.dev/docs/cli/headless/#streaming-json),
read on 2026-10-08; the orchestrator identifies this as the AGY 1.3.1 schema.
The page itself is not a version-pinned schema artifact. Source fields are
`event`, `init`, `step_update`, `result`, `conversation_id`, `step_index`,
`state`, and cumulative `num_turns`. No invented `type` or `step` envelope is used.
The following short fixtures use synthetic values in those official shapes:

```json
{"event":"init","conversation_id":"fixture","init":{"cwd":"/synthetic","tools":[],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id":"fixture","step_index":0,"state":"DONE","step_type":"agent_response","text_delta":"synthetic"}}
{"event":"result","result":{"conversation_id":"fixture","status":"SUCCESS","response":"synthetic","num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
```

Read-only local inspection: `agy --help` exited 0 and advertised stream-json
input/output flags. Inspected binary `/Users/wei/.local/bin/agy`, SHA-256
`88db8b4d21ece4999fa58e0b54cea77154e47b319ee178d086c446262317f3fa`.
No prompt, auth operation, installation, service restart or runtime integration
was performed by this worker. Help/hash do not independently establish version.

Orchestrator-supplied restricted OAuth probe evidence: **only an ERROR result
was observed**. No live SUCCESS was observed or established. The worker has no
sanitized capture, exact probe command or trace to independently reproduce it;
this observation is not parser/live compatibility acceptance. Any additional
OAuth prompt requires reporting to the orchestrator first; no Keychain window
may be triggered autonomously.

## Bounded API and state contract

`StreamJsonPocParser.write(Uint8Array)` returns `{consumed, backpressure}`.
Caller retains and retries `chunk.subarray(consumed)` after `read()` drains
queue space. At 32 events, write consumes zero additional bytes. Parser never
retains caller chunks, owns at most one 1 MiB line allocation, and queues at most
32 decoded events. Each event is capped at 1 MiB of bytes before LF, including
CR and incomplete lines. This is a bound on input and event count, not a claim
of a 33 MiB JavaScript heap cap: strings, object overhead, decoder and JSON
scratch space add memory. No whole-stream accumulator or unbounded identity map.

LF/CRLF and arbitrary byte boundaries are supported. Strict UTF-8 decode follows
byte framing. BOM and blank lines fail; valid final JSON without LF is accepted.
`finish()` must only follow consumption of all caller bytes; callers must drain
and retry if it returns false. Result is a turn boundary, not process exit:
`initial -> steps -> result -> steps -> result`, with one init per parser.
Conversation identity stays fixed. EOF without a last result fails, including
EOF during a second turn. No process status, stderr or persistence is inferred.

Step indices may have gaps. Repeated ACTIVE updates are preserved as deltas
(even identical text); ACTIVE -> DONE is valid. This bounded PoC conservatively
requires nondecreasing indices, matching step category for same-index updates,
and no update after that index is DONE. Result `num_turns` must increase; a
first result may use 0 for an error. Repeated init/result and stale conversations
fail. These ordering restrictions cover documented examples, not proof that all
upstream tool/subagent interleavings are supported. Pre-init failure envelopes
and empty conversation IDs fail closed; their real behavior remains a capture
question rather than an invented lifecycle.

Envelope/known fields are checked for object/string/array/number types and
known categories/statuses; token counts and indices are nonnegative safe
integers. Unknown events or extra top-level/payload fields fail closed. Optional
duration, usage, model, agent, structured output and schema fields are checked.
Nested `tool_info`, `subagent_info`, `structured_output` and `json_schema` remain
opaque JSON objects, without nested semantic validation or authority. Partial
tool parameters and output are inert data. Image events are unsupported.
JSON syntax follows JSON.parse (including last-key-wins for duplicate keys).

Parser failures expose only fixed codes: `EVENT_TOO_LARGE`, `INVALID_UTF8`,
`INVALID_JSON`, `INVALID_SCHEMA`, `UNSUPPORTED_SCHEMA`, `INVALID_ORDER`,
`IDENTITY_MISMATCH`, `INCOMPLETE_TRACE`, `CANCELLED`. No raw input or native parser
exception is returned or logged. Native result error text is replaced with
`UPSTREAM_ERROR`; result status remains data, including ERROR/cancellation.
All payload data remains untrusted, including text, paths, tool arguments and
nested tool errors; callers must never treat event payloads as safe diagnostics.
Failure/cancel releases line/queue and refuses further input. EOF is idempotent.
The module has no imports and cannot spawn tools, store credentials, request
approvals or emit ACP updates. It has no Adapter, Agent or SQLite dependency.

## Security validation matrix

| Area | Synthetic evidence | Remaining gate |
| --- | --- | --- |
| Schema | Official envelopes, optional duration/usage, typed/missing/unknown fields | Version-pinned successful live trace |
| Byte chunks | Every two-chunk byte boundary; one-byte partitions with UTF-8/CRLF | Real transport capture |
| Coalescing | Multiple events plus incomplete tail | None for offline contract |
| Limits | Exact 1 MiB LF/CRLF/tail; +1 byte; 5 MiB burst; accumulated incomplete bytes; multibyte limits | Heap/RSS measurement |
| Encoding | Invalid, overlong, surrogate, out-of-range and truncated UTF-8; BOM; blank lines | None for offline contract |
| JSON | Malformed/truncated/scalar/array; terminal fail and no recovery | None for offline contract |
| Ordering | Duplicate init/result/DONE, reversed indices, repeated ACTIVE, index gaps, two turns | Tool/subagent interleaving parity |
| EOF | No-newline final JSON, missing-result/second-turn EOF, idempotence | Actual child exit/DB flush |
| Native errors | All documented result statuses; native error redaction | ERROR-only probe reported; stderr-only/nonzero after result not tested live |
| Tools | ACTIVE/DONE, partial opaque parameters, repeated tool names, inert output | Real invocation identity and nested schema |
| Security | Malformed token/prompt canaries; native error canaries; no imports/authority dependencies | No live secret trace captured |
| Replay | No SQLite coupling or updates | Offline SQLite identity/replay comparison not implemented |
| Images | Unknown image format fails closed; size cap remains enforced | Image references/payload and ACP fidelity unverified |
| Cancel | Fragment cancel discards queue/tail and fabricates no result | SIGINT/kill and delayed flush unverified |
| Pressure | 1502-event burst with consumer draining one event; 32 cap and caller retry | Live long response and heap/RSS unverified |
| Isolation | Independent parsers, fixed conversation identity, stale/restarted event rejection | Owner/incarnation runtime fencing unverified |

## Verification and adoption gate

Validation results are recorded below after final checks. All tests use
synthetic fixtures; no successful real OAuth stream or native UAT is claimed.

Future production work needs separately authorized successful captures, nested
schema/ordering confirmation, SQLite replay/cancel/image parity, process exit
handling, ownership fencing, native approval transport and rollback decisions.
This PoC must not be imported into the official ACP prompt path. It neither
enables persistent children nor replaces SQLite streaming.
