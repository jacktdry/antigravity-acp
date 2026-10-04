# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0-agentdock.3] - 2026-10-04

### Added
- **AgentDock Browser Broker support**: ACP `session/new`, `session/load`, and `session/resume` now retain the AgentDock-injected `agentdock-browser` MCP capability and pass it to AGY through a loopback-only stdio proxy.
- **Per-session AGY child sandbox**: AgentDock-launched AGY children use a private HOME/config that preserves required authentication and conversation state without inheriting the user's global browser MCP or plugins.

### Security
- **Browser backend ownership**: AgentDock child sessions reject missing or unsafe Browser Broker capabilities when `AGENTDOCK_BROWSER_BROKER_REQUIRED=1`; global `chrome-devtools` and `chrome-devtools-plugin` are not loaded in the child sandbox.
- **Capability isolation**: Browser Broker bearer tokens stay out of URLs and config files and are supplied to the proxy through the child environment only.
- **Standalone CLI preserved**: Direct `agy` usage continues to read the user's normal `~/.gemini` configuration and is not modified by the ACP sandbox.

### Fixed
- **Model discovery isolation**: Background `agy models` discovery now runs in a browser-free temporary HOME instead of inheriting the user's global MCP configuration.
- **Session cleanup**: Closing or deleting an ACP session removes only that session's temporary Browser Broker HOME while preserving shared authentication and conversation targets.

## [1.2.0] - 2026-09-27

### Added
- **Image Attachments in Prompts**: The ACP server now advertises the `image` prompt capability, so ACP clients (Zed, Paseo, etc.) allow attaching images to a prompt. Attached images are written to a private, per-user temp file and the model is pointed at it with its own `view_file` tool. (#24)
- **Sandbox Mode Config Option**: Added a new `sandbox` boolean session configuration option. When enabled, prompts run with agy's `--sandbox` flag (terminal restrictions enabled).
- **Legacy Session Mode & Model Support**: Restored compatibility with older ACP clients that call the pre-config-option `session/set_mode` and model-selection methods. (#14)

### Changed
- **Native Execution Modes**: Replaced the old prompt-injected "planning mode" text with agy's own `--mode` flag. Standard mode now maps to `--mode accept-edits`, and Plan Mode maps to `--mode plan`. `--dangerously-skip-permissions` is now passed for both. The "Skip Permissions" mode option was removed as redundant.
- **Bundled `agy` Version**: Updated the auto-installed `agy` CLI release from v1.0.13 to v1.2.12, including refreshed per-platform archive checksums.
- **`$AGY_EXTRA_ARGS` Precedence**: Extra CLI args from `$AGY_EXTRA_ARGS` are now appended last in the argument vector, so they can override any of the server's own flags (e.g. a custom `--print-timeout`).

### Fixed
- **Hung Long-Running Turns**: Disabled agy's built-in 5-minute print-mode timeout (`--print-timeout 0`) so long-running turns are no longer aborted mid-flight; turn cancellation is handled entirely by the ACP client via `session/cancel`. (#16)
- **Silent Quota-Limit Hangs**: The server now detects a `RESOURCE_EXHAUSTED` usage-limit error from agy, stops the hung subprocess, and surfaces a clear error with the reset time and Error ID — instead of leaving the client waiting for minutes with no feedback. Short, agy-retried per-minute rate limits are left alone. (#23)
- **Oversized Prompt Crashes**: Prompts larger than 64KB are now offloaded to a temporary file instead of being passed as a CLI argument, preventing `E2BIG: argument list too long` spawn failures on large attachments or pasted context. (#17)
- **Incomplete Tool Output Parsing**: Fixed decoding of `field 140` tool outputs and routing for step type `132`, so more tool calls render their output correctly in the client UI. (#15)
- **Tool Calls Left Open Mid-Turn**: Tool-call steps first observed while still running now correctly receive a terminal `tool_call_update` once agy reports completion or failure, instead of being left open indefinitely — fixing ACP clients that reject a turn ending with unfinished tool calls. (#19)

### Dependencies
- Bumped `actions/checkout` from v4 to v7 in CI workflows. (#1)

## [1.1.0] - 2026-08-19

### Added
- **Improved Non-Interactive Agent Usage**: Refactored the ACP (Agent Client Protocol) harness to better support running the agent smoothly in non-interactive environments, improving reliability for background and automated tasks. (#7)
- **Support for `/usage` Command**: The ACP server can now seamlessly handle the `/usage` slash command in non-interactive sessions by leveraging the `agy -p` (print) flag under the hood. (#10)
- **Automated Homebrew Releases**: Integrated a new step into the CI workflow to automatically publish releases to Homebrew, making installation much simpler for macOS users. (#12)

### Fixed
- **Model ID Parsing**: Fixed an issue where the model ID was not being identified correctly. It is now accurately extracted from the first column of the `agy models` CLI output. (#9)

## [1.0.0] - 2026-06-29

### Added
- **Initial Release of Antigravity ACP Server**: Google Antigravity's `agy` CLI does not natively support the Agent Client Protocol (ACP). This server solves that problem by bridging the two—allowing any ACP-compatible editor to seamlessly drive `agy`, stream its progress live, and replay conversation history.
- **Zero-Setup Installation**: Automatically downloads and provisions the correct `agy` CLI binary for your operating system on first launch—no manual setup required.
- **In-Editor Configuration**: Switch AI models or adjust permission modes dynamically directly from your editor's UI without restarting the server.
- **Persistent Session Management**: Conversations are saved automatically. You can list, resume, delete, and manage past sessions directly from your editor without losing history.
- **Multi-Workspace Support**: Work across multiple project directories simultaneously within a single session.
- **Transparent Execution UI**: Provides clear, readable titles and rich descriptions for all agent actions (such as reading files, searching, or running terminal commands) so you always understand what the agent is doing.
- **Single-File Executables**: Distributed as standalone, compiled binaries for macOS, Linux, and Windows. No need to install Bun, Node.js, or external dependencies to run the server.
