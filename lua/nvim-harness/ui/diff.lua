local M = {}
local state = require("nvim-harness.state")

local active = nil

local function split_proposed_lines(text)
  local lines = vim.split(text or "", "\n", { plain = true })
  if #lines > 0 and lines[#lines] == "" then
    table.remove(lines)
  end
  return lines
end

function M.close()
  if not active then
    return
  end
  local a = active
  active = nil

  local function diffoff_win(wid)
    if wid and vim.api.nvim_win_is_valid(wid) then
      vim.api.nvim_set_current_win(wid)
      if vim.api.nvim_get_option_value("diff", { win = wid }) then
        vim.cmd("diffoff")
      end
    end
  end

  diffoff_win(a.left_win)
  diffoff_win(a.right_win)

  if a.right_win and vim.api.nvim_win_is_valid(a.right_win) then
    pcall(vim.api.nvim_win_close, a.right_win, true)
  end

  if a.prev_win and vim.api.nvim_win_is_valid(a.prev_win) then
    vim.api.nvim_set_current_win(a.prev_win)
  end
end

function M.open_review(opts)
  opts = opts or {}
  M.close()

  local path = assert(opts.path, "path required")
  local proposed = opts.proposedContent or ""
  local diff_id = opts.diffId
  local client = opts.client

  local prev_win = vim.api.nvim_get_current_win()

  vim.cmd("edit " .. vim.fn.fnameescape(path))
  local left_win = vim.api.nvim_get_current_win()
  local left_buf = vim.api.nvim_win_get_buf(left_win)

  local prop_buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(prop_buf, 0, -1, false, split_proposed_lines(proposed))
  vim.api.nvim_set_option_value("buftype", "nofile", { buf = prop_buf })
  vim.api.nvim_set_option_value("bufhidden", "wipe", { buf = prop_buf })

  vim.cmd("rightbelow vsplit")
  local right_win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(right_win, prop_buf)

  vim.api.nvim_set_current_win(left_win)
  vim.cmd("diffthis")
  vim.api.nvim_set_current_win(right_win)
  vim.cmd("diffthis")

  local function map_b(buf, lhs, fn)
    vim.keymap.set("n", lhs, fn, { buffer = buf, silent = true, nowait = true })
  end

  local function resolve(client_method, failure_prefix)
    if not client or not diff_id then
      M.close()
      return true
    end
    local res = client_method(client, diff_id)
    if not res.ok then
      vim.notify("harness: " .. failure_prefix .. " failed: " .. vim.json.encode(res), vim.log.levels.WARN)
      return false
    end
    if state.pending_diff and state.pending_diff.diffId == diff_id then
      state.pending_diff = nil
    end
    M.close()
    return true
  end

  local function do_accept()
    resolve(client.diff_apply, "diff.apply")
  end

  local function do_reject()
    resolve(client.diff_reject, "diff.reject")
  end

  map_b(left_buf, "<F9>", do_accept)
  map_b(left_buf, "<F10>", do_reject)
  map_b(left_buf, "<F11>", M.close)
  map_b(prop_buf, "<F9>", do_accept)
  map_b(prop_buf, "<F10>", do_reject)
  map_b(prop_buf, "<F11>", M.close)

  active = {
    prev_win = prev_win,
    left_win = left_win,
    right_win = right_win,
    prop_buf = prop_buf,
    client = client,
    diffId = diff_id,
  }

  return {
    left_win = left_win,
    right_win = right_win,
  }
end

function M.accept_current_review()
  if not active or not active.client or not active.diffId then
    return
  end
  local res = active.client:diff_apply(active.diffId)
  if not res.ok then
    vim.notify("harness: diff.apply failed: " .. vim.json.encode(res), vim.log.levels.WARN)
    return
  end
  if state.pending_diff and state.pending_diff.diffId == active.diffId then
    state.pending_diff = nil
  end
  M.close()
end

function M.reject_current_review()
  if not active or not active.client or not active.diffId then
    return
  end
  local res = active.client:diff_reject(active.diffId)
  if not res.ok then
    vim.notify("harness: diff.reject failed: " .. vim.json.encode(res), vim.log.levels.WARN)
    return
  end
  if state.pending_diff and state.pending_diff.diffId == active.diffId then
    state.pending_diff = nil
  end
  M.close()
end

return M
