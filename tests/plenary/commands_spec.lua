local spec_dir = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h")
local du = dofile(spec_dir .. "/daemon_util.lua")
local commands = require("nvim-harness.commands")
local config = require("nvim-harness.config")
local prompt = require("nvim-harness.ui.prompt")
local state = require("nvim-harness.state")

describe("nvim-harness commands", function()
  local state_dir
  local stale_jid

  before_each(function()
    state_dir = vim.fn.stdpath("cache") .. "/nvim-harness-cmd-" .. tostring(vim.uv.hrtime())
    stale_jid = nil

    state.client = nil
    state.layout_handle = nil
    state.sessions = {}
    state.active_session_id = nil
    state.transcript_lines = {}
    state.pending_context = {}
    state.pending_diff = nil
    state.status = "disconnected"
    state.daemon_job = nil

    config.setup({
      state_dir = state_dir,
      repo_root = du.repo_root(),
      bun = "bun",
      harnessd_main = du.harnessd_main(),
    })
  end)

  after_each(function()
    require("nvim-harness.ui.approval").close_all()
    require("nvim-harness.ui.diff").close()
    if state.client then
      state.client:close()
      state.client = nil
    end
    if state.layout_handle then
      state.layout_handle:unmount()
      state.layout_handle = nil
    end
    du.stop_daemon(state.daemon_job)
    du.stop_daemon(stale_jid)
    if state_dir then
      vim.fn.delete(state_dir, "rf")
    end
  end)

  it("restarts the daemon when the manifest is stale", function()
    local stale_manifest
    stale_jid, stale_manifest = du.start_daemon(state_dir)
    du.stop_daemon(stale_jid)
    stale_jid = nil

    commands.harness_open()

    assert.equals("connected", state.status)
    assert.is_not_nil(state.client)
    assert.is_true(vim.fn.filereadable(state_dir .. "/manifest.json") == 1)

    local fresh_manifest = du.read_manifest(state_dir .. "/manifest.json")
    assert.not_equals(stale_manifest.token, fresh_manifest.token)
  end)

  it("marks the UI disconnected and prompt submit fails softly after transport closes", function()
    commands.harness_new()

    du.stop_daemon(state.daemon_job)
    state.daemon_job = nil

    local ok = vim.wait(5000, function()
      return state.status == "disconnected"
    end)
    assert.is_true(ok)

    local winbar = nil
    local winbar_ok = vim.wait(5000, function()
      winbar = vim.api.nvim_get_option_value("winbar", { win = state.layout_handle.tree.winid })
      return string.find(winbar, "disconnected", 1, true) ~= nil
    end)
    assert.is_true(winbar_ok)
    assert.is_truthy(string.find(winbar, "disconnected", 1, true))

    vim.api.nvim_buf_set_lines(state.layout_handle.prompt_bufnr, 0, -1, false, { "after drop" })
    local submitted_ok = pcall(function()
      prompt.submit_current(state.layout_handle.prompt_bufnr)
    end)
    assert.is_true(submitted_ok)

    local lines = vim.api.nvim_buf_get_lines(state.layout_handle.transcript_bufnr, 0, -1, false)
    assert.equals("", table.concat(lines, "\n"))
  end)

  it("marks status disconnected immediately when the client closes", function()
    commands.harness_new()

    state.client:close("test drop")

    assert.equals("disconnected", state.status)

    vim.api.nvim_buf_set_lines(state.layout_handle.prompt_bufnr, 0, -1, false, { "after local close" })
    local submitted_ok = pcall(function()
      prompt.submit_current(state.layout_handle.prompt_bufnr)
    end)
    assert.is_true(submitted_ok)

    local lines = vim.api.nvim_buf_get_lines(state.layout_handle.transcript_bufnr, 0, -1, false)
    assert.equals("", table.concat(lines, "\n"))
  end)

  it("clears stale connected state when open fails before reconnect", function()
    state.status = "connected"

    config.setup({
      state_dir = state_dir,
      repo_root = du.repo_root(),
      bun = "definitely-not-a-real-command",
      harnessd_main = du.harnessd_main(),
    })

    local ok = pcall(function()
      commands.harness_open()
    end)

    assert.is_false(ok)
    assert.equals("disconnected", state.status)
  end)

  it("closes the client transport when the first connect attempt fails", function()
    local close_count = 0
    state.client = {
      tcp = nil,
      tcp_connect = function(self)
        self.tcp = {}
      end,
      hello = function()
        error("hello failed")
      end,
      close = function(self)
        self.tcp = nil
        close_count = close_count + 1
      end,
    }

    local ok = pcall(function()
      commands.harness_open()
    end)

    assert.is_false(ok)
    assert.equals("disconnected", state.status)
    assert.is_nil(state.client.tcp)
    assert.equals(1, close_count)
  end)

  it("closes the client transport on stale-manifest retry failures", function()
    stale_jid = select(1, du.start_daemon(state_dir))
    du.stop_daemon(stale_jid)
    stale_jid = nil

    local close_count = 0
    state.client = {
      tcp = nil,
      tcp_connect = function(self)
        self.tcp = {}
      end,
      hello = function()
        error("hello failed")
      end,
      close = function(self)
        self.tcp = nil
        close_count = close_count + 1
      end,
    }

    local ok = pcall(function()
      commands.harness_open()
    end)

    assert.is_false(ok)
    assert.equals("disconnected", state.status)
    assert.is_nil(state.client.tcp)
    assert.equals(2, close_count)
  end)

  it("does not append a user transcript line when session.prompt fails", function()
    commands.harness_new()

    state.client.request = function(_, method)
      if method == "session.prompt" then
        return {
          ok = false,
          error = {
            code = "CONNECTION_CLOSED",
            message = "socket closed",
          },
        }
      end
      error("unexpected request")
    end

    vim.api.nvim_buf_set_lines(state.layout_handle.prompt_bufnr, 0, -1, false, { "will fail" })
    local submitted_ok = pcall(function()
      prompt.submit_current(state.layout_handle.prompt_bufnr)
    end)
    assert.is_true(submitted_ok)

    local lines = vim.api.nvim_buf_get_lines(state.layout_handle.transcript_bufnr, 0, -1, false)
    assert.equals("", table.concat(lines, "\n"))
  end)
end)
