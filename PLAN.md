# nvim-harness v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `nvim-harness` v1 as a Neovim UI client plus a persistent local daemon that manages native agent runtimes, with Codex as the release-blocking provider and OpenCode as the first non-blocking second adapter.

**Architecture:** A global `harnessd` process owns provider subprocesses, native session IDs, persistence, and event normalization. The Neovim plugin owns editor context capture, the session tree, transcript and prompt UI, approval prompts, and diff review. The plugin never speaks directly to provider CLIs in v1; it only talks to `harnessd` over a small local protocol.

**Tech Stack:** Neovim Lua, `nui.nvim`, Bun, TypeScript, SQLite, Vitest, Plenary.nvim, Codex app-server, OpenCode ACP.

---

## Product Definition

### v1 in scope

- Persistent `harnessd` daemon, auto-started by the Neovim plugin when needed
- Native Codex support via `codex app-server`
- Fake provider for UI and transport development
- OpenCode support via `opencode acp`, targeted for v1 but allowed to ship as experimental if adapter risk stays high
- Local RPC plus event stream between Neovim and `harnessd`
- Session tree grouped by provider and workspace
- Transcript view plus prompt input
- Inline tool approval flow
- File-level diff accept/reject flow
- Session restore across Neovim restarts
- Attach to existing daemon sessions from any Neovim instance

### v1 explicitly out of scope

- Claude native adapter
- Worktree orchestration
- Per-hunk diff apply
- Provider switching mid-session
- MCP management UI
- Supervisor/reviewer multi-agent workflows
- Web or desktop UI

### Why this cut is the right v1

- The daemon split is the real differentiator. That must work before adding more providers or orchestration.
- Codex has the strongest documented runtime surface for this idea.
- OpenCode is promising, but not worth blocking the entire release if ACP behavior is rough in practice.
- File-level diff review is good enough for v1 and much cheaper than per-hunk editing.
- Worktrees are a separate product and will drown the first release if included now.

## Architecture Decisions

### 1. Use a daemon, not a pure Lua plugin

`harnessd` owns:

- Provider subprocess lifecycle
- Native auth and session reuse
- SQLite persistence
- Local event fan-out
- Provider health and reconnect logic

The Neovim plugin owns:

- Editor actions and file context capture
- Tree and transcript UI
- Prompt entry
- Approval rendering
- Diff review and apply/reject commands

### 2. Use native provider protocols where they are already stable

- Codex: `codex app-server`
- OpenCode: `opencode acp`
- Claude: defer until after the daemon boundary is proven

ACP is not rejected on principle. The rule is simpler: use the best native surface each provider actually offers.

### 3. Normalize only the UI-critical event surface

The local protocol should normalize:

- Session lifecycle
- Text deltas
- Tool call lifecycle
- Approval requests
- File edit proposals
- Terminal and command output summaries
- Error and completion states

It should not try to flatten provider-native semantics into one fake universal schema. Provider-native payloads stay attached for debugging and future features.

### 4. Persist with SQLite from day one

Use SQLite, not ad hoc JSON files.

Reasons:

- Sessions must survive Neovim restarts
- Multiple Neovim instances should be able to attach safely
- Event history is useful for debugging and replay
- Diff proposals and approvals need durable linkage to sessions

### 5. Pick the simplest useful diff flow

v1 diff UX is file-level review:

- Open a proposed file revision in a split diff
- User accepts or rejects the file
- User can optionally edit the proposed buffer before accepting

This intentionally copies the simplicity of `claudecode.nvim`, not the per-hunk complexity of `avante.nvim`.

### 6. Copy architecture from `t3code`, not the whole product

Safe to reuse:

- Runtime contracts ideas
- Provider manager patterns
- Session and event persistence ideas
- Codex-facing adapter patterns if the code is a clean fit

Do not reuse for v1:

- React UI code
- WebSocket/browser transport assumptions
- Electron-specific structure
- Product-specific orchestration complexity

Because `t3code` is MIT-licensed, selective code reuse is allowed as long as the license notice is preserved in copied files.

### 7. Treat provider login as a preflight requirement

The daemon should not try to own first-run interactive login flows in v1.

Document and enforce:

- users authenticate `codex` and `opencode` in a real terminal before first use in Neovim
- daemon startup should detect obvious auth failures and surface actionable errors
- a later release can add helper commands for login, but v1 should not block on TTY forwarding or browser-flow management

