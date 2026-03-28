# nvim-harness

Neovim UI for agent sessions + persistent local daemon (`harnessd`). The plugin talks to `harnessd` over length-prefixed JSON on localhost TCP. The daemon owns provider subprocesses, SQLite, and event normalization. The plugin owns editor context, UI, approvals, and diff review.

## Stack

| Layer | Tech |
|-------|------|
| Daemon | TypeScript, Bun, SQLite (Bun:sqlite) |
| Plugin | Lua, nui.nvim, vim.uv |
| Protocol | 4-byte length-prefixed JSON over localhost TCP |
| Tests | Vitest (daemon), Plenary.nvim (plugin) |
| Package manager | Bun (monorepo with workspaces) |

No compilation step. Bun runs TypeScript directly.

## Layout

- `apps/harnessd/` -- daemon source + Vitest tests
- `lua/nvim-harness/` -- Neovim plugin (Lua)
- `plugin/` -- auto-load entry point
- `tests/plenary/` -- Plenary.nvim tests
- `docs/` -- architecture, protocol, testing

## Commands

```sh
bun install                # install deps
bun test                   # daemon + bootstrap tests
bun run test:daemon        # daemon tests only
bun run test:nvim          # headless plugin load check
bun run typecheck          # tsc --noEmit
bun run lint               # biome check + stylua --check
bun run format             # biome format --write + stylua
bun run check              # typecheck + lint (CI gate)
```

Plenary tests (need .deps/plenary.nvim and .deps/nui.nvim):
```sh
nvim --headless -u tests/minimal_init.lua \
  -c "PlenaryBustedDirectory tests/plenary { minimal_init = 'tests/minimal_init.lua' }" \
  -c qall
```

## Linting & formatting

- **TypeScript**: [Biome](https://biomejs.dev/) -- config in `biome.json`
- **Lua**: [StyLua](https://github.com/JohnnyMorganz/StyLua) -- config in `stylua.toml`
- **Type checking**: `tsc --noEmit` via root `tsconfig.json`

Run `bun run format` to auto-fix. Run `bun run check` to validate without writing.

## Conventions

- camelCase in JSON wire protocol, snake_case in SQLite columns, PascalCase for classes
- Provider adapters implement `ProviderAdapter` interface (`onPromptTurn`, `notifyApprovalResolved`)
- Tests inject in-memory line transports -- no real subprocesses in CI
- Structured error codes (e.g. `CODEX_AUTH_REQUIRED`, `SESSION_NOT_LOADED`)
- Errors use codes + messages, not thrown exceptions at protocol boundaries

## Providers (v1)

- **Codex** (`codex app-server` stdio) -- release-blocking
- **Fake** (in-process) -- release-blocking for E2E
- **OpenCode** (`opencode acp` stdio) -- experimental, non-blocking

## Key docs

- `PLAN.md` -- v1 plan and task breakdown
- `docs/architecture.md` -- daemon/plugin boundary, provider details
- `docs/local-protocol.md` -- wire format, methods, envelopes
- `docs/testing.md` -- test commands, manual smoke, release gate
