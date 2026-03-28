local state = require("nvim-harness.state")
local layout = require("nvim-harness.ui.layout")
local transcript = require("nvim-harness.ui.transcript")
local prompt = require("nvim-harness.ui.prompt")
local context = require("nvim-harness.context")

describe("nvim-harness transcript and prompt UI", function()
  after_each(function()
    if state.layout_handle then
      state.layout_handle:unmount()
      state.layout_handle = nil
    end
    state.transcript_lines = {}
    state.pending_context = {}
  end)

  it("transcript append adds visible lines", function()
    local L = layout.open({ enter = false })
    state.layout_handle = L
    transcript.append_line(L.transcript_bufnr, "[user] hi")
    transcript.append_line(L.transcript_bufnr, "[assistant] hello")
    local lines = vim.api.nvim_buf_get_lines(L.transcript_bufnr, 0, -1, false)
    assert.equals("[user] hi", lines[1])
    assert.equals("[assistant] hello", lines[2])
    L:unmount()
    state.layout_handle = nil
  end)

  it("prompt submission invokes callback with buffer text", function()
    local submitted = nil
    local L = layout.open({ enter = false })
    state.layout_handle = L
    prompt.set_submit_handler(function(text)
      submitted = text
    end)
    vim.api.nvim_buf_set_lines(L.prompt_bufnr, 0, -1, false, { "typed prompt" })
    prompt.submit_current(L.prompt_bufnr)
    assert.equals("typed prompt", submitted)
    L:unmount()
    state.layout_handle = nil
  end)

  it("context addition records explicit file path", function()
    context.clear()
    context.add_file("/tmp/explicit-file.lua")
    local chunks = context.get_chunks()
    assert.equals(1, #chunks)
    assert.equals("/tmp/explicit-file.lua", chunks[1].path)
  end)

  it("only includes selection when explicitly passed to prompt formatting", function()
    local prev_buf = vim.api.nvim_get_current_buf()
    local path = vim.fn.stdpath("cache") .. "/context-selection-" .. tostring(vim.uv.hrtime()) .. ".lua"

    vim.fn.writefile({ "alpha", "beta", "gamma" }, path)
    vim.cmd("edit " .. vim.fn.fnameescape(path))
    vim.fn.setpos("'<", { 0, 1, 1, 0 })
    vim.fn.setpos("'>", { 0, 2, 1, 0 })

    local text = context.format_for_prompt()
    assert.is_truthy(string.find(text, "Current file: " .. path, 1, true))
    assert.is_nil(string.find(text, "Selection L1-2:", 1, true))

    local with_selection = context.format_for_prompt({ selection = context.selection_range() })
    assert.is_truthy(string.find(with_selection, "Selection L1-2:", 1, true))
    assert.is_truthy(string.find(with_selection, "alpha\nbeta", 1, true))

    vim.api.nvim_set_current_buf(prev_buf)
    vim.fn.delete(path)
  end)
end)
