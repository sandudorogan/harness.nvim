local M = {}

local function plugin_repo_root()
  local src = debug.getinfo(1, "S").source
  if src:sub(1, 1) == "@" then
    src = src:sub(2)
  end
  local path = vim.fn.fnamemodify(src, ":p")
  return vim.fn.fnamemodify(path, ":h:h:h")
end

M.defaults = {
  state_dir = vim.fn.stdpath("data") .. "/nvim-harness",
  repo_root = plugin_repo_root(),
  bun = "bun",
  harnessd_main = nil,
}

function M.setup(opts)
  M._opts = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts or {})
  if not M._opts.harnessd_main then
    M._opts.harnessd_main = M._opts.repo_root .. "/apps/harnessd/src/main.ts"
  end
end

function M.get()
  if not M._opts then
    M.setup({})
  end
  return M._opts
end

return M
