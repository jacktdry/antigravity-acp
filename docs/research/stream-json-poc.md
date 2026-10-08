# Stream-json PoC design and validation matrix

Status: **design only**. No stream-json parser, real AGY capture or production
integration is delivered by this candidate. AGY upstream 1.3.1 is the intended
validation target supplied by the task, not a locally reverified event schema.
Current production prompts remain one child per turn with stdout ignored and
SQLite `StreamPoller` streaming; replay, cancellation and images stay intact.

## Proposed bounded PoC

Add `src/agy/stream-json-poc.ts` as a standalone module with no import from
`Adapter`, `Agent`, `index.ts` or `StreamPoller`. Its input is bytes and its output
is typed experimental events; it must not spawn AGY, write session state, request
approvals, run tools or emit ACP updates. Fixture input must contain synthetic
text, conversation ids and tool names, with no tokens or real prompt contents.

Before implementation, capture the actual 1.3.1 format using an independently
approved, harmless isolated text-only prompt after inspecting its CLI help/source.
Do not infer upstream field names from this design. In particular, determine
whether `init`, `step`, `result`, error and partial tool arguments are actual event
types, and whether stdout is NDJSON, structured messages or mixed diagnostics.
Maintain the captured schema provenance (CLI version/hash and capture command).
If there is no stable framing/event identity, the PoC remains unsupported.

For a confirmed NDJSON format, propose a 1 MiB **byte** limit per event, including
an unterminated line, and a bounded event queue (32) with backpressure. Do not
buffer an entire stdout stream. Split lines from bytes before strict UTF-8 decode;
retain only the unfinished line. Handle LF/CRLF and multibyte characters split
across chunks. Enforce the size limit before JSON parsing; reject invalid UTF-8,
JSON, scalar/array envelopes or missing required fields with fixed error codes.
Never include a raw line, tool arguments or parser exception excerpt in errors.
Define final unterminated valid JSON acceptance explicitly in fixture tests.

Use a terminal parser state: after framing/schema/size failure, release the
buffer and refuse further input. Explicit errors should become bounded typed
error events, not arbitrary thrown text. Unknown event types must stop the PoC
with an unsupported-schema error until intentionally supported. Init/step/result
ordering must be validated; require one init and one terminal result, forbid
steps after terminal, and distinguish clean EOF from missing-result EOF.
Do not equate a terminal result with successful process exit or persistence.

## Validation matrix (all pending)

| Area | Fixture / check | Expected evidence |
| --- | --- | --- |
| Schema | Version-pinned synthetic init/step/result trace | Correct typed events and identifiers; actual 1.3.1 schema provenance |
| Byte chunks | Split every byte boundary, including UTF-8 and CRLF | Identical output for all partitions |
| Coalescing | Multiple complete events and partial tail in one chunk | Ordered events, bounded retained tail |
| Limits | Exactly 1 MiB, one byte above, huge unterminated input | Deterministic acceptance/rejection before parse; buffer released |
| Encoding | Invalid UTF-8, BOM policy, empty lines | Explicit contract; no silent substitution |
| Invalid JSON | Truncation, malformed JSON, scalar, array | Fixed redacted error; no recovery into next event |
| Ordering | Duplicate init/result, step before init/after result | Explicit protocol failure |
| EOF | Valid no-newline tail, incomplete JSON, no result | Documented final-tail policy; incomplete trace remains failure |
| Native errors | Error event, stderr-only exit, nonzero exit after result | Parser and process failures kept distinct |
| Tools | Partial arguments, tool start/end, repeated ids | No execution/approval; safe experimental representation |
| Security | Token/prompt canaries in malformed or error events | No canary in logs/errors; raw fixture input never logged |
| Replay | SQLite vs captured event identity/ordering | Duplicate suppression/resume semantics proven separately |
| Images | Text plus image references/payload and large image | Size policy and ACP fidelity decided before adoption |
| Cancel | SIGINT/kill between event fragments, delayed DB flush | Existing exact-child lifecycle retained; no terminal fabrication |
| Pressure | Slow consumer / long response / oversized burst | Queue bound, backpressure and bounded memory verified |
| Isolation | Two sessions, restarted child and stale events | No cross-session updates; owner/incarnation fenced |

## Precise next steps and production gate

1. Verify 1.3.1 CLI framing/schema in an isolated nonproduction capture; record
   sanitized provenance. Keep live Stable/Next executables and sessions untouched.
2. Implement only the standalone parser and synthetic fixture tests above.
   Validate byte/memory bounds and error redaction before process integration.
3. Build a separate offline comparison harness for stream events vs sanitized
   SQLite rows (including replay, cancel and images); publish mismatches.
4. Resolve conversation identity, persisted step index, duplicate suppression,
   EOF/nonzero exits, buffering, partial tool events and native approval transport
   as independent contracts. Stream output alone supplies no approval authority.
5. Request a separate production-integration scope only after the matrix passes.
   Preserve a tested SQLite path and an explicit rollback decision; do not enable
   long-lived children or switch ACP prompts merely because parsing works.

This document is the PoC deliverable for the current bounded task. Every matrix
row is pending, and no stream-json integration claim or native permission claim
is made. The decision preserves SQLite as the source of truth for existing ACP
replay/cancel/image behavior until parity is demonstrated.
