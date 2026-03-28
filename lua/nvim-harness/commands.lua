local client_mod = require("nvim-harness.client")
local config = require("nvim-harness.config")
local context = require("nvim-harness.context")
local prompt = require("nvim-harness.ui.prompt")
local state = require("nvim-harness.state")
local transcript = require("nvim-harness.ui.transcript")
local tree = require("nvim-harness.ui.tree")
local layout = require("nvim-harness.ui.layout")
local approval_ui = require("nvim-harness.ui.approval")
local diff_ui = require("nvim-harness.ui.diff")

local M = {}

local function session_exists(id)
  for _, s in ipairs(state.sessions) do
    if s.id == id then
      return true
    end
  end
  return false
end

function M.on_daemon_event(ev)
  if ev.event == "session.created" then
    if not session_exists(ev.sessionId) then
      table.insert(state.sessions, {
        id = ev.sessionId,
        workspaceRoot = ev.payload and ev.payload.workspaceRoot,
        provider = ev.payload and ev.payload.provider,
      })
    end
    state.active_session_id = ev.sessionId
    if state.layout_handle then
      vim.schedule(function()
        tree.refresh(state.layout_handle.tree_bufnr)
        state.layout_handle:update_status_winbar()
      end)
    end
    return
  end

  if ev.event == "approval.requested" then
    vim.schedule(function()
      local handle = state.layout_handle
      if handle then
        transcript.append_approval_banner(handle.transcript_bufnr, ev.payload or {})
      end
      approval_ui.open({
        approvalId = ev.payload and ev.payload.approvalId,
        tool = ev.payload and ev.payload.tool,
        client = state.client,
        focus = true,
        on_choice = function() end,
      })
    end)
    return
  end

  if ev.event == "diff.ready" then
    state.pending_diff = {
      sessionId = ev.sessionId,
      diffId = ev.payload and ev.payload.diffId,
      path = ev.payload and ev.payload.path,
    }
    if state.layout_handle then
      vim.schedule(function()
        transcript.append_diff_ready(state.layout_handle.transcript_bufnr, ev.payload or {})
      end)
    end
    return
  end

  if ev.event == "message.delta" then
    local t = ev.payload and ev.payload.text
    if type(t) == "string" and state.layout_handle then
      vim.schedule(function()
        transcript.append_line(state.layout_handle.transcript_bufnr, t)
      end)
    end
    return
  end

  if ev.event == "message.completed" or ev.event == "session.failed" then
    if state.layout_handle then
      vim.schedule(function()
        state.layout_handle:update_status_winbar()
      end)
    end
  end
end

local function set_disconnected()
  state.status = "disconnected"
  local handle = state.layout_handle
  if handle then
    vim.schedule(function()
      if handle.tree and handle.tree.winid and vim.api.nvim_win_is_valid(handle.tree.winid) then
        handle:update_status_winbar()
      end
    end)
  end
end

local function on_transport_closed()
  set_disconnected()
end

local function sync_sessions_from_daemon()
  if not state.client or state.status ~= "connected" then
    return
  end
  local res = state.client:request("session.list", {})
  if not res.ok then
    vim.notify("harness: session.list failed: " .. vim.json.encode(res), vim.log.levels.WARN)
    return
  end
  local result = res.result
  if type(result) ~= "table" or type(result.sessions) ~= "table" then
    return
  end
  state.sessions = {}
  for _, row in ipairs(result.sessions) do
    table.insert(state.sessions, {
      id = row.id,
      workspaceRoot = row.workspaceRoot,
      provider = row.provider,
      state = row.state,
    })
  end
end

local function ensure_manifest_and_connect()
  local cfg = config.get()
  vim.fn.mkdir(cfg.state_dir, "p")
  local manifest_path = cfg.state_dir .. "/manifest.json"

  local function start_daemon()
    local jid = vim.fn.jobstart({
      cfg.bun,
      cfg.harnessd_main,
      "--state-dir",
      cfg.state_dir,
    }, {
      cwd = cfg.repo_root,
    })
    assert(jid > 0, "failed to start harnessd")
    state.daemon_job = jid
    local ok = vim.wait(20000, function()
      return vim.fn.filereadable(manifest_path) == 1
    end)
    assert(ok, "timeout waiting for harnessd manifest")
  end

  local function read_manifest()
    local raw = table.concat(vim.fn.readfile(manifest_path), "\n")
    return vim.json.decode(vim.trim(raw))
  end

  set_disconnected()

  local had_manifest = vim.fn.filereadable(manifest_path) == 1
  if not had_manifest then
    start_daemon()
  end

  local function connect()
    local manifest = read_manifest()

    if not state.client then
      state.client = client_mod.new({
        on_event = M.on_daemon_event,
        on_close = on_transport_closed,
      })
    end

    local ok, err = pcall(function()
      state.client:tcp_connect("127.0.0.1", manifest.port)
      local hello = state.client:hello(manifest.token)
      assert(hello.ok, vim.json.encode(hello))
    end)
    if not ok then
      state.client:close()
      error(err)
    end

    state.status = "connected"
    sync_sessions_from_daemon()
    if state.layout_handle then
      vim.schedule(function()
        tree.refresh(state.layout_handle.tree_bufnr)
        state.layout_handle:update_status_winbar()
      end)
    end
  end

  local ok, err = pcall(connect)
  if ok then
    return
  end

  if had_manifest then
    vim.fn.delete(manifest_path)
    start_daemon()
    connect()
    return
  end

  set_disconnected()
  error(err)
