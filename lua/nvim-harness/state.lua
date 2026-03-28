local M = {
  client = nil,
  layout_handle = nil,
  sessions = {},
  active_session_id = nil,
  transcript_lines = {},
  pending_context = {},
  pending_diff = nil,
  status = "disconnected",
  daemon_job = nil,
}

return M
