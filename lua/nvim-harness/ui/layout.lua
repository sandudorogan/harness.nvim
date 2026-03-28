local Layout = require("nui.layout")
local Popup = require("nui.popup")
local state = require("nvim-harness.state")

local M = {}

local function status_winbar()
  local st = state.status or "idle"
  return "%#HarnessStatusMuted# harness %#HarnessStatusOk#" .. st
end

function M.open(opts)
  opts = opts or {}
  local tree_popup = Popup({
    enter = false,
    focusable = true,
    border = {
      style = "single",
      text = { top = " Sessions " },
    },
    buf_options = { modifiable = true, readonly = false },
  })

  local transcript_popup = Popup({
    enter = false,
    focusable = true,
    border = {
      style = "single",
      text = { top = " Transcript " },
    },
    buf_options = { modifiable = true, readonly = false },
  })

  local prompt_popup = Popup({
    enter = opts.enter == true,
    focusable = true,
    border = {
      style = "single",
      text = { top = " Prompt " },
    },
    buf_options = { modifiable = true, readonly = false },
  })

  local layout_box = Layout(
    {
      relative = "editor",
      position = {
        row = "60%",
        col = 0,
      },
      size = {
        width = "100%",
        height = "40%",
      },
    },
    Layout.Box({
      Layout.Box({
        Layout.Box(tree_popup, { size = "28%" }),
        Layout.Box({
          Layout.Box(transcript_popup, { size = "72%" }),
          Layout.Box(prompt_popup, { size = "28%" }),
        }, { dir = "col", size = "72%" }),
      }, { dir = "row", size = "100%" }),
    })
  )

  layout_box:mount()

  if tree_popup.winid and vim.api.nvim_win_is_valid(tree_popup.winid) then
    vim.api.nvim_set_option_value("winbar", status_winbar(), { win = tree_popup.winid })
  end

  local handle = {
    layout = layout_box,
    tree = tree_popup,
    transcript = transcript_popup,
    prompt = prompt_popup,
    tree_bufnr = tree_popup.bufnr,
    transcript_bufnr = transcript_popup.bufnr,
    prompt_bufnr = prompt_popup.bufnr,
  }

  function handle:unmount()
    self.layout:unmount()
  end

  function handle:update_status_winbar()
    if self.tree.winid and vim.api.nvim_win_is_valid(self.tree.winid) then
      vim.api.nvim_set_option_value("winbar", status_winbar(), { win = self.tree.winid })
    end
  end

  return handle
end

return M
