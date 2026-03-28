local M = {}

function M.setup()
  vim.api.nvim_set_hl(0, "HarnessStatusOk", { link = "String", default = true })
  vim.api.nvim_set_hl(0, "HarnessStatusMuted", { link = "Comment", default = true })
  vim.api.nvim_set_hl(0, "HarnessTranscriptUser", { link = "Identifier", default = true })
  vim.api.nvim_set_hl(0, "HarnessTranscriptAssistant", { link = "Normal", default = true })
  vim.api.nvim_set_hl(0, "HarnessTreeSession", { link = "Special", default = true })
end

return M