end

local function layout_mounted()
  return state.layout_handle
    and state.layout_handle.layout
    and state.layout_handle.layout.winid
    and vim.api.nvim_win_is_valid(state.layout_handle.layout.winid)
end

local function wire_prompt()
  prompt.set_submit_handler(function(text)
    if text == "" then
      return
    end
    if not state.client or state.status ~= "connected" or not state.active_session_id then
      vim.notify("harness: no active session", vim.log.levels.WARN)
      return
    end
    local prefix = context.format_for_prompt()
    context.clear()
    local full = prefix ~= "" and (prefix .. text) or text
    local res = state.client:request("session.prompt", {
      sessionId = state.active_session_id,
      text = full,
    })
    if not res.ok then
      vim.notify("harness: session.prompt failed: " .. vim.json.encode(res), vim.log.levels.WARN)
      return
    end
    if state.layout_handle then
      transcript.append_line(state.layout_handle.transcript_bufnr, "[user] " .. text)
    end
  end)
end

function M.harness_open()
  ensure_manifest_and_connect()
  if not layout_mounted() then
    state.layout_handle = layout.open({ enter = false })
    wire_prompt()
  end
  tree.refresh(state.layout_handle.tree_bufnr)
  state.layout_handle:update_status_winbar()
end

function M.harness_resume(opt_session_id)
  M.harness_open()
  local sid = opt_session_id
  if not sid or sid == "" then
    local tbuf = state.layout_handle.tree_bufnr
    local win = vim.fn.bufwinid(tbuf)
    if win == -1 then
      vim.notify("harness: open the harness panel and focus the session tree", vim.log.levels.WARN)
      return
    end
    local row = vim.api.nvim_win_get_cursor(win)[1]
    local line = vim.api.nvim_buf_get_lines(tbuf, row - 1, row, false)[1]
    sid = tree.session_id_from_line(line)
  end
  if not sid then
    vim.notify("harness: could not read session id from tree line", vim.log.levels.WARN)
    return
  end
  if not state.client or state.status ~= "connected" then
    return
  end
  local res = state.client:request("session.resume", { sessionId = sid })
  if not res.ok then
    vim.notify("harness: session.resume failed: " .. vim.json.encode(res), vim.log.levels.ERROR)
    return
  end
  state.active_session_id = sid
  tree.refresh(state.layout_handle.tree_bufnr)
  state.layout_handle:update_status_winbar()
end

function M.harness_new()
  M.harness_open()
  local root = vim.fn.getcwd()
  local res = state.client:request("session.create", {
    workspaceRoot = root,
    provider = "fake",
    metadata = {},
  })
  if not res.ok then
    vim.notify("harness: session.create failed: " .. vim.json.encode(res), vim.log.levels.ERROR)
    return
  end
  local sid = res.result.sessionId
  if not session_exists(sid) then
    table.insert(state.sessions, {
      id = sid,
      workspaceRoot = root,
      provider = "fake",
    })
  end
  state.active_session_id = sid
  tree.refresh(state.layout_handle.tree_bufnr)
  state.layout_handle:update_status_winbar()
end

function M.harness_diff_review()
  local d = state.pending_diff
  if not d or not d.diffId then
    vim.notify("harness: no pending diff", vim.log.levels.WARN)
    return
  end
  if not state.client or state.status ~= "connected" then
    vim.notify("harness: not connected", vim.log.levels.WARN)
    return
  end
  local res = state.client:diff_open(d.diffId)
  if not res.ok then
    vim.notify("harness: diff.open failed: " .. vim.json.encode(res), vim.log.levels.WARN)
    return
  end
  local r = res.result
  local full = vim.fs.joinpath(r.workspaceRoot, r.path)
  diff_ui.open_review({
    path = full,
    proposedContent = r.proposedContent,
    diffId = d.diffId,
    client = state.client,
  })
end

function M.harness_add_file(args)
  local path = args
  if path == nil or path == "" then
    local cur = vim.api.nvim_buf_get_name(0)
    if cur ~= "" then
      path = vim.fn.fnamemodify(cur, ":p")
    end
  end
  if path and path ~= "" then
    context.add_file(path)
    vim.notify("harness: added file context " .. path, vim.log.levels.INFO)
  else
    vim.notify("harness: no file to add", vim.log.levels.WARN)
  end
end

function M.setup()
  vim.api.nvim_create_user_command("HarnessOpen", function()
    M.harness_open()
  end, { desc = "Open harness panel and connect to harnessd" })

  vim.api.nvim_create_user_command("HarnessNew", function()
    M.harness_new()
  end, { desc = "Create a new fake-provider session" })

  vim.api.nvim_create_user_command("HarnessResume", function(o)
    local a = vim.trim(o.args or "")
    M.harness_resume(a ~= "" and a or nil)
  end, {
    nargs = "?",
    desc = "Resume a persisted session (optional session id; default: tree line)",
  })

  vim.api.nvim_create_user_command("HarnessAddFile", function(o)
    M.harness_add_file(o.args)
  end, {
    nargs = "?",
    desc = "Add explicit file path to next prompt context (default: current buffer)",
  })

  vim.api.nvim_create_user_command("HarnessDiffReview", function()
    M.harness_diff_review()
  end, { desc = "Open split diff review for the latest pending diff proposal" })
end

return M
