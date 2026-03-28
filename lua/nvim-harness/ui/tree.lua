local state = require("nvim-harness.state")

local M = {}

function M.session_id_from_line(line)
  local t = vim.trim(line or "")
  if t == "" or t:sub(1, 1) == "(" then
    return nil
  end
  return t:match("^(%S+)")
end

function M.refresh(bufnr)
  if not bufnr or bufnr == 0 or not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  local lines = {}
  for _, s in ipairs(state.sessions) do
    local label = s.id
    if s.workspaceRoot then
      label = label .. "  " .. s.workspaceRoot
    end
    table.insert(lines, label)
  end
  if #lines == 0 then
    lines = { "(no sessions)" }
  end
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
end

return M
