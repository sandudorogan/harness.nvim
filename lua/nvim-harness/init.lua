local M = {}

function M.setup(opts)
  require("nvim-harness.config").setup(opts or {})
  require("nvim-harness.ui.highlights").setup()
  require("nvim-harness.commands").setup()
end

return M