## v1 User Experience

### Core workflow

1. User runs `:HarnessOpen`
2. Plugin starts or attaches to `harnessd`
3. Tree panel lists providers and known sessions
4. User creates or resumes a session
5. Prompt buffer sends input to the selected session
6. Transcript streams back text, tool activity, approvals, and edit proposals
7. If a tool approval is required, user chooses allow once, allow always, reject once, or reject always
8. If file edits are proposed, user opens a diff, then accepts or rejects per file

### First release commands

- `:HarnessOpen`
- `:HarnessClose`
- `:HarnessNew [provider]`
- `:HarnessResume`
- `:HarnessStop`
- `:HarnessDiffAccept`
- `:HarnessDiffReject`
- `:HarnessApprove`
- `:HarnessAddFile`

### First release keymaps

- `<CR>` in the tree opens a session
- `n` in the tree creates a new session
- `d` in the tree archives or deletes a session
- `q` closes the panel
- `1`, `2`, `3`, `4` respond to approvals

## Local Protocol

Use length-prefixed JSON frames over a localhost TCP socket with a random port and an auth token stored in the daemon state directory.

This is deliberately boring:

- easy to implement from Lua with `vim.uv`
- safe for multiline and large payloads like file proposals
- easy to inspect while debugging
- not tied to a browser or WebSocket client
- portable enough for later Windows support

Frame format:

- 4-byte big-endian unsigned length prefix
- UTF-8 JSON body immediately after the prefix
- reject frames larger than a documented sanity limit in the daemon and client

### Wire model

- Every client request is a framed JSON object with `id`, `method`, and `params`
- Every daemon response is a framed JSON object with `replyTo`, `ok`, and either `result` or `error`
- Every daemon event is a framed JSON object with `event`, `sessionId`, `timestamp`, and `payload`
- Requests and events share the same socket and may interleave
- Multiple in-flight requests are allowed
- Only one active prompt turn is allowed per session in v1
- `session.prompt` returns immediately after the daemon accepts the turn and allocates a turn ID; turn progress and completion are delivered only through events
- Provider-native event payloads are attached under `payload.provider`

### Initial command surface

- `daemon.hello`
- `session.list`
- `session.create`
- `session.resume`
- `session.stop`
- `session.archive`
- `session.prompt`
- `approval.resolve`
- `diff.open`
- `diff.apply`
- `diff.reject`
- `workspace.addFileContext`

### Initial event surface

- `session.created`
- `session.updated`
- `message.delta`
- `message.completed`
- `tool.started`
- `tool.completed`
- `approval.requested`
- `approval.resolved`
- `diff.ready`
- `diff.closed`
- `session.completed`
- `session.failed`

## Proposed Repository Layout

This repo is currently empty besides `PLAN.md`, so v1 should establish the structure below.

### Root

- Create: `README.md`
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `scripts/dev.lua`
- Create: `docs/architecture.md`

### Daemon

- Create: `apps/harnessd/package.json`
- Create: `apps/harnessd/src/main.ts`
- Create: `apps/harnessd/src/config.ts`
- Create: `apps/harnessd/src/server.ts`
- Create: `apps/harnessd/src/protocol/types.ts`
- Create: `apps/harnessd/src/protocol/encode.ts`
- Create: `apps/harnessd/src/store/db.ts`
- Create: `apps/harnessd/src/store/migrations.ts`
- Create: `apps/harnessd/src/store/sessions.ts`
- Create: `apps/harnessd/src/store/events.ts`
- Create: `apps/harnessd/src/providers/base.ts`
- Create: `apps/harnessd/src/providers/fake/adapter.ts`
- Create: `apps/harnessd/src/providers/codex/adapter.ts`
- Create: `apps/harnessd/src/providers/opencode/adapter.ts`
- Create: `apps/harnessd/src/diff/proposals.ts`
- Create: `apps/harnessd/src/approvals/state.ts`
- Create: `apps/harnessd/test/protocol.test.ts`
- Create: `apps/harnessd/test/store.test.ts`
- Create: `apps/harnessd/test/providers/fake.test.ts`
- Create: `apps/harnessd/test/providers/codex.test.ts`
- Create: `apps/harnessd/test/providers/opencode.test.ts`
- Create: `apps/harnessd/test/e2e/fake-provider-nvim.test.ts`
- Create: `apps/harnessd/test/e2e/multi-client.test.ts`

