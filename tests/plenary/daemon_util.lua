local M = {}

function M.repo_root()
  local this_file = debug.getinfo(1, "S").source:sub(2)
  return vim.fn.fnamemodify(this_file, ":p:h:h:h")
end

function M.harnessd_main()
  return M.repo_root() .. "/apps/harnessd/src/main.ts"
end

function M.wait_manifest(manifest_path, timeout_ms)
  local ok = vim.wait(timeout_ms or 15000, function()
    return vim.fn.filereadable(manifest_path) == 1
  end)
  assert(ok, "timeout waiting for manifest at " .. manifest_path)
end

function M.read_manifest(manifest_path)
  local lines = vim.fn.readfile(manifest_path)
  local text = table.concat(lines, "\n")
  return vim.json.decode(vim.trim(text))
end

function M.start_daemon(state_dir)
  vim.fn.mkdir(state_dir, "p")
  local jid = vim.fn.jobstart({
    "bun",
    M.harnessd_main(),
    "--state-dir",
    state_dir,
  }, {
    cwd = M.repo_root(),
  })
  assert(jid > 0, "failed to start harnessd job")
  local manifest_path = state_dir .. "/manifest.json"
  M.wait_manifest(manifest_path)
  local manifest = M.read_manifest(manifest_path)
  return jid, manifest, manifest_path
end

function M.stop_daemon(jid)
  if jid and jid > 0 then
    vim.fn.jobstop(jid)
    vim.fn.jobwait({ jid }, 5000)
  end
end

return M
