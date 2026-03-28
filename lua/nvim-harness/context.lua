local state = require("nvim-harness.state")

local M = {}

function M.clear()
  state.pending_context = {}
end

function M.add_file(path)
  table.insert(state.pending_context, { kind = "file", path = path })
end

function M.get_chunks()
  return state.pending_context
end

function M.capture_editor()
  local p = vim.api.nvim_buf_get_name(0)
  if p == "" then
    return nil
  end
  return { path = vim.fn.fnamemodify(p, ":p") }
end

function M.selection_range()
  local s = vim.fn.getpos("'<")
  local e = vim.fn.getpos("'>")
  if not s or not e or s[2] == 0 or e[2] == 0 then
    return nil
  end
  local start_line, end_line = s[2], e[2]
  if start_line > end_line then
    start_line, end_line = end_line, start_line
  end
  local lines = vim.fn.getline(start_line, end_line)
  return { start_line = start_line, end_line = end_line, lines = lines }
end

function M.format_for_prompt(opts)
  opts = opts or {}
  local parts = {}
  for _, ch in ipairs(state.pending_context) do
    if ch.kind == "file" and ch.path then
      table.insert(parts, "File: " .. ch.path)
    end
  end
  local ed = M.capture_editor()
  if ed then
    table.insert(parts, "Current file: " .. ed.path)
  end
  local sel = opts.selection
  if sel and sel.lines and #sel.lines > 0 then
    table.insert(
      parts,
      string.format("Selection L%d-%d:\n%s", sel.start_line, sel.end_line, table.concat(sel.lines, "\n"))
    )
  end
  if #parts == 0 then
    return ""
  end
  return table.concat(parts, "\n\n") .. "\n\n"
end

return M
