# Testing and release gate

## Automated suite (required)

From the repository root, after `bun install`:

### Static analysis

```sh
bun run check
```

Runs `tsc --noEmit` (type checking) and `biome check` + `stylua --check` (lint + format). This is the CI gate — must pass before merging.

### Bun (daemon + bootstrap)

```sh
bun test
```

This runs `bootstrap.test.ts` and all Vitest files under `apps/harnessd/` (protocol, store, providers, E2E).

The npm script `bun run test` is equivalent at time of writing (`package.json` chains the same steps).

### Plenary (Neovim plugin)

Requires **plenary.nvim** and **nui.nvim** on `runtimepath` (see `README.md`). Example:

```sh
nvim --headless -u tests/minimal_init.lua -c "PlenaryBustedDirectory tests/plenary { minimal_init = 'tests/minimal_init.lua' }" -c qall
```

Coverage includes client TCP/framing, commands and reconnect behavior, tree/transcript/prompt, approval keys, and diff accept/reject.

## What the automated suite proves

| Area | Tests |
| ---- | ----- |
| Framing + protocol | `apps/harnessd/test/protocol.test.ts` |
| SQLite | `apps/harnessd/test/store.test.ts` |
| Fake provider | `apps/harnessd/test/providers/fake.test.ts` |
| Codex adapter (mocked stdio) | `apps/harnessd/test/providers/codex.test.ts` |
| OpenCode adapter (mocked stdio) | `apps/harnessd/test/providers/opencode.test.ts` |
| Headless Neovim + fake provider E2E | `apps/harnessd/test/e2e/fake-provider-nvim.test.ts` |
| Persisted sessions + second nvim attach | `apps/harnessd/test/e2e/multi-client.test.ts` |
| Plugin UI + client | `tests/plenary/*.lua` |

## Manual smoke (pre-release)

Run in a real terminal with your normal auth for any provider you care about:

1. **Daemon auto-start** — `:HarnessOpen` with no prior `harnessd`; manifest appears under the configured state dir and the panel connects.  
2. **Codex** — create a session with `session.create` and `provider: "codex"` (e.g. small Lua using the same client as tests, or a temporary script), send a prompt, confirm transcript streaming; quit Neovim, restart, **`:HarnessResume`** the same session. The built-in `:HarnessNew` command is **fake-only**.  
3. **Approval flow** — trigger a tool that requests approval; exercise keys `1`–`4` and confirm `approval.resolve` completes.  
4. **Diff accept/reject** — `:HarnessDiffReview` when a diff is pending; **`F9`** / **`F10`** accept or reject.  
5. **Session list after restart** — `:HarnessOpen`; tree shows persisted sessions (SQLite).  
6. **OpenCode** — same as Codex: `session.create` with `provider: "opencode"`; treat behavior as **experimental** (ACP may change).  

Automated tests **do not** replace signing in to Codex/OpenCode in your environment or exercising the full interactive UX.

## Release gate (v1)

| Criterion | Bar |
| --------- | --- |
| Codex | Primary adapter; should be stable for real workflows before calling v1 done. Mocked daemon tests are necessary but not sufficient for “feels good in production.” |
| Fake-provider E2E | **Must be green** — `fake-provider-nvim.test.ts`. |
| Restore + multi-client attach | **Must be green** — `multi-client.test.ts`. |
| OpenCode | **Experimental** unless/until proven stable; v1 does **not** block on OpenCode if Codex and core flows are solid. Document and set expectations accordingly. |

Re-verify `bun run check`, `bun test`, and the Plenary command above before tagging a release.
