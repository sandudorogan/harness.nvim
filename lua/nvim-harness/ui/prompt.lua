local M = {}

local submit_handler = function() end

function M.set_submit_handler(fn)
  submit_handler = fn
end

function M.submit_current(bufnr)
  if not bufnr or bufnr == 0 or not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local text = vim.trim(table.concat(lines, "\n"))
  submit_handler(text)
end

return M
