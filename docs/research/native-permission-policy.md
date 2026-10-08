# Native permission hook bridge PoC

2026-10-08, branch `feature/agy-native-permission-policy`, base
`4714f6598deaf7ad9b389f706c2349e14dc77cff`.

## Evidence and decision

The installed `/Users/wei/.local/bin/agy` reports `1.3.1`. Read-only
`agy --version`, `agy --help` and `agy help` succeed. Help advertises
`--dangerously-skip-permissions`, plan/accept-edits, sandbox and print modes;
it does not advertise a native approval RPC. Help alone is not evidence that
hooks are absent. No agent prompt, destructive Shell/File probe, install,
update, remote-control operation or installed ACP binary is used here.

The official [Hooks documentation](https://www.agy.dev/docs/hooks/), checked
on this date, specifies CLI configuration in global config, CLI settings,
workspace and plugin files. PreToolUse exchanges JSON with a command handler
before tool execution. Its documented decisions include allow, deny, ask,
force_ask and deny_unless_prior_grant. This is a credible API for a PoC.
The page describes a default 30-second handler timeout but does not establish
fail-closed behavior after handler crash, missing executable, malformed output
or timeout, nor precedence among multiple hooks or skip-permissions.

The official [Headless documentation](https://www.agy.dev/docs/cli/headless/)
says unavailable approval is soft-denied, and the run may exit successfully;
workspace file access may already be allowed. Removing skip-permissions is
therefore insufficient to enforce Core M8 decisions on every native operation.

Read-only local configuration inspection emits structural keys only, never
credential or rule values: login CLI settings exist with model/colorScheme,
permissions and trustedWorkspaces, but no hooks key. Global hooks.json exists
with one named definition. This worktree has no `.agents/hooks.json` or
`.gemini/settings.json`. Nothing is copied, edited or invoked from those files.
The repository has no available codebase-memory/index entry point discovered
in local files/tools; durable findings are recorded here within the authorized
worktree, without modifying external memory stores.

**Decision:** implement an independent adapter-local mock-provider PoC; keep
`AGY_ACP_AUTO_APPROVE=0` refusing all runtime prompts. An official hook exists;
a verified, fail-closed AGY-to-Core runtime bridge does not exist in this branch.
M8 currently governs only calls routed through Core-owned Brokers. No native
Shell/File enforcement by Next Core is claimed.

## Implemented and deliberately unconnected

`src/agy/native-permission-policy.ts` provides typed policy/errors, the
PreToolUse input-to-output evaluator and a POSIX hook configuration factory.
It does not execute commands/files, open sockets, install an executable,
write production settings, add an ACP method or enable a runtime switch.
Tests supply an independent mock Core provider and write one temporary private
HOME configuration fixture. All Shell/File operations in payloads are data.

The evaluator accepts one JSON string (maximum 256 KiB), a trusted out-of-band
binding, a provider and optional cancellation/deadline. It validates envelope,
conversation, workspace and step identity. Supported tools are run_command,
view_file, write_to_file, replace_file_content, multi_replace_file_content,
list_dir, find_by_name and grep_search. Everything else denies before Core;
subagents, scheduling, background task input and unknown future tools are not
implicitly trusted. Tool-specific argument/resource validation belongs to Core
and is NOT implemented by this mock transport.

Each request contains version 1, a fresh requestId, SHA-256 operationDigest,
the owner/incarnation/session/turn/policy revision binding and exact tool args.
The digest uses sorted JSON object keys, preserves array order, and includes
the complete binding, step and tool call. It is correlation, not authentication.
A response must match requestId and digest, contain an unexpired expiresAt and
a recognized decision. Only Core allow returns hook allow. Core deny returns
deny; unresolved ask returns deny with approval-pending. There is no local
cached grant, AGY ask/force_ask fallback or permissionOverrides. A later approval
must be consumed by Core in a fresh request, never replay the old response.

The default provider deadline is 1 second, configurable up to 25 seconds.
Timeout/cancellation aborts the provider signal, returns deny and ignores late
allow. A provider that ignores abort can remain pending: the real bridge must
close its request/socket and remove pending approvals on abort. The evaluator
cleans its own timer/listener. It cannot control AGY's behavior if the hook
process itself is never run, crashes or cannot deliver stdout.

Fixed output reasons are AGY_NATIVE_CORE_ALLOWED, DENIED, APPROVAL_PENDING,
UNAVAILABLE, RESPONSE_INVALID, TIMEOUT, CANCELLED (each prefixed
`AGY_NATIVE_CORE_`), plus AGY_NATIVE_HOOK_INPUT_INVALID and TOOL_UNSUPPORTED.
No raw input, paths, command, provider reason or exception is reflected to
stdout. Policy errors expose typed code/message without environment values:
AGY_NATIVE_POLICY_INVALID, AGY_NATIVE_EXTRA_ARGS_FORBIDDEN and
AGY_NATIVE_APPROVAL_UNAVAILABLE. These are internal adapter diagnostics;
there is no new public ACP diagnostics method in this branch.

`process.ts` uses these typed policy errors. Invalid switch values reject,
every extra token rejects in blocked mode, and spawn checks both parent and
effective child policy. A child env override cannot weaken a blocked parent;
a blocked child cannot be launched by a Legacy parent. Existing prompt, usage
and helper gates remain in place. The helper retains its existing empty-string
failure result, while prompt and usage retain their existing error paths.
Model discovery remains available. Unset Legacy behavior and its dangerous
skip flag/extra-argument override semantics remain unchanged.

## Private child HOME configuration plan

After runtime prerequisites are verified, Core must explicitly select required
child isolation and provision the hook executable outside tool-writable paths.
The adapter would serialize `nativePermissionHookConfig(trustedExecutable)` to
`<private-child-HOME>/.gemini/config/hooks.json` before launching AGY. Its
generated shape is:

```json
{
  "agentdock-native-permission": {
    "enabled": true,
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "'/trusted/core-owned/native-permission-hook'",
        "timeout": 30
      }]
    }]
  }
}
```

The executable path is absolute, shell-quoted, with no payload/credential in
argv. This is a factory/fixture, not an executable installer or ownership
validator. Only a trusted Core-controlled executable may use it. Windows
quoting/configuration remains unimplemented. Use private 0700 directories and
exclusive/no-follow 0600 writes under trusted non-symlink parents; reject
preexisting/conflicting definitions rather than merging untrusted hooks. Keep
global permission grants, hooks, plugin loaders and sidecars out of this HOME.
Existing Broker bindings must remain independently isolated.

Do not add workspace hooks to this repository for the PoC: AGY could load them
in other sessions. `.agents/hooks.json` in every active workspace/additional
root, project state and plugin hooks may still load despite private HOME.
The precedence, disabling and replacement rules must be verified or such
sources excluded in a controlled runtime. Hash checks at launch alone do not
prevent same-uid writes or a change after launch. Native writes and shell code
must not be able to edit the hook executable/configuration/bridge credentials;
an independent OS containment boundary is required if that is in the threat
model. Hooks and HOME isolation are not an OS sandbox.

## Next Core-owned contract (required, not implemented)

1. Core provisions a private local bridge with authenticated owner capability,
   exact adapter incarnation/session/turn binding and supported protocol version.
   Hook stdin fields are observations only; they never choose authority, policy
   revision, endpoint, credential or adapter identity. A Unix-domain socket with
   private parent/peer ownership is a candidate; loopback HTTP alone is not
   authentication. No endpoint/API naming here asserts an existing Core API.
2. Core validates the live binding and revision for each request, maps exact
   native tool args to M8 domains/resources, and evaluates allow/ask/deny. It
   validates argument schemas, filesystem targets/symlink behavior, shell syntax,
   compound commands, network access and persistence. Unknown/unmappable tools
   deny. Prefix matching or a model's judgment is not an authorization decision.
3. Core owns approval creation, display, resolution and audit. Ask suspends the
   bridge only within the bounded deadline. Emit hook allow only after explicit
   Core resolution for that exact operation; rejection, timeout, cancellation,
   revoked capability, changed revision or lost owner returns deny. Do not
   convert ask into AGY ask or export persistent AGY allow rules.
4. Responses bind requestId, operationDigest and expiry, with authenticated
   transport and single-use consumption enforced by Core. Core rejects replay,
   duplicate/stale approvals and changed incarnation; echoing a digest alone
   proves none of those security properties. Revalidate immediately before
   consuming approval; path TOCTOU needs separate containment/resolution.
5. On cancellation/close/delete or bridge loss, revoke pending approvals,
   abort transport and fence further decisions for that turn. Preserve existing
   exact-child cancellation/lifecycle rules. Audit only sanitized IDs/domain,
   decision and fixed codes; protected Core storage may retain exact operation
   evidence under an explicit retention/access policy. Renderer projections
   must not expose paths, credentials, raw args, provider errors or stdout/stderr.
6. Core UI must distinguish native-unavailable, mock-only, Core denial,
   approval-pending and Broker approval coverage. Successful AGY exit/stream
   output is not proof of a tool's authorization or completion.

## Risk matrix and runtime enablement gates

### Required M8 API semantics

These are proposed bridge operations, not existing Next API names. Core must
provide evaluate(request, capability), resolve(approvalId, decision),
cancelTurn(binding), and capability revoke/expiry semantics. evaluate returns
the typed correlated response only after Core allow/deny resolution; an
unresolved ask may return pending/deny to this PoC. The eventual transport must
version and authenticate these operations, bound body sizes and deadlines,
reject redirects/endpoint substitution if HTTP is selected, and enforce
one-time approvals. Neither hook payload nor adapter flags may create grants.

### Rollback and acceptance

Rollback means keep or restore `AGY_ACP_AUTO_APPROVE=0`, revoke native bridge
capabilities and pending approvals, cancel only the exact owned adapter turn,
and remove only the owned private HOME/configuration after child cleanup.
Never unset the switch as rollback: unset restores Legacy skip-permissions.
Do not restart Stable/Next AgentDock or replace an installed ACP executable
to roll back this source-only PoC. No runtime configuration is changed here.

PoC acceptance is targeted/full Bun tests, typecheck and lint plus inspection
that the launch gate remains and only this worktree changes. Runtime acceptance
is separate and NOT achieved: pinned-CLI benign fixtures must prove universal
PreToolUse coverage, deny before any side effect, skip/multiple-hook precedence,
failure-closed engine behavior, protected configuration, real authenticated M8
ask/allow/deny, timeout/cancel/revoke/replay fencing and independent Legacy/Next
session isolation. A mock provider's allow test is not runtime acceptance.

| Risk | Current PoC control | Required before any runtime enablement |
| --- | --- | --- |
| Skip-permissions overrides hook deny | Flag omitted; every prompt remains gated | Verify precedence using benign read-only fixtures; never enable skip |
| Hook absent/crash/invalid stdout/timeout fails open | Mock failures deny; launch blocked | Prove AGY failure semantics for pinned 1.3.1; otherwise keep gate |
| Workspace/plugin/project hook conflicts or self-modification | No production hook written | Exclude/protect loaders and executable/config; verify every workspace root |
| Native workspace writes auto-allow | All mock file tools pass Core gate | Prove every native call invokes hook, including resume/subagents/background paths |
| Ask silently soft-denies with exit 0 | Pending ask maps to fixed deny | Core-owned approval transport and completion/audit evidence |
| Replay/owner mismatch/late allow | Nonce, binding digest, expiry, abort | Authenticated transport, Core single-use registry, live revision/owner fences |
| Shell substitution/network/path escape | No command is executed here | Core resource semantics plus independent OS containment where needed |
| Secrets/raw errors leak | Fixed codes only | Private bridge capability delivery, sanitized Core/renderer audit |
| Windows/platform drift | POSIX config fixture only | Per-platform compatibility/UAT and pinned CLI contract |
| Legacy regression | Existing Legacy tests pass | Keep opt-in explicit; do not mutate installed profiles/binaries |

No stream-json PoC files or Next code are modified. No live AGY native hook
execution, Core transport, authenticated UAT, build/install, release, push,
deployment or version bump is performed. Unit fixtures verify this evaluator,
not the upstream AGY execution engine. Until all gates above are evidenced,
`AGY_ACP_AUTO_APPROVE=0` continues refusing **all** prompts including usage and
noninteractive helpers before child launch and prompt temporary-file allocation.
