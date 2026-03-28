local manifest_path = assert(os.getenv("HARNESS_MANIFEST"), "HARNESS_MANIFEST")
local done_path = assert(os.getenv("HARNESS_DONE_FILE"), "HARNESS_DONE_FILE")
local stop_path = assert(os.getenv("HARNESS_STOP_FILE"), "HARNESS_STOP_FILE")

local mf = assert(io.open(manifest_path, "r"))
local manifest = vim.json.decode(mf:read("*a"))
mf:close()

local function u32be(n)
  assert(n >= 0 and n <= 4294967295, "frame length out of range")
  return string.char(
    math.floor(n / 16777216) % 256,
    math.floor(n / 65536) % 256,
    math.floor(n / 256) % 256,
    n % 256
  )
end

local function read_u32be(s)
  local b0, b1, b2, b3 = s:byte(1, 4)
  return ((b0 * 256 + b1) * 256 + b2) * 256 + b3
end

local function frame_encode(obj)
  local body = vim.json.encode(obj)
  return u32be(#body) .. body
end

local inbox = {}

local function push_inbox(obj)
  table.insert(inbox, obj)
end

local tcp = assert(vim.uv.new_tcp())
local connect_wait = true
local connect_err

tcp:connect("127.0.0.1", manifest.port, function(err)
  connect_err = err
  connect_wait = false
end)

local connected = vim.wait(30000, function()
  return not connect_wait
end)
assert(connected, "tcp connect timeout")
assert(not connect_err, tostring(connect_err))

local buf = ""

tcp:read_start(function(err, chunk)
  assert(not err, err)
  if not chunk then
    return
  end
  buf = buf .. chunk
  while true do
    if #buf < 4 then
      break
    end
    local n = read_u32be(buf:sub(1, 4))
    if #buf < 4 + n then
      break
    end
    local payload = buf:sub(5, 4 + n)
    buf = buf:sub(5 + n)
    push_inbox(vim.json.decode(payload))
  end
end)

local function next_msg(timeout_ms)
  vim.wait(timeout_ms or 30000, function()
    return #inbox > 0
  end)
  assert(#inbox > 0, "timeout waiting for message")
  return table.remove(inbox, 1)
end

local function send_obj(obj)
  local done = false
  local werr
  tcp:write(frame_encode(obj), function(err)
    werr = err
    done = true
  end)
  local wr = vim.wait(5000, function()
    return done
  end)
  assert(wr, "tcp write timeout")
  assert(not werr, tostring(werr))
end

local function expect_reply(id)
  while true do
    local m = next_msg()
    if type(m.replyTo) == "string" and m.replyTo == id then
      return m
    end
  end
end

send_obj({ id = "h1", method = "daemon.hello", params = { token = manifest.token } })
local h1 = expect_reply("h1")
assert(h1.ok, vim.json.encode(h1))

send_obj({
  id = "c1",
  method = "session.create",
  params = { workspaceRoot = "/tmp/harness_mc_two", provider = "fake", metadata = {} },
})
local c1 = expect_reply("c1")
assert(c1.ok, vim.json.encode(c1))

local done_f = assert(io.open(done_path, "w"))
done_f:write("ready")
done_f:close()

vim.wait(120000, function()
  return vim.fn.filereadable(stop_path) == 1
end)

tcp:read_stop()
tcp:close()

vim.cmd("qa!")
