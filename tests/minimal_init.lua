local this_file = debug.getinfo(1, "S").source:sub(2)
local repo_root = vim.fn.fnamemodify(this_file, ":p:h:h")

vim.opt.runtimepath:prepend(repo_root)

local plenary = os.getenv("NVIM_HARNESS_PLENARY") or (repo_root .. "/.deps/plenary.nvim")
local nui = os.getenv("NVIM_HARNESS_NUI") or (repo_root .. "/.deps/nui.nvim")

local function prepend_rtp(dir)
  if vim.fn.isdirectory(dir) == 1 then
    vim.opt.runtimepath:prepend(dir)
  end
end

prepend_rtp(plenary)
prepend_rtp(nui)
