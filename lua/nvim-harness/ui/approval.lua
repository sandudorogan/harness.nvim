local M = {}

local handles = {}

local function remove_handle(entry)
  for i, e in ipairs(handles) do
    if e == entry then
      table.remove(handles, i)
      return
    end
  end
end

function M.close_all()
  local copy = {}
  for i = 1, #handles do
    copy[i] = handles[i]
  end
  handles = {}
  for _, entry in ipairs(copy) do
    pcall(function()
      if entry.win and vim.api.nvim_win_is_valid(entry.win) then
        vim.api.nvim_win_close(entry.win, true)
      end
    end)
    pcall(function()
      if entry.buf and vim.api.nvim_buf_is_valid(entry.buf) then
        vim.api.nvim_buf_delete(entry.buf, { force = true })
      end
    end)
  end
end

function M.open(opts)
  opts = opts or {}
  local approval_id = opts.approvalId or ""
  local tool = opts.tool or "unknown"
  local on_choice = opts.on_choice or function() end
  local client = opts.client
  local focus = opts.focus ~= false

  local lines = {
    "Approval required",
    "Tool: " .. tool,
    "Id: " .. approval_id,
    "",
    "[1] Allow once    [2] Allow always",
    "[3] Reject once   [4] Reject always",
  }

  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.api.nvim_set_option_value("buftype", "nofile", { buf = buf })
  vim.api.nvim_set_option_value("bufhidden", "wipe", { buf = buf })
  vim.api.nvim_set_option_value("modifiable", false, { buf = buf })

  local width = 56
  local height = math.min(#lines, vim.o.lines - 2)
  local row = math.max(0, math.floor((vim.o.lines - height) / 2))
  local col = math.max(0, math.floor((vim.o.columns - width) / 2))

  local win_cfg = {
    relative = "editor",
    width = width,
    height = height,
    row = row,
    col = col,
    style = "minimal",
    border = "single",
  }
  if vim.fn.has("nvim-0.9") == 1 then
    win_cfg.title = " Approval "
    win_cfg.title_pos = "center"
  end

  local win = vim.api.nvim_open_win(buf, focus, win_cfg)

  local entry = { buf = buf, win = win }
  table.insert(handles, entry)

  local function resolve(kind)
    if client then
      local res = client:approval_resolve(approval_id, { kind = kind })
      if not res.ok then
        vim.notify("harness: approval.resolve failed: " .. vim.json.encode(res), vim.log.levels.WARN)
        return
      end
    end
    on_choice(kind)
    pcall(function()
      if vim.api.nvim_win_is_valid(win) then
        vim.api.nvim_win_close(win, true)
      end
    end)
    pcall(function()
      if vim.api.nvim_buf_is_valid(buf) then
        vim.api.nvim_buf_delete(buf, { force = true })
      end
    end)
    remove_handle(entry)
  end

  for key, kind in pairs({
    ["1"] = "allow_once",
    ["2"] = "allow_always",
    ["3"] = "reject_once",
    ["4"] = "reject_always",
  }) do
    vim.keymap.set("n", key, function()
      resolve(kind)
    end, { buffer = buf, nowait = true })
  end

  return {
    bufnr = buf,
    winid = win,
    close = function()
      pcall(function()
        if vim.api.nvim_win_is_valid(win) then
          vim.api.nvim_win_close(win, true)
        end
      end)
      pcall(function()
        if vim.api.nvim_buf_is_valid(buf) then
          vim.api.nvim_buf_delete(buf, { force = true })
        end
      end)
      remove_handle(entry)
    end,
  }
end

return M
