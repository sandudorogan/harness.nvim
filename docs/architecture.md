# Architecture

Neovim plugin + `harnessd` as described in `PLAN.md`. This document matches the **implemented** v1 stack, not the original bootstrap-only state.

## Why the daemon exists

A pure Lua plugin cannot reliably own what v1 needs in one process:

- **Provider subprocess lifecycle** — long-lived `codex app-server` / `opencode acp` stdio sessions, reconnect and error handling  
- **Native session IDs and metadata** — thread IDs, ACP session IDs, persisted beside harness session rows  
- **SQLite persistence** — sessions, events, approvals, diff proposals; survives Neovim exits  
- **Fan-out** — multiple Neovim instances attach to one daemon and receive the same event stream  
- **Health and diagnostics** — structured errors (e.g. CLI missing, auth required) without blocking the editor on model work  

The editor keeps **UI and context**: tree, transcript, prompt, approvals, diff review, file context capture. **All provider I/O goes through `harnessd`.**

## Why framed TCP (not raw stdio from Neovim)

The **Neovim ↔ daemon** link uses **length-prefixed JSON frames over a localhost TCP socket** (random port + token in the state directory). Rationale:

- Straightforward to implement from Lua with `vim.uv`  
- **Multiline and large payloads** (file proposals) are safe; no newline-framing ambiguity  
- Easy to inspect while debugging (replay, tcpdump on loopback)  
- Not tied to a browser, WebSocket client, or Neovim job stdio for RPC  
- Portable enough to extend later (e.g. other clients, stricter isolation)  

Provider adapters still use their own transports (**stdio** to `codex` / `opencode` subprocesses). Framing applies to the harness local protocol only. Details: `docs/local-protocol.md`.

## Daemon and plugin boundary

**`harnessd`** — provider subprocesses, native session IDs, SQLite, TCP server, event normalization, `session.prompt` turn acceptance (completion via events only).

**Neovim (Lua, `nui.nvim`)** — editor context, session tree, transcript and prompt, approval UI, diff review. **No direct CLI spawns for Codex/OpenCode in v1.**

## Provider matrix

| Provider | Transport / surface        | v1 role |
| -------- | -------------------------- | ------- |
| Codex    | `codex app-server`         | Release-blocking adapter |
| Fake     | in-daemon simulation       | Release-blocking for automated E2E and UI work |
| OpenCode | `opencode acp`             | **Experimental** — in tree, not a release gate |
| Claude   | —                          | **Deferred** — out of scope for v1 |

## Provider login (preflight)

**First-time authentication is not driven inside Neovim in v1.** Users run `codex` / `opencode` in a **real terminal**, complete sign-in (or their usual flow), then use `:HarnessOpen` and sessions in Neovim. The daemon returns errors such as `CODEX_AUTH_REQUIRED`, `OPENCODE_AUTH_REQUIRED`, or CLI-not-found codes with actionable text when prerequisites are missing.

## Features explicitly deferred (v1 out of scope)

- Claude native adapter  
- Worktree orchestration  
- Per-hunk diff apply (v1 is **file-level** accept/reject only)  
- Switching provider mid-session  
- MCP management UI  
- Supervisor/reviewer multi-agent workflows  
- Web or desktop UI outside Neovim  

## Codex adapter (`harnessd`)

The daemon runs **`codex app-server`** with stdio (newline-delimited JSON, JSON-RPC–style messages as documented for Codex app-server).

### Connection lifecycle (per harness session)

1. **Open stdio** to `codex app-server` (working directory is the session `workspaceRoot`).
2. **Initialize** (once per connection): client sends `initialize` with `clientInfo`; server responds; client sends `initialized` notification.
3. **Thread**
   - **New session** (`session.create` with `provider: "codex"`): `thread/start` with `cwd`, model (default `gpt-5.4` unless `metadata.model` is set), `sandboxPolicy` (`workspaceWrite` with `writableRoots` = workspace), and `serviceName: "nvim_harness"`. The returned Codex **`thread.id`** is stored in SQLite as `sessions.provider_session_id` and mirrored under `metadata.codex`.
   - **Resume** (`session.resume`): `thread/resume` with stored `threadId` and `cwd`.