### Neovim plugin

- Create: `plugin/nvim-harness.lua`
- Create: `lua/nvim-harness/init.lua`
- Create: `lua/nvim-harness/config.lua`
- Create: `lua/nvim-harness/client.lua`
- Create: `lua/nvim-harness/state.lua`
- Create: `lua/nvim-harness/commands.lua`
- Create: `lua/nvim-harness/context.lua`
- Create: `lua/nvim-harness/ui/layout.lua`
- Create: `lua/nvim-harness/ui/tree.lua`
- Create: `lua/nvim-harness/ui/transcript.lua`
- Create: `lua/nvim-harness/ui/prompt.lua`
- Create: `lua/nvim-harness/ui/approval.lua`
- Create: `lua/nvim-harness/ui/diff.lua`
- Create: `lua/nvim-harness/ui/highlights.lua`
- Create: `tests/minimal_init.lua`
- Create: `tests/plenary/client_spec.lua`
- Create: `tests/plenary/tree_spec.lua`
- Create: `tests/plenary/transcript_spec.lua`
- Create: `tests/plenary/approval_spec.lua`
- Create: `tests/plenary/diff_spec.lua`

### Docs

- Create: `docs/local-protocol.md`
- Create: `docs/testing.md`

## Critical Non-Goals and Guardrails

- Do not speak directly from Lua to provider CLIs in v1
- Do not implement Claude before Codex is stable
- Do not build worktree support in parallel with the core daemon
- Do not design a universal provider abstraction that hides provider-native details
- Do not build a web UI as part of v1
- Do not block the entire release on OpenCode if Codex and the core daemon are already solid

## Testing Strategy

### Daemon tests

- Vitest unit tests for protocol framing, migrations, session persistence, and adapter state machines
- Fake provider tests to validate stream handling, approvals, and diff proposals without real CLIs
- Integration tests for Codex and OpenCode adapters behind feature flags or environment gates
- Scripted end-to-end tests for daemon plus Neovim using the fake provider

### Neovim tests

- Plenary tests for connection lifecycle
- Plenary tests for tree rendering and state updates
- Plenary tests for editor context capture
- Plenary tests for approval prompt rendering
- Plenary tests for diff window open, accept, and reject behavior

### Manual smoke tests

- Start daemon from a clean state directory
- Create a Codex session and stream a response
- Create an OpenCode session and stream a response if the adapter is enabled
- Trigger an approval flow
- Trigger a file edit proposal and accept it
- Restart Neovim and resume the same session

### Release gating

- Codex support is release-blocking for v1
- The fake provider is release-blocking for automated end-to-end coverage
- OpenCode may ship behind an experimental flag if real-world ACP behavior proves unstable during implementation

## Implementation Sequence

The implementation order matters:

1. Repo bootstrap and test harness
2. Local protocol and SQLite schema
3. Daemon skeleton plus fake provider
4. Neovim client transport plus basic panel
5. Codex adapter
6. Approval UI plus diff UI
7. Session restore and attach
8. OpenCode adapter
9. Final docs and release gating

Do not start with provider-specific polish. The fake provider must exist early so UI work can progress independently.

## Task 1: Bootstrap the Monorepo and Test Harness

**Files:**
- Create: `README.md`
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `apps/harnessd/package.json`
- Create: `tests/minimal_init.lua`
- Create: `docs/architecture.md`

- [ ] **Step 1: Initialize the root workspace**

Add Bun workspace configuration and top-level scripts for daemon tests and Neovim tests.

- [ ] **Step 2: Add daemon dependencies**

Use `bun add` for `better-sqlite3` or `sqlite`, `vitest`, and any minimal runtime deps. Keep the daemon dependency list tiny.

- [ ] **Step 3: Add Neovim test dependencies**

Document `nvim --headless` plus Plenary-based test execution. Use `nui.nvim` and `plenary.nvim` as the only mandatory plugin dependencies.

- [ ] **Step 4: Add the initial architecture stub**

Create `docs/architecture.md` with:
- the daemon/plugin boundary
- provider matrix
- the v1 release gate for Codex
- the OpenCode experimental caveat

