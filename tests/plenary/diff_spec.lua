local diff = require("nvim-harness.ui.diff")
local state = require("nvim-harness.state")

describe("nvim-harness diff review UI", function()
  local old_notify
  local notifications

  before_each(function()
    state.pending_diff = nil
    notifications = {}
    old_notify = vim.notify
    vim.notify = function(msg, level)
      table.insert(notifications, { msg = msg, level = level })
    end
  end)

  after_each(function()
    diff.close()
    state.pending_diff = nil
    vim.notify = old_notify
  end)

  it("opens proposed revision beside the current file in diff mode", function()
    local path = vim.fn.stdpath("cache") .. "/nvim-harness-diff-open-" .. tostring(vim.uv.hrtime()) .. ".txt"
    vim.fn.writefile({ "line_a", "line_b" }, path)

    local prev_wins = #vim.api.nvim_tabpage_list_wins(0)

    local h = diff.open_review({
      path = path,
      proposedContent = "line_a\nline_b_modified\n",
      diffId = "d-open",
      client = {
        diff_apply = function()
          return { ok = true }
        end,
        diff_reject = function()
          return { ok = true }
        end,
      },
    })

    assert.is_truthy(h.left_win and vim.api.nvim_win_is_valid(h.left_win))
    assert.is_truthy(h.right_win and vim.api.nvim_win_is_valid(h.right_win))
    assert.is_true(#vim.api.nvim_tabpage_list_wins(0) > prev_wins)

    local left_lines = vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(h.left_win), 0, -1, false)
    assert.equals("line_a", left_lines[1])
    assert.equals("line_b", left_lines[2])

    local right_lines = vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(h.right_win), 0, -1, false)
    assert.equals("line_a", right_lines[1])
    assert.equals("line_b_modified", right_lines[2])

    assert.is_truthy(vim.api.nvim_get_option_value("diff", { win = h.left_win }))
    assert.is_truthy(vim.api.nvim_get_option_value("diff", { win = h.right_win }))

    vim.fn.delete(path)
  end)

  it("accept sends diff.apply and closes review", function()
    local path = vim.fn.stdpath("cache") .. "/nvim-harness-diff-acc-" .. tostring(vim.uv.hrtime()) .. ".txt"
    vim.fn.writefile({ "old" }, path)
    local calls = {}
    local client = {
      diff_apply = function(_, diffId)
        table.insert(calls, { method = "diff.apply", params = { diffId = diffId } })
        return { ok = true }
      end,
      diff_reject = function()
        return { ok = true }
      end,
    }

    local prev_wins = #vim.api.nvim_tabpage_list_wins(0)
    diff.open_review({
      path = path,
      proposedContent = "new",
      diffId = "d-acc",
      client = client,
    })

    diff.accept_current_review()
    vim.wait(2000, function()
      return #calls >= 1
    end)

    assert.equals(1, #calls)
    assert.equals("diff.apply", calls[1].method)
    assert.same({ diffId = "d-acc" }, calls[1].params)
    assert.equals(prev_wins, #vim.api.nvim_tabpage_list_wins(0))

    vim.fn.delete(path)
  end)

  it("reject sends diff.reject and closes review", function()
    local path = vim.fn.stdpath("cache") .. "/nvim-harness-diff-rej-" .. tostring(vim.uv.hrtime()) .. ".txt"
    vim.fn.writefile({ "x" }, path)
    local calls = {}
    local client = {
      diff_apply = function()
        return { ok = true }
      end,
      diff_reject = function(_, diffId)
        table.insert(calls, { method = "diff.reject", params = { diffId = diffId } })
        return { ok = true }
      end,
    }

    local prev_wins = #vim.api.nvim_tabpage_list_wins(0)
    diff.open_review({
      path = path,
      proposedContent = "y",
      diffId = "d-rej",
      client = client,
    })

    diff.reject_current_review()
    vim.wait(2000, function()
      return #calls >= 1
    end)

    assert.equals(1, #calls)
    assert.equals("diff.reject", calls[1].method)
    assert.same({ diffId = "d-rej" }, calls[1].params)
    assert.equals(prev_wins, #vim.api.nvim_tabpage_list_wins(0))

    vim.fn.delete(path)
  end)

  it("keeps review open when diff.apply fails", function()
    local path = vim.fn.stdpath("cache") .. "/nvim-harness-diff-acc-fail-" .. tostring(vim.uv.hrtime()) .. ".txt"
    vim.fn.writefile({ "old" }, path)
    local h = diff.open_review({
      path = path,
      proposedContent = "new",
      diffId = "d-acc-fail",
      client = {
        diff_apply = function()
          return {
            ok = false,
            error = {
              code = "NOPE",
              message = "failed",
            },
          }
        end,
        diff_reject = function()
          return { ok = true }
        end,
      },
    })

    diff.accept_current_review()

    assert.equals(1, #notifications)
    assert.is_truthy(string.find(notifications[1].msg, "diff.apply failed", 1, true))
    assert.is_true(vim.api.nvim_win_is_valid(h.left_win))
    assert.is_true(vim.api.nvim_win_is_valid(h.right_win))

    vim.fn.delete(path)
  end)

  it("keeps review open when diff.reject fails", function()
    local path = vim.fn.stdpath("cache") .. "/nvim-harness-diff-rej-fail-" .. tostring(vim.uv.hrtime()) .. ".txt"
    vim.fn.writefile({ "old" }, path)
    local h = diff.open_review({
      path = path,
      proposedContent = "new",
      diffId = "d-rej-fail",
      client = {
        diff_apply = function()
          return { ok = true }
        end,
        diff_reject = function()
          return {
            ok = false,
            error = {
              code = "NOPE",
              message = "failed",
            },
          }
        end,
      },
    })

    diff.reject_current_review()

    assert.equals(1, #notifications)
    assert.is_truthy(string.find(notifications[1].msg, "diff.reject failed", 1, true))
    assert.is_true(vim.api.nvim_win_is_valid(h.left_win))
    assert.is_true(vim.api.nvim_win_is_valid(h.right_win))

    vim.fn.delete(path)
  end)

  it("close ends diff mode without apply or reject", function()
    local path = vim.fn.stdpath("cache") .. "/nvim-harness-diff-cls-" .. tostring(vim.uv.hrtime()) .. ".txt"
    vim.fn.writefile({ "a" }, path)
    local calls = {}
    local prev_wins = #vim.api.nvim_tabpage_list_wins(0)
    diff.open_review({
      path = path,
      proposedContent = "b",
      diffId = "d-close",
      client = {
        diff_apply = function()
          table.insert(calls, "diff.apply")
          return { ok = true }
        end,
        diff_reject = function()
          table.insert(calls, "diff.reject")
          return { ok = true }
        end,
      },
    })

    diff.close()
    assert.equals(prev_wins, #vim.api.nvim_tabpage_list_wins(0))
    assert.equals(0, #calls)

    vim.fn.delete(path)
  end)

  it("clears stale pending diff after successful apply", function()
    local path = vim.fn.stdpath("cache") .. "/nvim-harness-diff-clear-acc-" .. tostring(vim.uv.hrtime()) .. ".txt"
    vim.fn.writefile({ "old" }, path)
    state.pending_diff = {
      diffId = "d-clear-acc",
      path = path,
    }

    diff.open_review({
      path = path,
      proposedContent = "new",
      diffId = "d-clear-acc",
      client = {
        diff_apply = function()
          return { ok = true }
        end,
        diff_reject = function()
          return { ok = true }
        end,
      },
    })

    diff.accept_current_review()

    assert.is_nil(state.pending_diff)
    vim.fn.delete(path)
  end)

  it("clears stale pending diff after successful reject", function()
    local path = vim.fn.stdpath("cache") .. "/nvim-harness-diff-clear-rej-" .. tostring(vim.uv.hrtime()) .. ".txt"
    vim.fn.writefile({ "old" }, path)
    state.pending_diff = {
      diffId = "d-clear-rej",
      path = path,
    }

    diff.open_review({
      path = path,
      proposedContent = "new",
      diffId = "d-clear-rej",
      client = {
        diff_apply = function()
          return { ok = true }
        end,
        diff_reject = function()
          return { ok = true }
        end,
      },
    })

    diff.reject_current_review()

    assert.is_nil(state.pending_diff)
    vim.fn.delete(path)
  end)
end)
