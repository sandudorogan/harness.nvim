local M = {}

function M.check()
  vim.health.start("nvim-harness")

  local cfg = require("nvim-harness.config").get()

  if vim.fn.executable(cfg.bun) == 1 then
    local v = vim.fn.system({ cfg.bun, "--version" }):gsub("%s+$", "")
    vim.health.ok("bun found: " .. vim.fn.exepath(cfg.bun) .. " (" .. v .. ")")
  else
    vim.health.error("bun not found on PATH", {
      "Install bun: https://bun.sh/",
      'Or set { bun = "/path/to/bun" } in setup()',
    })
  end

  local nui_ok = pcall(require, "nui.popup")
  if nui_ok then
    vim.health.ok("nui.nvim available")
  else
    vim.health.error("nui.nvim not found", {
      "Install nui.nvim: https://github.com/MunifTanjim/nui.nvim",
    })
  end

  if vim.fn.filereadable(cfg.harnessd_main) == 1 then
    vim.health.ok("harnessd entry point: " .. cfg.harnessd_main)
  else
    vim.health.error("harnessd entry point not found: " .. cfg.harnessd_main, {
      "Ensure the full repository is installed, not just lua/ and plugin/",
    })
  end

  local manifest_path = cfg.state_dir .. "/manifest.json"
  if vim.fn.filereadable(manifest_path) == 1 then
    vim.health.ok("daemon manifest present: " .. manifest_path)
  else
    vim.health.info("no daemon manifest (daemon not running)")
  end
end

return M
