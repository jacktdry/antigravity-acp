# Native AGY PreToolUse subprocess fixture (non-production)

**Status (2026-10-09): isolated fixture only.** This work is on `feature/agy-native-runtime`, based on ACP candidate `1.2.0-agentdock.10`. It does not activate native AGY permissions, attach to AgentDock Next, grant prompts or modify installed binaries. Legacy AgentDock remains unchanged.

## Implemented

- `src/agy/native-hook-runtime.ts` supplies `installNativeHookFixture()`, `subprocessNativeProvider()` and an exact `--agentdock-native-hook` CLI entry point dispatched before the standard ACP process in `index.ts`.
- Installation is restricted to a caller-provided private parent directory with safe ownership/permissions, `AGY_ACP_NATIVE_HOOK=fixture-v1`, `AGY_ACP_AUTO_APPROVE=0` and `AGY_ACP_CHILD_ISOLATION=required`. It creates a new empty private HOME and a PreToolUse config there. This is a separate fixture; **not** the existing AGY authenticated child HOME.
- The hook reads bounded stdin (256 KiB), validates the trusted manifest and the observation fields, and invokes a separately trusted subprocess provider. Requests include the out-of-band owner/incarnation/session/turn/revision binding and SHA-256 operation digest. The response must correlate with the exact operation and unexpired request ID.
- Deny by default on invalid configuration, unknown tool, malformed JSON, provider refusal, missing/replaced provider, timeout, cancellation, stale/mismatched response and replay. `ask` is not automatically approved and returns deny/pending.
- Provider command paths must be absolute, trusted and non-symlinked; the fixture does not accept a user-selected untrusted executable. The tool inputs in the tests are synthetic data only. Hook stdout consists of one bounded decision message; raw args, tokens and prompt text are never printed by the fixture.

## Explicit non-guarantees

**The bridge is NOT plugged into actual `agy -p`.** Real AGY 1.3.1 Hook execution order, custom workspace hooks, hook failure/timeout behavior and `--dangerously-skip-permissions` interactions have not been verified. `AGY_ACP_AUTO_APPROVE=0` continues rejecting every real headless prompt before launch. Neither configuration files stored under a HOME owned by the same UID nor PreToolUse alone constitute an OS-enforced security boundary. The mock provider does not authenticate a future Next Core M8 transport; a SHA-256 request digest establishes correlation, **not authentication**.

Do not run this fixture through the production AgentDock ACP profile. Do not promote to an enforceable permission mode until Next Core provides a mutually authenticated local binding transport with scoped capabilities, owner/lease/turn revocation and audited allow/ask/deny; the AGY runner is protected from mutation/bypass; and a separate OS-level containment or verified enforceable AGY policy covers cases where the Hook is not invoked.

## Next integration gate

Next Core team owns the authoritative M8 policy, local IPC transport, Principal, workspace-bound operation mapping, Ask lifecycle, identity proof, audit/redaction, close/cancel revocation and expiry. ACP may only deliver observations and enforce returned decisions. End-to-end acceptance must include success/deny/timeout/cancel, reconnect, malicious tool args, changed workspace hooks, symlink escapes, Core shutdown and malicious same-UID mutation attempts. If any fail-open route exists, keep the feature unavailable and preserve the current legacy path.

Validation: `bun test tests/agy/native-hook-runtime.test.ts` (subprocess fixtures only); `bun run typecheck`, `bun test`, `bun run lint`, and `bun run build:mac-arm64`. No live AGY prompt is needed or permitted for this stage.
