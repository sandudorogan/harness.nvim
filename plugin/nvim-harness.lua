if vim.g.loaded_nvim_harness == 1 then
  return
end
vim.g.loaded_nvim_harness = 1

require("nvim-harness").setup()