- [ ] **Step 5: Verify the TypeScript and Lua test harness boots**

Run: `bun test`
Expected: test runner starts successfully, even if there are no tests yet

Run: `nvim --headless -u tests/minimal_init.lua +qall`
Expected: Neovim launches without plugin errors

- [ ] **Step 6: Initialize git if desired before implementation commits**

Run: `git init`
Expected: repository initialized locally

## Task 2: Define the Local Protocol and Persistence Schema

**Files:**
- Create: `apps/harnessd/src/protocol/types.ts`
- Create: `apps/harnessd/src/protocol/encode.ts`
- Create: `apps/harnessd/src/store/db.ts`
- Create: `apps/harnessd/src/store/migrations.ts`
- Create: `apps/harnessd/src/store/sessions.ts`
- Create: `apps/harnessd/src/store/events.ts`
- Create: `docs/local-protocol.md`
- Test: `apps/harnessd/test/protocol.test.ts`
- Test: `apps/harnessd/test/store.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Cover:
- frame encoding and decoding
- multiline payload safety
- unknown command rejection
- event persistence shape
- interleaved request and event handling

- [ ] **Step 2: Write failing store tests**

Cover database creation, session insertion, event append, approval storage, diff proposal storage, and session resume lookup.

- [ ] **Step 3: Implement protocol types**

Define request, response, and event envelopes with stable IDs and timestamps.

- [ ] **Step 4: Implement SQLite migrations and store layer**

Use tables for `sessions`, `events`, `approvals`, and `diff_proposals`.

- [ ] **Step 5: Document the protocol**

Write the exact JSON envelopes the Lua client will consume, including:
- 4-byte big-endian frame format
- max frame size
- interleaving rules
- `session.prompt` completion semantics

- [ ] **Step 6: Run tests**

Run: `bun test apps/harnessd/test/protocol.test.ts apps/harnessd/test/store.test.ts`
Expected: PASS

## Task 3: Implement the Daemon Skeleton and Fake Provider

**Files:**
- Create: `apps/harnessd/src/main.ts`
- Create: `apps/harnessd/src/config.ts`
- Create: `apps/harnessd/src/server.ts`
- Create: `apps/harnessd/src/providers/base.ts`
- Create: `apps/harnessd/src/providers/fake/adapter.ts`
- Test: `apps/harnessd/test/providers/fake.test.ts`
- Test: `apps/harnessd/test/e2e/fake-provider-nvim.test.ts`

- [ ] **Step 1: Write failing fake provider tests**

Cover session creation, streaming deltas, approval requests, and diff proposal events.

- [ ] **Step 2: Implement daemon startup and state directory handling**

The daemon should create a state directory, write a connection manifest with port and token, and start the TCP server.

- [ ] **Step 3: Implement the in-memory session registry**

Track connected UI clients separately from provider sessions.

- [ ] **Step 4: Implement the fake provider**

It should simulate:
- streaming assistant text
- a tool approval request
- a file edit proposal
- normal completion

- [ ] **Step 5: Add an end-to-end fake-provider test**

Launch `harnessd`, connect from headless Neovim, send a prompt, and assert transcript output lands where expected.

- [ ] **Step 6: Run daemon tests**

Run: `bun test apps/harnessd/test/providers/fake.test.ts apps/harnessd/test/e2e/fake-provider-nvim.test.ts`
Expected: PASS

## Task 4: Build the Neovim Client Transport and Base Layout

**Files:**
- Create: `plugin/nvim-harness.lua`
- Create: `lua/nvim-harness/init.lua`
- Create: `lua/nvim-harness/config.lua`
- Create: `lua/nvim-harness/client.lua`
- Create: `lua/nvim-harness/state.lua`
- Create: `lua/nvim-harness/commands.lua`
- Create: `lua/nvim-harness/context.lua`
- Create: `lua/nvim-harness/ui/layout.lua`
- Create: `lua/nvim-harness/ui/tree.lua`
- Create: `lua/nvim-harness/ui/transcript.lua`
- Create: `lua/nvim-harness/ui/prompt.lua`
- Create: `lua/nvim-harness/ui/highlights.lua`
- Test: `tests/plenary/client_spec.lua`
- Test: `tests/plenary/tree_spec.lua`
- Test: `tests/plenary/transcript_spec.lua`

- [ ] **Step 1: Write failing Lua client tests**

Cover daemon attach, reconnect, event dispatch, and command-response matching.

- [ ] **Step 2: Write failing UI tests**

Cover panel creation, tree refresh, transcript append, prompt submission, and context addition.

- [ ] **Step 3: Implement daemon discovery and connection**

The plugin should:
- read the daemon manifest
- start the daemon if missing
- connect using port plus token

- [ ] **Step 4: Implement the base layout**

Use `nui.nvim` to create:
- session tree pane
- transcript pane
- prompt pane

- [ ] **Step 5: Wire `:HarnessOpen`, `:HarnessNew`, and `:HarnessAddFile`**

Support the fake provider first.

- [ ] **Step 6: Implement editor context capture**

Use `context.lua` to send:
- current file path
- selected range when present
- explicit add-file actions

- [ ] **Step 7: Add highlight groups and basic status rendering**

Use `ui/highlights.lua` for tree state, approval state, and diff status colors.

- [ ] **Step 8: Run Lua tests**

Run: `nvim --headless -u tests/minimal_init.lua -c "PlenaryBustedDirectory tests/plenary { minimal_init = 'tests/minimal_init.lua' }" -c qall`
Expected: client and base UI tests pass

## Task 5: Implement the Codex Adapter

**Files:**
- Create: `apps/harnessd/src/providers/codex/adapter.ts`
- Test: `apps/harnessd/test/providers/codex.test.ts`
- Modify: `apps/harnessd/src/providers/base.ts`
- Modify: `apps/harnessd/src/server.ts`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Write failing Codex adapter tests**

Cover:
- `session.create`
- prompt submission
- streamed text deltas
- approval wait state
- session resume

- [ ] **Step 2: Implement Codex process lifecycle**

Use `codex app-server` over stdio with the documented initialize and thread lifecycle.

- [ ] **Step 3: Map Codex events to local protocol events**

Do not discard provider-native payloads.

- [ ] **Step 4: Implement resume and archive behavior**

Persist the Codex thread ID and provider metadata in SQLite.

- [ ] **Step 5: Add auth failure diagnostics**

If Codex is missing or unauthenticated, surface a clear error telling the user to authenticate in a real terminal first.

- [ ] **Step 6: Run Codex adapter tests**

Run: `bun test apps/harnessd/test/providers/codex.test.ts`
Expected: PASS for mocked tests

- [ ] **Step 7: Run a manual Codex smoke test**

Run: `codex --version`
Expected: Codex is installed

Then create a real session from Neovim and verify streaming text appears in the transcript.

## Task 6: Implement Approval UX and File-Level Diff Review

**Files:**
- Create: `lua/nvim-harness/ui/approval.lua`
- Create: `lua/nvim-harness/ui/diff.lua`
- Test: `tests/plenary/approval_spec.lua`
- Test: `tests/plenary/diff_spec.lua`
- Modify: `lua/nvim-harness/ui/transcript.lua`
- Modify: `lua/nvim-harness/client.lua`
- Modify: `lua/nvim-harness/commands.lua`
- Modify: `apps/harnessd/src/diff/proposals.ts`

- [ ] **Step 1: Write failing approval UI tests**

Cover rendering, focus behavior, and keys `1` through `4`.

- [ ] **Step 2: Write failing diff tests**

Cover opening a proposed file revision, accepting it, rejecting it, and closing the diff cleanly.

- [ ] **Step 3: Implement the approval widget**

Supported actions:
- allow once
- allow always
- reject once
- reject always

- [ ] **Step 4: Implement daemon-side diff proposal storage**

Each proposal should capture:
- session ID
- provider file path
- original content hash
- proposed content
- proposal state

- [ ] **Step 5: Implement Neovim split diff UI**

Open a proposed buffer against the current file and allow the user to accept or reject the proposal.

- [ ] **Step 6: Wire approval and diff actions back to the daemon**

Use `approval.resolve`, `diff.apply`, and `diff.reject`.

- [ ] **Step 7: Run Lua tests**

Run: `nvim --headless -u tests/minimal_init.lua -c "PlenaryBustedFile tests/plenary/approval_spec.lua { minimal_init = 'tests/minimal_init.lua' }" -c "PlenaryBustedFile tests/plenary/diff_spec.lua { minimal_init = 'tests/minimal_init.lua' }" -c qall`
Expected: PASS

## Task 7: Finish Session Restore and Multi-Client Attach

**Files:**
- Modify: `lua/nvim-harness/ui/tree.lua`
- Modify: `lua/nvim-harness/state.lua`
- Modify: `apps/harnessd/src/store/sessions.ts`
- Test: `apps/harnessd/test/e2e/multi-client.test.ts`

- [ ] **Step 1: Write failing restore tests**

Cover listing existing sessions, reopening a prior session, and attaching from a second Neovim instance.

- [ ] **Step 2: Implement restore and attach behavior**

The tree should show persisted sessions on startup even before one is resumed.

- [ ] **Step 3: Add a multi-client attach test**

Launch two separate `nvim --headless` processes against one daemon and verify the second client can attach to an existing session cleanly.

- [ ] **Step 4: Run restore and attach tests**

Run: `bun test apps/harnessd/test/e2e/multi-client.test.ts`
Expected: PASS

## Task 8: Implement the OpenCode Adapter

**Files:**
- Create: `apps/harnessd/src/providers/opencode/adapter.ts`
- Test: `apps/harnessd/test/providers/opencode.test.ts`
- Modify: `apps/harnessd/src/providers/base.ts`
- Modify: `apps/harnessd/src/server.ts`
- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Write failing OpenCode adapter tests**

Cover:
- ACP session creation
- prompt submission
- approval request mapping
- file proposal mapping
- session resume metadata

- [ ] **Step 2: Implement OpenCode ACP lifecycle**

Spawn `opencode acp` and manage the JSON-RPC session.

- [ ] **Step 3: Map ACP events to the local protocol**

Preserve the original ACP method names in provider metadata.

- [ ] **Step 4: Add auth failure diagnostics**

If OpenCode is missing or unauthenticated, surface a clear error telling the user to authenticate in a real terminal first.

- [ ] **Step 5: Run adapter tests**

Run: `bun test apps/harnessd/test/providers/opencode.test.ts`
Expected: PASS for mocked tests

- [ ] **Step 6: Run a manual OpenCode smoke test**

Run: `opencode --version`
Expected: OpenCode is installed

Then create a real session from Neovim and verify text, approvals, and file proposals appear.

- [ ] **Step 7: Decide whether OpenCode is release-blocking**

If adapter behavior is stable, keep it enabled by default.
If adapter behavior is unstable, ship it behind an experimental config flag and keep Codex as the only release gate.

## Task 9: Finalize Docs, Full Verification, and Release Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Create: `docs/testing.md`
- Modify: `docs/local-protocol.md`

- [ ] **Step 1: Document architecture and testing**

Explain:
- why the daemon exists
- why framed TCP was chosen
- which providers are supported in v1
- which features are explicitly deferred
- that provider login happens in a real terminal before first use

- [ ] **Step 2: Run the full automated suite**

Run: `bun test`
Expected: PASS

Run: `nvim --headless -u tests/minimal_init.lua -c "PlenaryBustedDirectory tests/plenary { minimal_init = 'tests/minimal_init.lua' }" -c qall`
Expected: PASS

- [ ] **Step 3: Run the final manual smoke test**

Verify:
- daemon auto-start
- Codex session create and resume
- approval flow
- diff accept/reject
- session list survives Neovim restart
- OpenCode works if enabled by default

- [ ] **Step 4: Freeze the release gate**

Release only if:
- Codex is stable
- fake-provider E2E is green
- restore and multi-client attach are green
- OpenCode is either stable or clearly marked experimental

## Open Questions Deferred Until After v1

- Claude adapter shape: SDK, `claude -p`, or reverse-engineered IDE protocol
- Worktree orchestration model
- Per-hunk diff flow
- Cross-provider session switching
- Rich MCP tooling UI

## Success Criteria

v1 is done when all of the following are true:

- A fresh user can install the plugin and daemon, authenticate the provider CLIs in a real terminal, and create a session from Neovim
- The daemon preserves native provider session IDs and restores them after Neovim restarts
- The UI can render streamed text, approvals, and file proposals without talking directly to provider CLIs
- Codex works end-to-end
- OpenCode either works end-to-end or is explicitly marked experimental in docs and config
- Diff accept/reject is reliable for file-level proposals
- Worktrees and Claude support are still not implemented
