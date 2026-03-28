local M = {}

function M.append_approval_banner(bufnr, payload)
  if type(payload) ~= "table" then
    return
  end
  local id = payload.approvalId or "?"
  local tool = payload.tool or "?"
  M.append_line(bufnr, string.format("[approval] id=%s tool=%s — keys [1-4] in approval dialog", id, tool))
end

function M.append_diff_ready(bufnr, payload)
  if type(payload) ~= "table" then
    return
  end
  local p = payload.path or "?"
  local id = payload.diffId or "?"
  M.append_line(bufnr, string.format("[diff] path=%s id=%s — :HarnessDiffReview", p, id))
end

function M.append_line(bufnr, text)
  if not bufnr or bufnr == 0 or not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  local ln = vim.api.nvim_buf_line_count(bufnr)
  local first = vim.api.nvim_buf_get_lines(bufnr, 0, 1, false)[1]
  if ln == 1 and (first == "" or first == nil) then
    vim.api.nvim_buf_set_lines(bufnr, 0, 1, false, { text })
    return
  end
  vim.api.nvim_buf_set_lines(bufnr, ln, ln, false, { text })
end

return M
