local approval = require("nvim-harness.ui.approval")

describe("nvim-harness approval UI", function()
  local old_notify
  local notifications

  before_each(function()
    notifications = {}
    old_notify = vim.notify
    vim.notify = function(msg, level)
      table.insert(notifications, { msg = msg, level = level })
    end
  end)

  after_each(function()
    approval.close_all()
    vim.notify = old_notify
  end)

  it("renders tool name and key hints 1 through 4", function()
    local h = approval.open({
      approvalId = "ap-test-1",
      tool = "demo_tool",
      focus = true,
      on_choice = function() end,
    })
    assert.is_not_nil(h.bufnr)
    local lines = vim.api.nvim_buf_get_lines(h.bufnr, 0, -1, false)
    local blob = table.concat(lines, "\n")
    assert.truthy(string.find(blob, "demo_tool", 1, true))
    assert.truthy(string.find(blob, "[1]", 1, true))
    assert.truthy(string.find(blob, "[2]", 1, true))
    assert.truthy(string.find(blob, "[3]", 1, true))
    assert.truthy(string.find(blob, "[4]", 1, true))
    assert.truthy(string.find(blob, "Allow once", 1, true))
    assert.truthy(string.find(blob, "Allow always", 1, true))
    assert.truthy(string.find(blob, "Reject once", 1, true))
    assert.truthy(string.find(blob, "Reject always", 1, true))
    h:close()
  end)

  it("focuses the approval window when focus is true", function()
    local h = approval.open({
      approvalId = "ap-focus",
      tool = "t",
      focus = true,
      on_choice = function() end,
    })
    assert.is_truthy(h.winid and vim.api.nvim_win_is_valid(h.winid))
    assert.equals(h.winid, vim.api.nvim_get_current_win())
    h:close()
  end)

  it("key 1 resolves allow once", function()
    local chosen = nil
    local h = approval.open({
      approvalId = "ap-k1",
      tool = "t",
      focus = true,
      on_choice = function(kind)
        chosen = kind
      end,
    })
    vim.api.nvim_set_current_win(h.winid)
    vim.api.nvim_feedkeys("1", "mtx", false)
    vim.wait(1000, function()
      return chosen ~= nil
    end)
    assert.equals("allow_once", chosen)
    assert.is_falsy(h.winid and vim.api.nvim_win_is_valid(h.winid))
  end)

  it("key 2 resolves allow always", function()
    local chosen = nil
    local h = approval.open({
      approvalId = "ap-k2",
      tool = "t",
      focus = true,
      on_choice = function(kind)
        chosen = kind
      end,
    })
    vim.api.nvim_set_current_win(h.winid)
    vim.api.nvim_feedkeys("2", "mtx", false)
    vim.wait(1000, function()
      return chosen ~= nil
    end)
    assert.equals("allow_always", chosen)
  end)

  it("key 3 resolves reject once", function()
    local chosen = nil
    local h = approval.open({
      approvalId = "ap-k3",
      tool = "t",
      focus = true,
      on_choice = function(kind)
        chosen = kind
      end,
    })
    vim.api.nvim_set_current_win(h.winid)
    vim.api.nvim_feedkeys("3", "mtx", false)
    vim.wait(1000, function()
      return chosen ~= nil
    end)
    assert.equals("reject_once", chosen)
  end)

  it("key 4 resolves reject always", function()
    local chosen = nil
    local h = approval.open({
      approvalId = "ap-k4",
      tool = "t",
      focus = true,
      on_choice = function(kind)
        chosen = kind
      end,
    })
    vim.api.nvim_set_current_win(h.winid)
    vim.api.nvim_feedkeys("4", "mtx", false)
    vim.wait(1000, function()
      return chosen ~= nil
    end)
    assert.equals("reject_always", chosen)
  end)

  it("keeps the approval UI open when approval.resolve fails", function()
    local chosen = nil
    local h = approval.open({
      approvalId = "ap-fail",
      tool = "t",
      focus = true,
      client = {
        approval_resolve = function()
          return {
            ok = false,
            error = {
              code = "NOPE",
              message = "failed",
            },
          }
        end,
      },
      on_choice = function(kind)
        chosen = kind
      end,
    })

    vim.api.nvim_set_current_win(h.winid)
    vim.api.nvim_feedkeys("1", "mtx", false)
    vim.wait(100, function()
      return #notifications > 0
    end)

    assert.is_nil(chosen)
    assert.equals(1, #notifications)
    assert.is_truthy(string.find(notifications[1].msg, "approval.resolve failed", 1, true))
    assert.is_true(vim.api.nvim_win_is_valid(h.winid))
  end)
end)
