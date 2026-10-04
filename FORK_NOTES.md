# AgentDock fork notes

This fork keeps `main` aligned with `shubzkothekar/antigravity-acp`.
AgentDock-specific changes live on `fix/agentdock-hardening`.

## Why this branch exists

AgentDock uses this adapter as its single Antigravity ACP path. The upstream
adapter already provides the desired `agy` CLI bridge and full model
discovery, but AgentDock needs stricter lifecycle behavior and a cleaner model
configuration surface.

## AgentDock hardening

- Cancellation is idempotent and escalates from `SIGINT` to `SIGKILL`
  after a bounded grace period on non-Windows platforms.
- `session/close` and `session/delete` wait for active prompt cleanup before
  evicting or deleting session state.
- `/usage` uses the same tracked child-process lifecycle as normal prompts.
- Concurrent turns for one ACP session are rejected instead of replacing the
  process currently being managed.
- AGY's concrete model variants are presented as separate `Model` and
  `Reasoning effort` ACP config options while preserving the exact concrete
  model ID in persisted session state.
- Model selection never synthesizes an ID that `agy models` did not advertise.

## Updating from upstream

1. Fetch `upstream/main`.
2. Fast-forward the fork's `main` to `upstream/main`.
3. Merge `upstream/main` into `fix/agentdock-hardening`.
4. Resolve conflicts while retaining the hardening above.
5. Run typecheck, lint, the full Bun test suite, a native build, and live
   `agy models` catalog verification.
6. Bump the `-agentdock.N` prerelease version when the hardening branch
   changes.

Do not put AgentDock-specific changes directly on `main`.
