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
- Explicit `AGY_BIN` takes precedence over the adapter's bundled/downloaded
  AGY binary so AgentDock can pin the authenticated system CLI intentionally.
- Concurrent turns for one ACP session are rejected instead of replacing the
  process currently being managed.
- AGY's concrete model variants are presented as separate `Model` and
  `Reasoning effort` ACP config options while preserving the exact concrete
  model ID in persisted session state.
- Model selection never synthesizes an ID that `agy models` did not advertise.

## AgentDock runtime layout

AgentDock should run the adapter with an isolated `HOME` so `agy` does not
start the user's interactive MCP/plugin configuration for every delegated turn.
The isolated home can symlink only `~/.gemini/antigravity-cli` from the real
home to share Antigravity authentication and conversation databases while
leaving `~/.gemini/config` absent. AgentDock should also provide `AGY_BIN`
pointing at the authenticated, up-to-date system `agy` executable.

The ACP profile should pass those values with AgentDock's per-profile
`env_from_env` mapping rather than adding a second AGY execution path.

### macOS Keychain compatibility

The official AGY CLI keeps its active OAuth credential in the macOS login
Keychain (the `Antigravity Safe Storage` / `Antigravity Key` generic-password
item). A fully relocated `HOME` therefore breaks credential lookup even when
OAuth metadata files are copied into the sandbox: Security.framework treats the
sandbox as having an unconfigured default keychain and can invoke
`loginKC:queryCreate`, producing repeated authorization dialogs.

AgentDock must keep the private `.gemini` sandbox, but on macOS it also
symlinks the real `~/Library/Keychains` directory into
`<isolated-home>/Library/Keychains`. The source must come from the macOS
account's passwd record (`/usr/bin/id -P`), **not** `os.homedir()` or
`os.userInfo().homedir`: the Bun runtime returns the overridden ACP-profile
`HOME` for both APIs. This preserves the user's existing login Keychain
identity without exposing the user's interactive `.gemini/config`,
MCP routes, plugins, hooks, or sidecars.

Cleanup must remove only the sandbox and the Keychains symlink; it must never
traverse into or delete the real Keychains directory. Tests cover this invariant.

Do not mutate login-keychain ACLs, trust settings, or passwords from AgentDock
as a workaround. If an independently installed `agy` still needs a Keychain
ACL adjustment, that remains an explicit user action rather than adapter
automation.

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
