local M = {}

local MAX_FRAME_BYTES = 16 * 1024 * 1024

local Client = {}
Client.__index = Client

local function read_u32be(s)
  local b0, b1, b2, b3 = s:byte(1, 4)
  return ((b0 * 256 + b1) * 256 + b2) * 256 + b3
end

local function frame_encode(obj)
  local body = vim.json.encode(obj)
  if #body > MAX_FRAME_BYTES then
    error("frame too large: " .. #body .. " bytes")
  end
  local n = #body
  local head =
    string.char(math.floor(n / 16777216) % 256, math.floor(n / 65536) % 256, math.floor(n / 256) % 256, n % 256)
  return head .. body
end

function M.new(opts)
  return setmetatable({
    on_event = opts.on_event or function() end,
    on_close = opts.on_close or function() end,
    pending = {},
    _buf = "",
    id_seq = 0,
    tcp = nil,
  }, Client)
end

function Client:_fail_pending(message)
  local pending = self.pending
  self.pending = {}

  for id, cb in pairs(pending) do
    cb({
      replyTo = id,
      ok = false,
      error = {
        code = "CONNECTION_CLOSED",
        message = message,
      },
    })
  end
end

function Client:close(message)
  if self.tcp then
    self.tcp:read_stop()
    self.tcp:close()
    self.tcp = nil
  end
  self._buf = ""
  if message then
    self:_fail_pending(message)
    self.on_close(message)
  else
    self.pending = {}
  end
end

function Client:_dispatch(obj)
  if type(obj) ~= "table" then
    return
  end
  if obj.replyTo ~= nil then
    local cb = self.pending[obj.replyTo]
    if cb then
      cb(obj)
    end
    return
  end
  if obj.event ~= nil and obj.sessionId ~= nil then
    local ev = obj
    vim.schedule(function()
      self.on_event(ev)
    end)
  end
end

function Client:_feed(chunk)
  self._buf = self._buf .. chunk
  while true do
    if #self._buf < 4 then
      break
    end
    local n = read_u32be(self._buf:sub(1, 4))
    if n > MAX_FRAME_BYTES then
      error("frame too large: declared " .. n .. " bytes")
    end
    if #self._buf < 4 + n then
      break
    end
    local payload = self._buf:sub(5, 4 + n)
    self._buf = self._buf:sub(5 + n)
    local obj = vim.json.decode(payload)
    self:_dispatch(obj)
  end
end

function Client:tcp_connect(host, port)
  self:close()
  self._buf = ""
  local tcp = assert(vim.uv.new_tcp())
  local function close_raw()
    pcall(function()
      tcp:close()
    end)
  end
  local done = false
  local connect_err
  tcp:connect(host, port, function(err)
    connect_err = err
    done = true
  end)
  local w = vim.wait(10000, function()
    return done
  end)
  if not w or connect_err then
    close_raw()
  end
  assert(w, "tcp connect timeout")
  assert(not connect_err, tostring(connect_err))
  self.tcp = tcp
  tcp:read_start(function(err, chunk)
    if err then
      self:close(tostring(err))
      return
    end
    if chunk then
      self:_feed(chunk)
      return
    end
    self:close("socket closed")
  end)
end

function Client:_send(obj)
  local tcp = self.tcp
  assert(tcp, "not connected")
  local frame = frame_encode(obj)
  local wrote = false
  local werr
  tcp:write(frame, function(err)
    werr = err
    wrote = true
  end)
  local wr = vim.wait(5000, function()
    return wrote
  end)
  assert(wr, "tcp write timeout")
  assert(not werr, tostring(werr))
end

function Client:_next_id()
  self.id_seq = self.id_seq + 1
  return "c" .. tostring(self.id_seq)
end

function Client:request_async(method, params)
  local id = self:_next_id()
  local done = false
  local result = nil
  self.pending[id] = function(resp)
    result = resp
    done = true
    self.pending[id] = nil
  end
  self:_send({ id = id, method = method, params = params or {} })
  return {
    wait = function(_, timeout_ms)
      local t = timeout_ms or 30000
      local ok = vim.wait(t, function()
        return done
      end)
      assert(ok and done, "timeout waiting for " .. method)
      return result
    end,
  }
end

function Client:request(method, params)
  local fut = self:request_async(method, params)
  return fut.wait(fut)
end

function Client:hello(token)
  return self:request("daemon.hello", { token = token })
end

function Client:approval_resolve(approval_id, resolution)
  return self:request("approval.resolve", {
    approvalId = approval_id,
    resolution = resolution,
  })
end

function Client:diff_open(diff_id)
  return self:request("diff.open", { diffId = diff_id })
end

function Client:diff_apply(diff_id)
  return self:request("diff.apply", { diffId = diff_id })
end

function Client:diff_reject(diff_id)
  return self:request("diff.reject", { diffId = diff_id })
end

return M
