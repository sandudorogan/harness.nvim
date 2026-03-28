# nvim-harness

Neovim UI for agent sessions plus a persistent local daemon **`harnessd`** (Bun/TypeScript). The plugin talks to `harnessd` over a framed JSON protocol on localhost TCP; **it does not invoke provider CLIs directly** in v1. The daemon owns subprocesses, SQLite persistence, and normalized events for sessions, tools, approvals, and file-level diffs.

**v1 providers**

| Provider | Role |
| -------- | ---- |
| **Codex** (`codex app-server`) | Release-blocking — primary supported adapter |
| **Fake** (in-process) | Release-blocking for automated E2E and UI development without real CLIs |
| **OpenCode** (`opencode acp`) | **Experimental** — implemented in the daemon; ACP wire behavior may drift; not a v1 release gate |

See `docs/architecture.md` for boundaries, deferred features, and auth expectations. See `docs/testing.md` for commands and release-gate evidence.

## Repository layout

- `apps/harnessd/` — daemon source and Vitest suite  
- `lua/nvim-harness/`, `plugin/` — Neovim plugin  
- `tests/plenary/` — Plenary.nvim tests  
- `docs/` — architecture, protocol, testing  

## Prerequisites

- [Bun](https://bun.sh/) on `$PATH` — runs the daemon (TypeScript) directly, no build step
- Neovim 0.10+
- **Provider login:** authenticate `codex` and, if you use it, `opencode` in a normal terminal before first use inside Neovim. The daemon surfaces clear errors when the CLI is missing or not authenticated.

## Installation

### lazy.nvim

```lua
{
  "your-username/nvim-harness",
  dependencies = { "MunifTanjim/nui.nvim" },
  cmd = { "HarnessOpen", "HarnessNew", "HarnessResume", "HarnessAddFile", "HarnessDiffReview" },
  opts = {},
}
```

The daemon has no npm runtime dependencies — no build step is needed. To customize settings, pass them through `opts`:

```lua
opts = {
  bun = "/opt/homebrew/bin/bun",       -- path to bun binary (default: "bun")
  state_dir = "~/.local/share/nvim/nvim-harness", -- daemon state (default)
}
```

### lazy.nvim (local development)

```lua
{
  dir = "~/workdir/nvim-harness",
  dependencies = { "MunifTanjim/nui.nvim" },
  cmd = { "HarnessOpen", "HarnessNew", "HarnessResume", "HarnessAddFile", "HarnessDiffReview" },
  opts = {},
}
```

Run `bun install` from the repo root once — this installs dev tooling (typecheck, lint, test) but is not required for runtime.

### Built-in packages (`:help packages`)

Clone the plugin and its dependency into the pack directory:

```sh
git clone https://github.com/MunifTanjim/nui.nvim \
  ~/.local/share/nvim/site/pack/plugins/start/nui.nvim

git clone https://github.com/your-username/nvim-harness \
  ~/.local/share/nvim/site/pack/plugins/start/nvim-harness
```

The plugin auto-configures with defaults via `plugin/nvim-harness.lua`. To customize, add to your `init.lua`:

```lua
require("nvim-harness").setup({
  bun = "/opt/homebrew/bin/bun",
})
```

### Built-in packages (local development)

Symlink the repo into the pack directory:

```sh
ln -s ~/workdir/nvim-harness \
  ~/.local/share/nvim/site/pack/dev/start/nvim-harness
```

Run `bun install` from the repo root for dev tooling.

### Verify installation

```
:checkhealth nvim-harness
```

## Development

### Bootstrap

From the repository root:

```sh
bun install
bun run check
bun test
nvim --headless -u tests/minimal_init.lua +qall
```

`bun run check` runs type checking (`tsc --noEmit`) plus linting (Biome for TypeScript, StyLua for Lua). `bun test` runs the root bootstrap test and all `apps/harnessd` Vitest files. The Neovim line loads the plugin without errors.

### Plenary tests

Install [plenary.nvim](https://github.com/nvim-lua/plenary.nvim) and [nui.nvim](https://github.com/MunifTanjim/nui.nvim) under `.deps/plenary.nvim` and `.deps/nui.nvim`, or set `NVIM_HARNESS_PLENARY` and `NVIM_HARNESS_NUI` to each plugin’s root directory. `tests/minimal_init.lua` prepends those paths only when the directories exist. See `docs/testing.md`.

## Linting & formatting

| Tool | Scope | Config |
| ---- | ----- | ------ |
| [Biome](https://biomejs.dev/) | TypeScript lint + format | `biome.json` |
| [StyLua](https://github.com/JohnnyMorganz/StyLua) | Lua format | `stylua.toml` |
| `tsc --noEmit` | TypeScript type check | `tsconfig.json` |

```sh
bun run lint               # check without writing
bun run format             # auto-fix
bun run typecheck          # type check only
bun run check              # typecheck + lint (CI gate)
```

## Using the plugin

After installing (see above), the following commands are available:

- `:HarnessOpen` — open the panel; starts `harnessd` if no manifest is present  
- `:HarnessNew` — create a **fake** provider session (same workspace as `:pwd`) for local testing and Plenary-style flows  
- `:HarnessResume` — optional session id argument, or use the cursor line in the session tree  
- `:HarnessAddFile` — optional path; default is the current buffer  
- `:HarnessDiffReview` — open split diff for the latest pending `diff.ready` proposal  

**Codex and OpenCode** are implemented in `harnessd` (`session.create` with `provider: "codex"` or `"opencode"`). The stock commands above do not yet expose a provider picker; use the RPC from Lua/tests or a small helper script for those providers.

When an approval prompt is open, keys **`1`–`4`** map to allow once, allow always, reject once, reject always. When a diff review is open, **`F9`** / **`F10`** accept or reject the proposal; **`F11`** closes without applying (`lua/nvim-harness/ui/diff.lua`).

## Acknowledgements

This project borrows ideas and, where noted, code from:

- [t3code](https://github.com/nicholasgriffintn/t3code) — architecture patterns for runtime contracts, provider management, session/event persistence, and the Codex adapter. MIT-licensed; reused selectively per `PLAN.md`.
- [claudecode.nvim](https://github.com/greggh/claudecode.nvim) — model for the file-level diff review UX (simplicity over per-hunk complexity).
- [avante.nvim](https://github.com/yetone/avante.nvim) — referenced as a design counterpoint for diff granularity decisions.

Provider integrations wrap:

- [Codex](https://github.com/openai/codex) (`codex app-server` stdio)
- [OpenCode](https://github.com/opencode-ai/opencode) (`opencode acp` stdio, experimental)

Plugin dependencies:

- [nui.nvim](https://github.com/MunifTanjim/nui.nvim) — UI layout and popups
- [plenary.nvim](https://github.com/nvim-lua/plenary.nvim) — test runner (dev only)

## Docs

- `PLAN.md` — v1 plan and task order
- `docs/architecture.md` — daemon rationale, providers, deferred scope, adapters
- `docs/local-protocol.md` — wire format and envelopes
- `docs/testing.md` — automated commands, manual smoke checklist, release gate
