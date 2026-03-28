local state = require("nvim-harness.state")
local layout = require("nvim-harness.ui.layout")
local tree = require("nvim-harness.ui.tree")

describe("nvim-harness tree UI", function()
  after_each(function()
    if state.layout_handle then
      state.layout_handle:unmount()
      state.layout_handle = nil
    end
    state.sessions = {}
  end)

  it("panel creation mounts layout with valid tree window", function()
    local L = layout.open({ enter = false })
    assert.is_not_nil(L)
    assert.is_number(L.tree.winid)
    assert.is_true(vim.api.nvim_win_is_valid(L.tree.winid))
    state.layout_handle = L
    L:unmount()
    state.layout_handle = nil
  end)

  it("tree refresh reflects session list", function()
    state.sessions = {
      { id = "s1", workspaceRoot = "/a", provider = "fake" },
      { id = "s2", workspaceRoot = "/b", provider = "fake" },
    }
    local L = layout.open({ enter = false })
    state.layout_handle = L
    tree.refresh(L.tree_bufnr)
    local lines = vim.api.nvim_buf_get_lines(L.tree_bufnr, 0, -1, false)
    local blob = table.concat(lines, "\n")
    assert.is_truthy(string.find(blob, "s1", 1, true))
    assert.is_truthy(string.find(blob, "s2", 1, true))
    L:unmount()
    state.layout_handle = nil
  end)
end)
