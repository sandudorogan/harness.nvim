local spec_dir = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h")
local du = dofile(spec_dir .. "/daemon_util.lua")
local client_mod = require("nvim-harness.client")

local function start_drop_server()
  local server = assert(vim.uv.new_tcp())
  assert(server:bind("127.0.0.1", 0) == 0)

  local clients = {}
  assert(server:listen(128, function(err)
    assert(not err, err)
    local sock = assert(vim.uv.new_tcp())
    table.insert(clients, sock)
    assert(server:accept(sock) == 0)
    sock:read_start(function(read_err, chunk)
      assert(not read_err, read_err)
      if chunk then
        sock:read_stop()
        sock:close()
      end
    end)
  end) == 0)

  local addr = server:getsockname()

  return {
    port = addr.port,
    close = function()
      for _, sock in ipairs(clients) do
        if not sock:is_closing() then
          sock:close()
        end
      end
      if not server:is_closing() then
        server:close()
      end
    end,
  }
end

describe("nvim-harness client", function()
  local state_dir
  local jid

  before_each(function()
    state_dir = vim.fn.stdpath("cache") .. "/nvim-harness-test-" .. tostring(vim.uv.hrtime())
    jid = nil
  end)

  after_each(function()
    du.stop_daemon(jid)
    if state_dir then
      vim.fn.delete(state_dir, "rf")
    end
  end)

  it("attaches to daemon (manifest, hello, ready)", function()
    local manifest
    jid, manifest = du.start_daemon(state_dir)
    local c = client_mod.new({ on_event = function() end })
    c:tcp_connect("127.0.0.1", manifest.port)
    local res = c:hello(manifest.token)
    assert.is_true(res.ok)
    assert.is_true(res.result.ok)
    c:close()
  end)

  it("reconnects after disconnect", function()
    local manifest
    jid, manifest = du.start_daemon(state_dir)
    local c = client_mod.new({ on_event = function() end })
    c:tcp_connect("127.0.0.1", manifest.port)
    assert.is_true(c:hello(manifest.token).ok)
    c:close()
    c:tcp_connect("127.0.0.1", manifest.port)
    local res = c:hello(manifest.token)
    assert.is_true(res.ok)
    c:close()
  end)

  it("dispatches daemon events to handler", function()
    local manifest
    jid, manifest = du.start_daemon(state_dir)
    local events = {}
    local c = client_mod.new({
      on_event = function(ev)
        table.insert(events, ev)
      end,
    })
    c:tcp_connect("127.0.0.1", manifest.port)
    assert.is_true(c:hello(manifest.token).ok)

    local workspace = "/tmp/nvim-harness-plenary-ws"
    c:request("session.create", {
      workspaceRoot = workspace,
      provider = "fake",
      metadata = {},
    })

    vim.wait(5000, function()
      for _, ev in ipairs(events) do
        if ev.event == "session.created" then
          return true
        end
      end
    end)

    local created = nil
    for _, ev in ipairs(events) do
      if ev.event == "session.created" then
        created = ev
        break
      end
    end
    assert.is_not_nil(created)
    assert.equals(workspace, created.payload.workspaceRoot)
    c:close()
  end)

  it("matches responses to requests by id when interleaved", function()
    local manifest
    jid, manifest = du.start_daemon(state_dir)
    local c = client_mod.new({ on_event = function() end })
    c:tcp_connect("127.0.0.1", manifest.port)
    assert.is_true(c:hello(manifest.token).ok)

    local workspace = "/tmp/nvim-harness-plenary-ws2"
    local r_slow = c:request_async("session.create", {
      workspaceRoot = workspace,
      provider = "fake",
      metadata = {},
    })
    local r_fast = c:request_async("session.create", {
      workspaceRoot = workspace,
      provider = "fake",
      metadata = {},
    })

    local out_fast = r_fast:wait(8000)
    local out_slow = r_slow:wait(8000)

    assert.is_true(out_fast.ok)
    assert.is_true(out_slow.ok)
    assert.is_string(out_fast.result.sessionId)
    assert.is_string(out_slow.result.sessionId)
    assert.not_equals(out_fast.result.sessionId, out_slow.result.sessionId)
    c:close()
  end)

  it("fails pending requests when the socket drops", function()
    local server = start_drop_server()
    local c = client_mod.new({ on_event = function() end })

    c:tcp_connect("127.0.0.1", server.port)

    local fut = c:request_async("session.create", {
      workspaceRoot = "/tmp/nvim-harness-plenary-ws3",
      provider = "fake",
      metadata = {},
    })
    local res = fut:wait(2000)

    assert.is_false(res.ok)
    assert.equals("CONNECTION_CLOSED", res.error.code)

    c:close()
    server:close()
  end)

  it("invokes on_close when the socket drops", function()
    local server = start_drop_server()
    local reason = nil
    local c = client_mod.new({
      on_event = function() end,
      on_close = function(msg)
        reason = msg
      end,
    })

    c:tcp_connect("127.0.0.1", server.port)
    c:request_async("session.create", {
      workspaceRoot = "/tmp/nvim-harness-plenary-ws4",
      provider = "fake",
      metadata = {},
    })

    local ok = vim.wait(2000, function()
      return reason ~= nil
    end)
    assert.is_true(ok)
    assert.is_truthy(string.find(reason, "closed", 1, true))

    c:close()
    server:close()
  end)

  it("closes the raw tcp handle on connect error", function()
    local old_new_tcp = vim.uv.new_tcp
    local fake = {
      closed = false,
      connect = function(_, _, _, cb)
        cb("ECONNREFUSED")
      end,
      close = function(self)
        self.closed = true
      end,
    }

    vim.uv.new_tcp = function()
      return fake
    end

    local ok = pcall(function()
      local c = client_mod.new({ on_event = function() end })
      c:tcp_connect("127.0.0.1", 1)
    end)

    vim.uv.new_tcp = old_new_tcp

    assert.is_false(ok)
    assert.is_true(fake.closed)
  end)

  it("closes the raw tcp handle on connect timeout", function()
    local old_new_tcp = vim.uv.new_tcp
    local old_wait = vim.wait
    local fake = {
      closed = false,
      connect = function() end,
      close = function(self)
        self.closed = true
      end,
    }

    vim.uv.new_tcp = function()
      return fake
    end
    vim.wait = function()
      return false
    end

    local ok = pcall(function()
      local c = client_mod.new({ on_event = function() end })
      c:tcp_connect("127.0.0.1", 1)
    end)

    vim.uv.new_tcp = old_new_tcp
    vim.wait = old_wait

    assert.is_false(ok)
    assert.is_true(fake.closed)
  end)
end)
