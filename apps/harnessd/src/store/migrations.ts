import type { Database } from "bun:sqlite";

const INITIAL_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_root TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT,
  state TEXT NOT NULL,
  request_json TEXT NOT NULL,
  resolution_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS diff_proposals (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT,
  path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  proposal_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
`;

export function runMigrations(db: Database): void {
  db.exec(INITIAL_SQL);
  const row = db.query("SELECT MAX(version) AS v FROM schema_migrations").get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? null;
  if (current === null || current < 1) {
    db.run("INSERT INTO schema_migrations (version) VALUES (1)");
  }
}