4. **Prompt turn**: `turn/start` with harness-allocated `turnId` mapped only on the wire to Codex’s turn/item stream; streamed assistant text is emitted as `message.delta` events. Provider-native notifications are preserved under `payload.provider.codex`.
5. **Approvals**: inbound JSON-RPC **requests** from Codex whose `method` matches approval-like patterns (e.g. `approval`, `elicitation`, `permission`, `userInput`) are surfaced as `approval.requested` with the raw Codex JSON-RPC request attached under `payload.provider.codex` (for example `{ method, id, params }`). The daemon stores a row in `approvals` and waits until `approval.resolve`; the JSON-RPC response uses the client’s `resolution` payload (or a minimal default).
6. **Archive** (`session.archive`, Codex only when the session is **loaded** in the daemon): `thread/archive` on the same connection, then the stdio transport is closed. SQLite `sessions.state` is set to `archived`. If the session is not in memory, the daemon returns `SESSION_NOT_LOADED` so the client must `session.resume` first (keeps archive semantics aligned with an open app-server connection).

### Auth and CLI availability

If the CLI is missing or Codex returns auth-related RPC errors, `harnessd` responds with structured error codes such as **`CODEX_CLI_NOT_FOUND`** or **`CODEX_AUTH_REQUIRED`** and messages that tell the user to install Codex and authenticate in a normal terminal before retrying.

### Tests

Unit/integration tests inject an in-memory **line transport** via `startHarnessServer({ codexLineTransportFactory })` so Codex behavior is deterministic without a real subprocess.

## v1 release gate (Codex + core)

Shipping v1 requires:

- Codex path exercised for real usage (see `docs/testing.md` for automated vs manual evidence)  
- **Fake provider** E2E (headless Neovim + daemon) green  
- **Restore and multi-client attach** green  
- OpenCode either stable in practice **or** clearly **experimental** in docs and expectations (current stance: **experimental**, non-blocking)  

## OpenCode adapter (`harnessd`, experimental)

The daemon runs **`opencode acp`** with stdio (newline-delimited JSON, JSON-RPC 2.0–style messages).

### Connection lifecycle (per harness session)

1. **Open stdio** to `opencode acp` (working directory is the session `workspaceRoot`).
2. **Initialize** (once per connection): client sends `initialize` with `clientInfo`; server responds with a result object.
3. **Session**
   - **New session** (`session.create` with `provider: "opencode"`): `session/new` with `cwd` set to the workspace. The returned ACP session id is stored in SQLite as `sessions.provider_session_id` and mirrored under `metadata.opencode.sessionId`.
   - **Resume** (`session.resume`): `session/load` with stored session id and `cwd`. Metadata gains `resumedAt` on successful load.
4. **Prompt turn**: `session/prompt` with `sessionId` (ACP id), `text`, and `cwd`. Streamed assistant text is emitted as `message.delta` when `session/update` notifications carry `update.sessionUpdate === "assistant_delta"` and a `delta` string. Completion is signaled by `session/update` with `sessionUpdate === "completed"` (emits `message.completed`).
5. **Approvals**: inbound JSON-RPC **requests** with method **`session/request_permission`** are surfaced as `approval.requested`. The raw ACP request (including `method`, `id`, `params`) is attached under `payload.provider.opencode`. ACP `params.options` entries carry `optionId`, `name`, and `kind`; replies select one of those concrete options using `{ outcome: { outcome: "selected", optionId: "..." } }` or return `{ outcome: { outcome: "cancelled" } }` when the harness resolution cannot be mapped to a provided ACP option.
6. **File proposals**: `session/update` with `sessionUpdate` `tool_call` or `tool_call_update` may include `content` entries `{ type: "diff", path, oldText, newText }`. Each diff is stored as a pending diff proposal and a `diff.ready` event is emitted. Native ACP context is preserved under `proposal.provider.opencode` and event `payload.provider.opencode` (ACP method name **`session/update`** is always present in those payloads for debugging).

### Auth and CLI availability

If the CLI is missing or OpenCode returns auth-related RPC errors, `harnessd` responds with **`OPENCODE_CLI_NOT_FOUND`**, **`OPENCODE_AUTH_REQUIRED`**, or **`OPENCODE_SETUP_FAILED`** and messages that tell the user to install OpenCode and authenticate in a normal terminal before retrying.

### Tests

Unit/integration tests inject an in-memory **line transport** via `startHarnessServer({ opencodeLineTransportFactory })` so ACP behavior is deterministic without a real subprocess.

## OpenCode experimental caveat

OpenCode over ACP is implemented in the daemon but treated as **non-release-blocking** for v1: real ACP shapes may drift as OpenCode evolves. Prefer Codex for “it must work” workflows until OpenCode has more mileage. The product does not block the entire v1 on OpenCode when Codex and core daemon UX are already solid.
