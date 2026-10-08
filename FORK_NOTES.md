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

Stable AgentDock profiles may set only `AGY_BIN` and an overridden `HOME`,
without the newer `AGENTDOCK_BROWSER_BROKER_REQUIRED` or
`AGENTDOCK_BROWSER_BACKENDS_DISABLED` flags. In that legacy no-Broker case the
adapter must *still* create the per-session Keychain-compatible child sandbox
rather than inherit the broken parent HOME. Normal-HOME generic ACP clients
retain optional Broker behavior. This was confirmed by a live
`loginKC:queryCreate` popup on 2026-10-08 and fixed in `1.2.0-agentdock.8`.

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

## Next integration opt-ins (candidate 1.2.0-agentdock.10)

Source: `feature/next-integration-optin`, based on `4fd494b`. These changes
belong only to the ACP adapter. Stable and Next AgentDock Core/UI/config and
installed adapters are outside this branch. The feature-branch package version
is `1.2.0-agentdock.10`; this is an unreleased candidate pending review.

| Environment | Unset / Legacy | Explicit opt-in |
| --- | --- | --- |
| `AGY_ACP_STATE_DIR` | Existing `HOME/.agy-acp`, unchanged reads/writes | Absolute private directory for `sessions.json` and `models.json`; empty, relative, root, symlink or unsafe permissions fail closed |
| `AGY_ACP_CHILD_ISOLATION` | Existing `.8` behavior, including redirected macOS HOME and Broker isolation | Only `required` is accepted; create a private child HOME with or without Browser/Computer Broker |
| `AGY_ACP_AUTO_APPROVE` | Existing always-skip prompt permission behavior | Only `0` is accepted; omit skip flag, force plan/sandbox in argument construction, reject all extra arguments, refuse headless prompt launch |
| `AGY_CONVERSATIONS_DIR` | Existing conversation path contract | Unchanged; separately choose the Poller/AGY conversation directory when Next must not share Legacy conversations |
| `AGY_EXTRA_ARGS` | Existing splitting/override behavior | Every nonempty value is forbidden with `AGY_ACP_AUTO_APPROVE=0`, including apparently harmless options |

An invalid nonempty/empty value for either new policy switch is an error,
not a return to Legacy defaults. No new dependency or lockfile change is needed.
The legacy state directory is never migrated, chmodded or cleaned automatically.

### State directory contract

The opt-in rejects symlink components (including dangling links); use physical
absolute paths such as `/private/tmp/...`, not the macOS `/tmp` alias. Existing
leaf directories must be owned by the current uid with no group/other access.
Ancestors must be root/current-uid owned and not group/other writable, except
root-owned sticky temporary parents. Newly created directories use `0700`.
Existing state files must be regular, single-link, current-uid owned and private.
Reads use no-follow/nonblocking opens and descriptor checks; writes use unique
exclusive `0600` temporary files and atomic rename. Both stores recheck paths
on access; unsafe session writes reject instead of logging success or falling
back. Invalid JSON in opt-in cache/session files fails with fixed errors.

This is not an OS security boundary against a hostile process running under
the same uid. Node/Bun path APIs cannot make the entire parent traversal and
rename an atomic dirfd-relative operation. Next Core must provision and retain
trusted private parents, prevent concurrent ownership/replacement, use a unique
state directory for each adapter owner, and serialize cross-process writers.
The session queue protects one process only; two ACP servers must not share a
state directory. No mount/volume or Windows ACL isolation is claimed.

### Required child HOME contract

On macOS, the account record from `/usr/bin/id -P` supplies login/auth HOME and
`Library/Keychains`; the parent ACP HOME does not supply Keychain identity.
If the lookup or Keychains directory is unavailable, initialization fails.
Other platforms use the parent home for the allowlisted authentication source.
Authentication files are copied privately; global `.gemini` settings, hooks,
MCP routes, plugin directories and sidecars are not inherited. Required mode
copies no global `security` settings. Generated configuration contains only the
validated Browser/Computer proxy bindings supplied by ACP (or none), and keeps
the browser plugin disabled. Broker capabilities remain env-only, never in the
configuration JSON or command arguments. Model discovery also uses private HOME.

Required mode shares only the conversation directory selected by the existing
ACP `CONVERSATION_DIR`; it does not link brain/knowledge/history/other shared
state. That directory must already exist and be absolute. A new per-session HOME
cannot relocate conversations behind the Poller, since replay/cancel/images
still depend on SQLite. With normal parent HOME and no conversation override,
**conversation storage still intentionally shares the existing login HOME path**.
`AGY_ACP_STATE_DIR` alone does not isolate AGY conversations or OAuth identity.
Next Core must explicitly provision/select conversation storage if isolation is
required. Tests compare normal and redirected parent HOME, distinct login HOME,
Keychain target and explicit conversation storage. Missing prerequisites do not
fall back to the original HOME. Failure cleans the partial sandbox; session
close/delete retain existing sandbox cleanup behavior.

HOME configuration isolation is not a native shell/file sandbox. AGY still
runs as the user's uid in the selected workspace, shares the login Keychain
identity and can access files outside HOME according to its native tool policy.
Project-local configuration and upstream behavior need independent validation.

### Disabled automatic approval: fail-closed availability

The current headless adapter has no implemented transport to service AGY native
shell/file approval requests. `AGY_ACP_AUTO_APPROVE=0` therefore refuses all
prompt launches, including `/usage` and the noninteractive helper, before
spawning AGY or allocating prompt temp files. Model discovery can still run.
The deterministic argument builder omits `--dangerously-skip-permissions` and
selects plan/sandbox, but that vector is **not launched**. Rejecting all extra
arguments prevents aliases, equals syntax, mode/sandbox overrides, configuration
loaders and future unknown options from bypassing this opt-in.

A prompt returns a fixed failure such as:
`failed to prepare AGY child: AGY_ACP_AUTO_APPROVE=0: headless native-tool approval is unavailable; AGY prompt launch refused`.
Usage rejects through the existing ACP request error path. No native tool probe
is performed. **M8 does not intercept AGY native shell/file operations**; Broker
approval covers only calls routed through its own tools. Next Core must expose
this unavailable state accurately. Do not remove the launch gate until an actual
native approval transport, cancellation/timeouts, denial behavior and integration
fixtures exist. Existing default always-skip behavior remains unchanged.

### Remaining Next Core / release responsibilities

- Select opt-in env via the Core profile; do not change parent HOME implicitly.
- Provision private unique adapter state and the desired conversation directory;
  enforce owner/incarnation identity and cross-process lifecycle fencing.
- Bind, revoke and expire Broker capabilities; present Core-owned approvals only
  for the tools actually routed through those Brokers.
- Provide native approval transport before enabling permission-gated AGY prompts.
- Perform authenticated AGY 1.3.1/macOS Keychain UAT, restart/resume/image/cancel
  validation, independent Legacy/Next simultaneous-session testing and release
  review. Fixture tests and a compiled artifact do not prove these checks.
- Explicitly authorize installation/version bump separately. No installed `.8`
  binary, running Stable session or Next session is replaced/stopped here.

Stream-json remains design-only; see
[stream-json PoC design and validation matrix](docs/research/stream-json-poc.md).
